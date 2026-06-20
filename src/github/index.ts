export { createGitHubClient, parseRepo } from "./client.js";
export type { GitHubClientOptions } from "./client.js";
export { GitHubError, NetworkError } from "./errors.js";
export { normalizeComment, normalizeIssue } from "./normalize.js";
export type {
  GitHubClient,
  IssueState,
  IssueStateReason,
  ListIssuesOptions,
  ListIssuesResult,
  NormalizedComment,
  NormalizedIssue,
  RateLimit,
  RepoInfo,
  RepoInput,
  RepoRef,
} from "./types.js";
