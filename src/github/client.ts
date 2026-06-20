import { GitHubError, NetworkError } from "./errors.js";
import { isPullRequest, normalizeComment, normalizeIssue, type RawComment, type RawIssue } from "./normalize.js";
import type {
  GitHubClient,
  ListIssuesOptions,
  ListIssuesResult,
  NormalizedComment,
  NormalizedIssue,
  RateLimit,
  RepoInfo,
  RepoInput,
  RepoRef,
} from "./types.js";

const API_VERSION = "2022-11-28";
const ACCEPT = "application/vnd.github+json";
const USER_AGENT = "merencia-issuary";
const PER_PAGE = 100;

/** Default number of automatic retries for rate-limit and network failures. */
const DEFAULT_MAX_RETRIES = 3;
/** Default cap on how long the client waits for a rate-limit window to reset. */
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 3 * 60 * 1000;
/** Base delay (ms) for the exponential backoff between network-error retries. */
const DEFAULT_NETWORK_BACKOFF_MS = 500;

/** Options for {@link createGitHubClient}. */
export interface GitHubClientOptions {
  /** GitHub token sent as `Authorization: Bearer {token}`. */
  token: string;
  /** REST API base URL, e.g. `https://api.github.com` (no trailing slash). */
  apiUrl: string;
  /** Optional `fetch` override; defaults to the global `fetch`. For tests. */
  fetch?: typeof fetch;
  /**
   * Sleep implementation used between retries. Defaults to a real timer.
   * Injected by tests so backoff never actually waits.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Clock returning epoch milliseconds; defaults to `Date.now`. For tests. */
  now?: () => number;
  /**
   * Maximum automatic retries for a single request on rate-limit (403/429) or
   * transient network failure. Defaults to {@link DEFAULT_MAX_RETRIES}.
   */
  maxRetries?: number;
  /**
   * Cap (ms) on how long to wait for a rate-limit reset before failing fast.
   * Defaults to {@link DEFAULT_MAX_RATE_LIMIT_WAIT_MS} (3 minutes).
   */
  maxRateLimitWaitMs?: number;
  /**
   * Base delay (ms) for exponential backoff between network-error retries.
   * Defaults to {@link DEFAULT_NETWORK_BACKOFF_MS}.
   */
  networkBackoffMs?: number;
}

/** Default sleep backed by a real timer. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Heuristic for a transient transport failure worth retrying: a thrown error
 * (not an HTTP response) whose code or message points at a reset connection,
 * a DNS hiccup, a timeout, or undici's generic `fetch failed`.
 */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"].includes(code)
    ) {
      return true;
    }
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("terminated")
  );
}

/** True when a response is a rate-limit rejection (403/429 with the tell-tale signals). */
function isRateLimitedResponse(response: Response, rateLimit: RateLimit | null): boolean {
  if (response.status !== 403 && response.status !== 429) {
    return false;
  }
  if (response.headers.has("retry-after")) {
    return true;
  }
  return rateLimit?.remaining === 0;
}

/**
 * Computes how long to wait (ms) before retrying a rate-limited response.
 * Prefers `Retry-After` (delta seconds), falling back to `x-ratelimit-reset`
 * (epoch seconds). Returns 0 when no hint is present.
 */
function rateLimitWaitMs(response: Response, rateLimit: RateLimit | null, nowMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  if (rateLimit?.reset != null && Number.isFinite(rateLimit.reset)) {
    return Math.max(0, rateLimit.reset * 1000 - nowMs);
  }
  return 0;
}

/**
 * Parses a {@link RepoInput} into a {@link RepoRef}.
 *
 * @throws {GitHubError} (status 0) when the `"owner/name"` string is malformed.
 */
export function parseRepo(repo: RepoInput): RepoRef {
  if (typeof repo !== "string") {
    return repo;
  }
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new GitHubError(`Invalid repo "${repo}", expected "owner/name".`, 0);
  }
  return { owner, name };
}

/** Parses the `rel="next"` URL out of a `Link` header, or null when absent. */
function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/** Reads `x-ratelimit-*` headers into a {@link RateLimit}. */
function parseRateLimit(headers: Headers): RateLimit {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  return {
    remaining: remaining === null ? null : Number(remaining),
    reset: reset === null ? null : Number(reset),
  };
}

/**
 * Creates a GitHub REST client backed by the global `fetch`.
 *
 * The client is stateless except for {@link GitHubClient.rateLimit}, which holds
 * the rate-limit headers seen on the most recent response.
 *
 * @param options - Token, API base URL, and optional `fetch` override.
 * @returns A {@link GitHubClient}.
 */
export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const { token, apiUrl } = options;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS;
  const networkBackoffMs = options.networkBackoffMs ?? DEFAULT_NETWORK_BACKOFF_MS;

  let rateLimit: RateLimit | null = null;

  function baseHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: ACCEPT,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
    };
  }

  /** Wraps a `Retry-After`/reset wait into a dated, fail-fast GitHubError. */
  function rateLimitFailFast(waitMs: number): never {
    const retryAt = new Date(now() + waitMs).toISOString();
    throw new GitHubError(
      `GitHub rate limit exceeded and the reset is ${Math.ceil(waitMs / 1000)}s away, ` +
        `beyond the ${Math.ceil(maxRateLimitWaitMs / 1000)}s wait cap. Retry after ${retryAt}.`,
      403,
      rateLimit,
    );
  }

  /** Throws a dated GitHubError when rate-limit retries are exhausted. */
  function rateLimitExhausted(waitMs: number): never {
    const retryAt = new Date(now() + waitMs).toISOString();
    throw new GitHubError(
      `GitHub rate limit exceeded after ${maxRetries} retries. Retry after ${retryAt}.`,
      403,
      rateLimit,
    );
  }

  /**
   * Performs a single request, retrying on rate-limit (403/429) and transient
   * network failures up to {@link maxRetries} times. Rate-limit retries honor
   * `Retry-After`/`x-ratelimit-reset` (capped); network retries use exponential
   * backoff. Both waits go through the injectable {@link sleep}.
   */
  async function request(url: string, headers: Record<string, string>): Promise<Response> {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await doFetch(url, { headers });
      } catch (error) {
        if (isTransientNetworkError(error) && attempt < maxRetries) {
          await sleep(networkBackoffMs * 2 ** attempt);
          attempt += 1;
          continue;
        }
        if (isTransientNetworkError(error)) {
          throw new NetworkError(
            `Network request to GitHub failed after ${attempt + 1} attempts: ${(error as Error).message}.`,
            error,
          );
        }
        throw error;
      }

      rateLimit = parseRateLimit(response.headers);

      if (isRateLimitedResponse(response, rateLimit)) {
        const waitMs = rateLimitWaitMs(response, rateLimit, now());
        if (waitMs > maxRateLimitWaitMs) {
          rateLimitFailFast(waitMs);
        }
        if (attempt < maxRetries) {
          await sleep(waitMs);
          attempt += 1;
          continue;
        }
        // Retries exhausted while still rate-limited: throw an explicit dated
        // error rather than falling through to the generic failure message.
        rateLimitExhausted(waitMs);
      }

      return response;
    }
  }

  /** Turns a non-ok, non-304 response into a thrown {@link GitHubError}. */
  async function fail(response: Response): Promise<never> {
    const { status } = response;
    const isRateLimited = (status === 403 || status === 429) && rateLimit?.remaining === 0;
    let message: string;
    if (isRateLimited) {
      message = "GitHub rate limit exceeded (x-ratelimit-remaining is 0).";
    } else if (status === 404) {
      // 404 is ambiguous: the repo may not exist, or the token may simply lack
      // access to a private repo (GitHub hides those behind a 404 on purpose).
      message = "GitHub returned 404: the repo was not found or your token has no access to it.";
    } else {
      const detail = await readErrorMessage(response);
      message = `GitHub request failed with ${status}${detail ? `: ${detail}` : ""}.`;
    }
    throw new GitHubError(message, status, rateLimit);
  }

  async function getRepo(repo: RepoInput): Promise<RepoInfo> {
    const { owner, name } = parseRepo(repo);
    const response = await request(`${apiUrl}/repos/${owner}/${name}`, baseHeaders());
    if (!response.ok) {
      await fail(response);
    }
    const body = (await response.json()) as {
      owner?: { login?: unknown };
      name?: unknown;
      full_name?: unknown;
      private?: unknown;
    };
    return {
      owner: typeof body.owner?.login === "string" ? body.owner.login : owner,
      name: typeof body.name === "string" ? body.name : name,
      fullName: typeof body.full_name === "string" ? body.full_name : `${owner}/${name}`,
      private: body.private === true,
    };
  }

  async function listIssues(repo: RepoInput, listOptions: ListIssuesOptions = {}): Promise<ListIssuesResult> {
    const { owner, name } = parseRepo(repo);
    const params = new URLSearchParams({
      state: "all",
      per_page: String(PER_PAGE),
      sort: "updated",
      direction: "asc",
    });
    if (listOptions.since) {
      params.set("since", listOptions.since);
    }

    let url: string | null = `${apiUrl}/repos/${owner}/${name}/issues?${params.toString()}`;
    const issues: NormalizedIssue[] = [];
    let etag: string | null = null;
    let first = true;

    while (url) {
      const headers = baseHeaders();
      // The conditional request only makes sense for the first page.
      if (first && listOptions.etag) {
        headers["If-None-Match"] = listOptions.etag;
      }

      const response: Response = await request(url, headers);

      if (first && response.status === 304) {
        return { status: "notModified" };
      }
      if (!response.ok) {
        await fail(response);
      }
      if (first) {
        etag = response.headers.get("etag");
        first = false;
      }

      const page = (await response.json()) as RawIssue[];
      for (const item of page) {
        if (!isPullRequest(item)) {
          issues.push(normalizeIssue(item));
        }
      }

      url = nextLink(response.headers.get("link"));
    }

    return { status: "ok", issues, etag };
  }

  async function getComments(repo: RepoInput, number: number): Promise<NormalizedComment[]> {
    const { owner, name } = parseRepo(repo);
    const params = new URLSearchParams({ per_page: String(PER_PAGE) });

    let url: string | null = `${apiUrl}/repos/${owner}/${name}/issues/${number}/comments?${params.toString()}`;
    const comments: NormalizedComment[] = [];

    while (url) {
      const response: Response = await request(url, baseHeaders());
      if (!response.ok) {
        await fail(response);
      }
      const page = (await response.json()) as RawComment[];
      for (const item of page) {
        comments.push(normalizeComment(item));
      }
      url = nextLink(response.headers.get("link"));
    }

    return comments;
  }

  return {
    getRepo,
    listIssues,
    getComments,
    get rateLimit(): RateLimit | null {
      return rateLimit;
    },
  };
}

/** Best-effort extraction of GitHub's JSON `message` field for error detail. */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : null;
  } catch {
    return null;
  }
}
