import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GitHubClient,
  ListIssuesOptions,
  ListIssuesResult,
  NormalizedComment,
  NormalizedIssue,
  RateLimit,
  RepoInput,
} from "../github/index.js";
import { openStore, type Repo, type Store } from "../store/index.js";
import { runSync } from "./sync.js";

const NOW = "2024-06-01T00:00:00.000Z";

function makeIssue(overrides: Partial<NormalizedIssue> & Pick<NormalizedIssue, "number">): NormalizedIssue {
  return {
    title: "Something is broken",
    state: "open",
    state_reason: null,
    author: "octocat",
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    closed_at: null,
    comment_count: 0,
    body: "the body",
    ...overrides,
  };
}

/**
 * A fake GitHub client driven by a queued list of results. Each `listIssues`
 * call shifts the next queued result. Records the options it was called with.
 */
function fakeClient(results: ListIssuesResult[]): GitHubClient & { calls: ListIssuesOptions[] } {
  const queue = [...results];
  const calls: ListIssuesOptions[] = [];
  return {
    calls,
    async listIssues(_repo: RepoInput, options?: ListIssuesOptions): Promise<ListIssuesResult> {
      calls.push(options ?? {});
      const next = queue.shift();
      if (!next) throw new Error("fakeClient: no queued result");
      return next;
    },
    async getComments(): Promise<NormalizedComment[]> {
      throw new Error("getComments should not be called during sync");
    },
    async getRepo() {
      throw new Error("getRepo should not be called during sync");
    },
    rateLimit: null as RateLimit | null,
  };
}

describe("runSync", () => {
  let store: Store;
  let repo: Repo;

  beforeEach(() => {
    store = openStore(":memory:");
    repo = store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
  });

  afterEach(() => {
    store.close();
  });

  function eventsFor(number: number): string[] {
    const issue = store.getIssue(repo.id, number);
    if (!issue) return [];
    const rows = store.db.prepare(`SELECT type FROM events WHERE issue_id = ? ORDER BY id`).all(issue.id) as {
      type: string;
    }[];
    return rows.map((r) => r.type);
  }

  it("stores a brand-new open issue and emits opened", async () => {
    const client = fakeClient([{ status: "ok", issues: [makeIssue({ number: 1 })], etag: 'W/"abc"' }]);

    const result = await runSync({ store, client, now: () => NOW }, [repo]);

    expect(store.getIssue(repo.id, 1)?.state).toBe("open");
    expect(eventsFor(1)).toEqual(["opened"]);
    expect(result.repos[0]).toMatchObject({ repo: "octo/demo", opened: 1, processed: 1, notModified: false });
  });

  it("stores a new-but-already-closed issue without an event", async () => {
    const issue = makeIssue({ number: 2, state: "closed", state_reason: "completed", closed_at: NOW });
    const client = fakeClient([{ status: "ok", issues: [issue], etag: null }]);

    await runSync({ store, client, now: () => NOW }, [repo]);

    expect(store.getIssue(repo.id, 2)?.state).toBe("closed");
    expect(eventsFor(2)).toEqual([]);
  });

  it("emits closed on open -> closed", async () => {
    const client = fakeClient([
      { status: "ok", issues: [makeIssue({ number: 3 })], etag: null },
      {
        status: "ok",
        issues: [makeIssue({ number: 3, state: "closed", updated_at: "2024-02-01T00:00:00Z" })],
        etag: null,
      },
    ]);

    await runSync({ store, client, now: () => NOW }, [repo]);
    const result = await runSync({ store, client, now: () => NOW }, [repo]);

    expect(eventsFor(3)).toEqual(["opened", "closed"]);
    expect(result.repos[0].closed).toBe(1);
  });

  it("emits reopened on closed -> open", async () => {
    const client = fakeClient([
      { status: "ok", issues: [makeIssue({ number: 4, state: "closed" })], etag: null },
      {
        status: "ok",
        issues: [makeIssue({ number: 4, state: "open", updated_at: "2024-02-01T00:00:00Z" })],
        etag: null,
      },
    ]);

    await runSync({ store, client, now: () => NOW }, [repo]);
    const result = await runSync({ store, client, now: () => NOW }, [repo]);

    // First sync: already-closed new issue, no event. Second: reopened.
    expect(eventsFor(4)).toEqual(["reopened"]);
    expect(result.repos[0].reopened).toBe(1);
  });

  it("emits commented when comment_count grows on an open issue", async () => {
    const client = fakeClient([
      { status: "ok", issues: [makeIssue({ number: 5, comment_count: 1 })], etag: null },
      {
        status: "ok",
        issues: [makeIssue({ number: 5, comment_count: 3, updated_at: "2024-02-01T00:00:00Z" })],
        etag: null,
      },
    ]);

    await runSync({ store, client, now: () => NOW }, [repo]);
    const result = await runSync({ store, client, now: () => NOW }, [repo]);

    expect(eventsFor(5)).toEqual(["opened", "commented"]);
    expect(result.repos[0].commented).toBe(1);
  });

  it("emits closed_commented when comments grow on a closed issue", async () => {
    const client = fakeClient([
      { status: "ok", issues: [makeIssue({ number: 6, comment_count: 1 })], etag: null },
      {
        status: "ok",
        issues: [makeIssue({ number: 6, state: "closed", comment_count: 2, updated_at: "2024-02-01T00:00:00Z" })],
        etag: null,
      },
    ]);

    await runSync({ store, client, now: () => NOW }, [repo]);
    await runSync({ store, client, now: () => NOW }, [repo]);

    // close + comment in one snapshot => both events.
    expect(eventsFor(6)).toEqual(["opened", "closed", "closed_commented"]);
  });

  it("marks a compacted issue stale when it changes", async () => {
    const client = fakeClient([
      { status: "ok", issues: [makeIssue({ number: 7 })], etag: null },
      {
        status: "ok",
        issues: [makeIssue({ number: 7, comment_count: 1, updated_at: "2024-02-01T00:00:00Z" })],
        etag: null,
      },
    ]);

    await runSync({ store, client, now: () => NOW }, [repo]);
    store.setCompact(repo.id, 7, { compact: "summary", tldr: "tldr" });
    expect(store.getIssue(repo.id, 7)?.compactStale).toBe(false);

    await runSync({ store, client, now: () => NOW }, [repo]);

    expect(store.getIssue(repo.id, 7)?.compactStale).toBe(true);
    // The compact itself is preserved across the sync.
    expect(store.getIssue(repo.id, 7)?.compact).toBe("summary");
  });

  it("does not mark stale when a compacted issue is unchanged", async () => {
    const same = makeIssue({ number: 8 });
    const client = fakeClient([
      { status: "ok", issues: [same], etag: null },
      { status: "ok", issues: [same], etag: null },
    ]);

    await runSync({ store, client, now: () => NOW }, [repo]);
    store.setCompact(repo.id, 8, { compact: "summary", tldr: "tldr" });

    await runSync({ store, client, now: () => NOW }, [repo]);

    expect(store.getIssue(repo.id, 8)?.compactStale).toBe(false);
  });

  it("treats notModified (304) as a no-op", async () => {
    const client = fakeClient([{ status: "notModified" }]);

    const result = await runSync({ store, client, now: () => NOW }, [repo]);

    expect(result.repos[0]).toMatchObject({ repo: "octo/demo", notModified: true, processed: 0 });
    expect(store.listIssues(repo.id)).toHaveLength(0);
    // last_synced_at left untouched on a 304.
    expect(store.getRepo(repo.id)?.lastSyncedAt).toBeNull();
  });

  it("updates last_synced_at and etag after a successful sync", async () => {
    const client = fakeClient([{ status: "ok", issues: [makeIssue({ number: 9 })], etag: 'W/"new-etag"' }]);

    await runSync({ store, client, now: () => NOW }, [repo]);

    const updated = store.getRepo(repo.id);
    expect(updated?.lastSyncedAt).toBe(NOW);
    expect(updated?.etag).toBe('W/"new-etag"');
  });

  it("passes since and etag from the repo into listIssues", async () => {
    store.updateRepoSync(repo.id, { lastSyncedAt: "2024-05-01T00:00:00Z", etag: 'W/"prev"' });
    const fresh = store.getRepo(repo.id)!;
    const client = fakeClient([{ status: "ok", issues: [], etag: null }]);

    await runSync({ store, client, now: () => NOW }, [fresh]);

    expect(client.calls[0]).toEqual({ since: "2024-05-01T00:00:00Z", etag: 'W/"prev"' });
  });

  it("persists labels as JSON and raw_body", async () => {
    const client = fakeClient([
      { status: "ok", issues: [makeIssue({ number: 10, labels: ["bug", "p1"], body: "raw md" })], etag: null },
    ]);

    await runSync({ store, client, now: () => NOW }, [repo]);

    const stored = store.getIssue(repo.id, 10);
    expect(stored?.labels).toBe(JSON.stringify(["bug", "p1"]));
    expect(stored?.rawBody).toBe("raw md");
  });

  it("extracts explicit references from an issue body on sync", async () => {
    const body = "Dup of #12, blocked by owner/repo#45, fixed in PR #99. This is #5 itself.";
    const client = fakeClient([{ status: "ok", issues: [makeIssue({ number: 5, body })], etag: null }]);

    await runSync({ store, client, now: () => NOW }, [repo]);

    const issue = store.getIssue(repo.id, 5);
    expect(issue).toBeDefined();
    const refs = store.listIssueRefs(issue!.id).map((r) => r.target);
    expect(refs).toEqual(["owner/repo#45", "#99", "#12"]);
    // The issue's own number (#5) is not stored as a self-reference.
    expect(refs).not.toContain("#5");
  });

  it("clears stale refs when a re-synced body drops a reference", async () => {
    const client = fakeClient([
      { status: "ok", issues: [makeIssue({ number: 5, body: "see #12 and #20" })], etag: null },
      {
        status: "ok",
        issues: [makeIssue({ number: 5, body: "only #20 now", updated_at: "2024-02-01T00:00:00Z" })],
        etag: null,
      },
    ]);

    await runSync({ store, client, now: () => NOW }, [repo]);
    await runSync({ store, client, now: () => NOW }, [repo]);

    const issue = store.getIssue(repo.id, 5);
    expect(store.listIssueRefs(issue!.id).map((r) => r.target)).toEqual(["#20"]);
  });

  it("syncs multiple repos and returns one result each", async () => {
    const repo2 = store.insertRepo({ owner: "octo", name: "two", fullName: "octo/two" });
    const client = fakeClient([
      { status: "ok", issues: [makeIssue({ number: 1 })], etag: null },
      { status: "notModified" },
    ]);

    const result = await runSync({ store, client, now: () => NOW }, [repo, repo2]);

    expect(result.repos.map((r) => r.repo)).toEqual(["octo/demo", "octo/two"]);
    expect(result.repos[1].notModified).toBe(true);
  });
});
