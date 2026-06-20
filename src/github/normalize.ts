import type { IssueState, IssueStateReason, NormalizedComment, NormalizedIssue } from "./types.js";

/** Shape of a user object as returned by the GitHub API (only what we read). */
interface RawUser {
  login?: unknown;
}

/** Shape of a label object as returned by the GitHub API (only what we read). */
interface RawLabel {
  name?: unknown;
}

/** Shape of an issue object as returned by the GitHub API (only what we read). */
export interface RawIssue {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  state_reason?: unknown;
  user?: RawUser | null;
  labels?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  closed_at?: unknown;
  comments?: unknown;
  body?: unknown;
  /** Present only on pull requests; used to filter them out. */
  pull_request?: unknown;
}

/** Shape of a comment object as returned by the GitHub API (only what we read). */
export interface RawComment {
  id?: unknown;
  user?: RawUser | null;
  created_at?: unknown;
  updated_at?: unknown;
  body?: unknown;
}

/** Returns true when the payload item is a pull request, not a real issue. */
export function isPullRequest(item: RawIssue): boolean {
  return item.pull_request != null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function authorOf(user: RawUser | null | undefined): string | null {
  return asStringOrNull(user?.login);
}

function stateOf(value: unknown): IssueState {
  return value === "closed" ? "closed" : "open";
}

function stateReasonOf(value: unknown): IssueStateReason {
  return value === "completed" || value === "not_planned" ? value : null;
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const label of value as RawLabel[]) {
    const name = asStringOrNull(label?.name);
    if (name !== null) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Maps a raw GitHub issue payload to the lean {@link NormalizedIssue} shape.
 *
 * `state_reason` and `labels` are copied verbatim, never interpreted.
 */
export function normalizeIssue(raw: RawIssue): NormalizedIssue {
  return {
    number: asNumber(raw.number),
    title: asString(raw.title),
    state: stateOf(raw.state),
    state_reason: stateReasonOf(raw.state_reason),
    author: authorOf(raw.user),
    labels: labelsOf(raw.labels),
    created_at: asString(raw.created_at),
    updated_at: asString(raw.updated_at),
    closed_at: asStringOrNull(raw.closed_at),
    comment_count: asNumber(raw.comments),
    body: asStringOrNull(raw.body),
  };
}

/**
 * Maps a raw GitHub comment payload to the lean {@link NormalizedComment} shape.
 */
export function normalizeComment(raw: RawComment): NormalizedComment {
  return {
    id: asNumber(raw.id),
    author: authorOf(raw.user),
    created_at: asString(raw.created_at),
    updated_at: asString(raw.updated_at),
    body: asStringOrNull(raw.body),
  };
}
