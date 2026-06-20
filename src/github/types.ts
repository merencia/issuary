/**
 * A repository reference accepted by the GitHub client.
 *
 * Either the `"owner/name"` shorthand or an explicit object. The client parses
 * both into a single internal {@link RepoRef} shape.
 */
export type RepoInput = string | RepoRef;

/** A parsed repository reference. */
export interface RepoRef {
  /** Repository owner (user or organization). */
  owner: string;
  /** Repository name. */
  name: string;
}

/** Issue state as reported by the GitHub API. */
export type IssueState = "open" | "closed";

/** Reason an issue was closed (from the GitHub API), or null when open. */
export type IssueStateReason = "completed" | "not_planned" | null;

/**
 * A GitHub issue mapped to the lean shape lore stores and renders.
 *
 * Pull requests are filtered out upstream, so this only ever represents a real
 * issue. `state_reason` and `labels` are copied verbatim from the API and never
 * interpreted.
 */
export interface NormalizedIssue {
  /** Issue number, unique within the repo. */
  number: number;
  /** Issue title. */
  title: string;
  /** `open` or `closed`. */
  state: IssueState;
  /** Why the issue was closed, or null. */
  state_reason: IssueStateReason;
  /** Author login, or null when the user was deleted. */
  author: string | null;
  /** Label names attached to the issue. */
  labels: string[];
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 timestamp of the last update. */
  updated_at: string;
  /** ISO-8601 timestamp of when the issue was closed, or null. */
  closed_at: string | null;
  /** Number of comments on the issue. */
  comment_count: number;
  /** Raw issue body markdown, or null when empty. */
  body: string | null;
}

/**
 * A GitHub issue comment mapped to the lean shape lore stores.
 */
export interface NormalizedComment {
  /** Comment id, unique across the repo. */
  id: number;
  /** Author login, or null when the user was deleted. */
  author: string | null;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 timestamp of the last update. */
  updated_at: string;
  /** Comment body markdown, or null when empty. */
  body: string | null;
}

/**
 * Rate-limit state parsed from `x-ratelimit-*` response headers.
 *
 * A later sync uses this to back off before exhausting the budget.
 */
export interface RateLimit {
  /** Remaining requests in the current window, or null when unknown. */
  remaining: number | null;
  /** Unix epoch seconds when the window resets, or null when unknown. */
  reset: number | null;
}

/**
 * Result of {@link GitHubClient.listIssues}.
 *
 * `notModified` is returned for a 304 (the etag still matches), so callers can
 * skip work without spending rate limit.
 */
export type ListIssuesResult =
  | { status: "ok"; issues: NormalizedIssue[]; etag: string | null }
  | { status: "notModified" };

/** Options for {@link GitHubClient.listIssues}. */
export interface ListIssuesOptions {
  /** Only return issues updated at or after this ISO-8601 timestamp. */
  since?: string;
  /** ETag from a previous list response, sent as `If-None-Match`. */
  etag?: string;
}

/**
 * The GitHub REST client lore uses for sync and show.
 *
 * Built by {@link createGitHubClient}. Holds no mutable per-request state other
 * than the most recently observed {@link RateLimit}.
 */
export interface GitHubClient {
  /**
   * Lists all issues (pull requests excluded) for a repo, following pagination.
   *
   * @param repo - `"owner/name"` or a {@link RepoRef}.
   * @param options - Conditional-request and filtering options.
   * @returns `{ status: "ok", ... }` for 200, `{ status: "notModified" }` for 304.
   */
  listIssues(repo: RepoInput, options?: ListIssuesOptions): Promise<ListIssuesResult>;
  /**
   * Fetches all comments for one issue, following pagination. On-demand only.
   *
   * @param repo - `"owner/name"` or a {@link RepoRef}.
   * @param number - Issue number.
   */
  getComments(repo: RepoInput, number: number): Promise<NormalizedComment[]>;
  /** The most recent rate-limit state, or null before any request. */
  readonly rateLimit: RateLimit | null;
}
