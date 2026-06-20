import type { GitHubClient, NormalizedIssue } from "../github/index.js";
import type { Issue, Repo, Store } from "../store/index.js";

/** Per-repo outcome of a sync run, suitable for both human and JSON output. */
export interface RepoSyncResult {
  /** The repo's `owner/name`. */
  repo: string;
  /** True when the listing returned 304 and nothing was processed. */
  notModified: boolean;
  /** Count of brand-new open issues (`opened` events emitted). */
  opened: number;
  /** Count of issues that transitioned open to closed. */
  closed: number;
  /** Count of issues that transitioned closed to open. */
  reopened: number;
  /** Count of issues that gained new comments (open or closed). */
  commented: number;
  /** Total issues processed from the listing (0 when notModified). */
  processed: number;
}

/** Aggregate result of a sync run across one or more repos. */
export interface SyncResult {
  /** Per-repo results, in the order repos were processed. */
  repos: RepoSyncResult[];
}

/** Dependencies the engine needs, injected for testability. */
export interface SyncDeps {
  /** The opened store handle. */
  store: Store;
  /** The GitHub client (real or fake). */
  client: GitHubClient;
  /** Clock override returning an ISO-8601 timestamp; defaults to `now`. */
  now?: () => string;
}

/** The event types emitted by the diff engine. */
type EventType = "opened" | "closed" | "reopened" | "commented" | "closed_commented";

/**
 * Serializes a normalized issue's labels into the JSON shape the store holds,
 * or null when there are none.
 */
function labelsJson(issue: NormalizedIssue): string | null {
  return issue.labels.length > 0 ? JSON.stringify(issue.labels) : null;
}

/**
 * Detects the change events for one incoming issue relative to its stored
 * counterpart. Returns the event types to emit. An empty array means no change
 * worth recording (including a brand-new issue that arrives already closed).
 */
function detectEvents(stored: Issue | undefined, incoming: NormalizedIssue): EventType[] {
  if (!stored) {
    // Brand-new issue. Only emit `opened` when it is actually open; an issue
    // that arrives already closed is stored silently (no historical event).
    return incoming.state === "open" ? ["opened"] : [];
  }

  const events: EventType[] = [];

  if (stored.state === "open" && incoming.state === "closed") {
    events.push("closed");
  } else if (stored.state === "closed" && incoming.state === "open") {
    events.push("reopened");
  }

  if (incoming.comment_count > stored.commentCount) {
    events.push(incoming.state === "closed" ? "closed_commented" : "commented");
  }

  return events;
}

/**
 * Returns true when an existing issue's tracked fields changed in a way that
 * should mark its compact stale (state, comment count, or update timestamp).
 */
function hasMeaningfulChange(stored: Issue, incoming: NormalizedIssue): boolean {
  return (
    stored.state !== incoming.state ||
    stored.commentCount !== incoming.comment_count ||
    stored.updatedAt !== incoming.updated_at
  );
}

/**
 * Syncs a single repo: lists its issues conditionally, diffs each against the
 * local mirror, upserts metadata and raw bodies, records events, marks compacts
 * stale on change, and updates the repo's sync bookkeeping. All writes for the
 * repo run in one transaction. Comments are never fetched here.
 */
async function syncRepo(store: Store, client: GitHubClient, repo: Repo, now: () => string): Promise<RepoSyncResult> {
  const result = await client.listIssues(repo.fullName, {
    since: repo.lastSyncedAt ?? undefined,
    etag: repo.etag ?? undefined,
  });

  const base: RepoSyncResult = {
    repo: repo.fullName,
    notModified: false,
    opened: 0,
    closed: 0,
    reopened: 0,
    commented: 0,
    processed: 0,
  };

  if (result.status === "notModified") {
    // 304: nothing changed. Do not touch anything and do not spend further
    // calls. We intentionally leave last_synced_at as-is.
    return { ...base, notModified: true };
  }

  const detectedAt = now();
  const apply = store.db.transaction((): RepoSyncResult => {
    const summary = { ...base };
    for (const incoming of result.issues) {
      const stored = store.getIssue(repo.id, incoming.number);
      const events = detectEvents(stored, incoming);

      const upserted = store.upsertIssue({
        repoId: repo.id,
        number: incoming.number,
        title: incoming.title,
        state: incoming.state,
        stateReason: incoming.state_reason,
        author: incoming.author,
        labels: labelsJson(incoming),
        createdAt: incoming.created_at,
        updatedAt: incoming.updated_at,
        closedAt: incoming.closed_at,
        commentCount: incoming.comment_count,
        rawBody: incoming.body,
        // Preserve raw comments and compact across syncs: upsert overwrites
        // every column, so carry the stored values forward explicitly.
        rawComments: stored?.rawComments ?? null,
        rawFetchedAt: stored?.rawFetchedAt ?? null,
        compact: stored?.compact ?? null,
        compactTldr: stored?.compactTldr ?? null,
        compactStale: stored?.compactStale ?? false,
        compactedAt: stored?.compactedAt ?? null,
      });

      for (const type of events) {
        store.insertEvent(upserted.id, type, detectedAt);
        if (type === "opened") summary.opened += 1;
        else if (type === "closed") summary.closed += 1;
        else if (type === "reopened") summary.reopened += 1;
        else summary.commented += 1;
      }

      // Mark an existing, already-compacted issue stale when it changed.
      if (stored && stored.compact !== null && hasMeaningfulChange(stored, incoming)) {
        store.setCompactStale(upserted.id, true);
      }

      summary.processed += 1;
    }

    store.updateRepoSync(repo.id, { lastSyncedAt: detectedAt, etag: result.etag });
    return summary;
  });

  return apply();
}

/**
 * Runs the sync engine over the given repos in sequence, returning a structured
 * summary. Each repo is synced independently in its own transaction.
 *
 * @param deps - Injected store, GitHub client, and optional clock.
 * @param repos - The repos to sync (typically the active set, or a single repo).
 * @returns The aggregate {@link SyncResult}.
 */
export async function runSync(deps: SyncDeps, repos: Repo[]): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const results: RepoSyncResult[] = [];
  for (const repo of repos) {
    results.push(await syncRepo(deps.store, deps.client, repo, now));
  }
  return { repos: results };
}
