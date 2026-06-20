import type { RateLimit } from "./types.js";

/**
 * Error thrown for a non-2xx, non-304 GitHub response (401, 403, 404, 422, ...).
 *
 * Carries the HTTP `status` and the parsed {@link RateLimit} so callers can
 * distinguish auth failures from a rate-limit 403 and back off accordingly.
 */
export class GitHubError extends Error {
  /** HTTP status code of the failing response. */
  readonly status: number;
  /** Rate-limit state at the time of the failure, when available. */
  readonly rateLimit: RateLimit | null;

  constructor(message: string, status: number, rateLimit: RateLimit | null = null) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.rateLimit = rateLimit;
  }
}

/**
 * Error thrown when a `fetch` to GitHub keeps failing at the transport level
 * (DNS, connection reset, `fetch failed`) after the client's bounded retries are
 * exhausted. Distinct from {@link GitHubError}, which carries an HTTP status.
 *
 * Callers should catch this to print a friendly message instead of a raw stack.
 */
export class NetworkError extends Error {
  /** The last underlying transport error that triggered the failure, if any. */
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}
