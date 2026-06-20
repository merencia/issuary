import { GitHubError } from "./errors.js";
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
const USER_AGENT = "merencia-lore";
const PER_PAGE = 100;

/** Options for {@link createGitHubClient}. */
export interface GitHubClientOptions {
  /** GitHub token sent as `Authorization: Bearer {token}`. */
  token: string;
  /** REST API base URL, e.g. `https://api.github.com` (no trailing slash). */
  apiUrl: string;
  /** Optional `fetch` override; defaults to the global `fetch`. For tests. */
  fetch?: typeof fetch;
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

  let rateLimit: RateLimit | null = null;

  function baseHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: ACCEPT,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
    };
  }

  async function request(url: string, headers: Record<string, string>): Promise<Response> {
    const response = await doFetch(url, { headers });
    rateLimit = parseRateLimit(response.headers);
    return response;
  }

  /** Turns a non-ok, non-304 response into a thrown {@link GitHubError}. */
  async function fail(response: Response): Promise<never> {
    const { status } = response;
    const isRateLimited = status === 403 && rateLimit?.remaining === 0;
    let message: string;
    if (isRateLimited) {
      message = "GitHub rate limit exceeded (x-ratelimit-remaining is 0).";
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
