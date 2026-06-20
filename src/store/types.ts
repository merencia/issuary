/**
 * A repository being watched by issuary.
 */
export interface Repo {
  id: number;
  owner: string;
  name: string;
  /** `owner/name`, unique across the store. */
  fullName: string;
  /** ISO-8601 timestamp of when the repo was added. */
  addedAt: string;
  /** Whether the repo is included in syncs. */
  active: boolean;
  /** ISO-8601 timestamp of the last successful sync, or null if never synced. */
  lastSyncedAt: string | null;
  /** HTTP ETag from the last list response, for conditional requests. */
  etag: string | null;
}

/**
 * A GitHub issue mirrored locally, including raw and compacted forms.
 */
export interface Issue {
  id: number;
  repoId: number;
  number: number;
  title: string;
  /** `open` or `closed`. */
  state: string;
  /** `completed`, `not_planned`, or null (from the GitHub API). */
  stateReason: string | null;
  author: string | null;
  /** JSON-encoded array of label names, or null. */
  labels: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  commentCount: number;
  /** Raw issue body markdown. */
  rawBody: string | null;
  /** JSON-encoded array of raw comments, fetched on demand. */
  rawComments: string | null;
  /** ISO-8601 timestamp of when raw content was last fetched. */
  rawFetchedAt: string | null;
  /** Compacted summary in the canonical format, or null if not yet compacted. */
  compact: string | null;
  /** The tldr line extracted from the compact, or null. */
  compactTldr: string | null;
  /** Whether the compact is out of date relative to the raw content. */
  compactStale: boolean;
  /** ISO-8601 timestamp of when the compact was produced, or null. */
  compactedAt: string | null;
}

/**
 * An issue augmented with its owning repo's `full_name`, as returned by
 * {@link Store.queryIssues}. Kept separate from {@link Issue} so the base type is
 * not polluted with join-only columns.
 */
export interface IssueWithRepo extends Issue {
  /** The owning repo's `owner/name`. */
  repoFullName: string;
}

/**
 * A change detected on an issue since the last sync.
 */
export interface IssueEvent {
  id: number;
  issueId: number;
  /** `opened`, `closed`, `reopened`, `commented`, or `closed_commented`. */
  type: string;
  /** ISO-8601 timestamp of when the change was detected. */
  detectedAt: string;
  /** Whether the event has been surfaced to the user. */
  seen: boolean;
}

/**
 * An issue event joined with the context a reader needs to act on it: the
 * issue's identity (number, title, state) and the owning repo's `full_name`.
 * Produced by {@link Store.listEvents} for the aggregated digest inbox.
 */
export interface EventWithContext {
  /** The event's id. */
  id: number;
  /** The issue the event belongs to. */
  issueId: number;
  /** One of `opened`, `closed`, `reopened`, `commented`, `closed_commented`. */
  type: string;
  /** ISO-8601 timestamp of when the change was detected. */
  detectedAt: string;
  /** Whether the event has been surfaced to the user. */
  seen: boolean;
  /** The owning repo's id. */
  repoId: number;
  /** The owning repo's `owner/name`. */
  repoFullName: string;
  /** The issue's number within its repo. */
  issueNumber: number;
  /** The issue's title. */
  issueTitle: string;
  /** The issue's state: `open` or `closed`. */
  issueState: string;
}

/**
 * A cross-reference parsed out of an issue (e.g. `#812`, `owner/repo#45`).
 */
export interface IssueRef {
  id: number;
  issueId: number;
  /** The literal reference target. */
  target: string;
}

/**
 * Fields required to register a new repo. `id`, `addedAt`, `active`,
 * `lastSyncedAt`, and `etag` are managed by the store.
 */
export interface NewRepo {
  owner: string;
  name: string;
  fullName: string;
}

/**
 * Fields used to upsert an issue, keyed by `(repoId, number)`. Optional fields
 * default to null / 0 / false when omitted on insert.
 */
export interface UpsertIssue {
  repoId: number;
  number: number;
  title: string;
  state: string;
  stateReason?: string | null;
  author?: string | null;
  labels?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  commentCount?: number;
  rawBody?: string | null;
  rawComments?: string | null;
  rawFetchedAt?: string | null;
  compact?: string | null;
  compactTldr?: string | null;
  compactStale?: boolean;
  compactedAt?: string | null;
}
