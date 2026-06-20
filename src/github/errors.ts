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
