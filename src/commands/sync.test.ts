import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GitHubClient,
  ListIssuesOptions,
  ListIssuesResult,
  NormalizedComment,
  NormalizedIssue,
  RepoInput,
} from "../github/index.js";
import { openStore, type Store } from "../store/index.js";
import { formatSyncResult, runSyncCommand, SyncCommandError } from "./sync.js";

function makeIssue(number: number, overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    number,
    title: "t",
    state: "open",
    state_reason: null,
    author: "octocat",
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    closed_at: null,
    comment_count: 0,
    body: null,
    ...overrides,
  };
}

function fakeClient(byRepo: Record<string, ListIssuesResult>): GitHubClient {
  return {
    async listIssues(repo: RepoInput, _options?: ListIssuesOptions): Promise<ListIssuesResult> {
      const key = typeof repo === "string" ? repo : `${repo.owner}/${repo.name}`;
      return byRepo[key] ?? { status: "ok", issues: [], etag: null };
    },
    async getComments(): Promise<NormalizedComment[]> {
      throw new Error("not used");
    },
    getRepo: vi.fn(),
    rateLimit: null,
  };
}

describe("runSyncCommand", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("syncs all active repos by default", async () => {
    store.insertRepo({ owner: "a", name: "x", fullName: "a/x" });
    store.insertRepo({ owner: "b", name: "y", fullName: "b/y" });
    const client = fakeClient({
      "a/x": { status: "ok", issues: [makeIssue(1)], etag: null },
      "b/y": { status: "notModified" },
    });

    const result = await runSyncCommand(store, client, undefined);

    expect(result.repos.map((r) => r.repo).sort()).toEqual(["a/x", "b/y"]);
  });

  it("syncs only the named repo", async () => {
    store.insertRepo({ owner: "a", name: "x", fullName: "a/x" });
    store.insertRepo({ owner: "b", name: "y", fullName: "b/y" });
    const client = fakeClient({ "a/x": { status: "ok", issues: [makeIssue(1)], etag: null } });

    const result = await runSyncCommand(store, client, "a/x");

    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].repo).toBe("a/x");
  });

  it("throws when the named repo is not watched", async () => {
    const client = fakeClient({});
    await expect(runSyncCommand(store, client, "ghost/repo")).rejects.toBeInstanceOf(SyncCommandError);
  });

  it("throws when no active repos exist", async () => {
    const client = fakeClient({});
    await expect(runSyncCommand(store, client, undefined)).rejects.toBeInstanceOf(SyncCommandError);
  });

  it("isolates a failing repo: others still sync, failure reported, bookkeeping untouched", async () => {
    store.insertRepo({ owner: "good", name: "x", fullName: "good/x" });
    const bad = store.insertRepo({ owner: "bad", name: "y", fullName: "bad/y" });

    const client: GitHubClient = {
      async listIssues(repo: RepoInput): Promise<ListIssuesResult> {
        const key = typeof repo === "string" ? repo : `${repo.owner}/${repo.name}`;
        if (key === "bad/y") {
          throw new Error("GitHub returned 404: the repo was not found or your token has no access to it.");
        }
        return { status: "ok", issues: [makeIssue(1)], etag: 'W/"good-etag"' };
      },
      async getComments(): Promise<NormalizedComment[]> {
        throw new Error("not used");
      },
      getRepo: vi.fn(),
      rateLimit: null,
    };

    const result = await runSyncCommand(store, client, undefined);

    const good = result.repos.find((r) => r.repo === "good/x");
    const badResult = result.repos.find((r) => r.repo === "bad/y");

    // The healthy repo still processed.
    expect(good?.error).toBeNull();
    expect(good?.opened).toBe(1);

    // The failing repo is reported, not thrown.
    expect(badResult?.error).toContain("404");

    // The failing repo's etag / last_synced_at never advanced.
    const stored = store.getRepoByFullName("bad/y");
    expect(stored?.etag).toBeNull();
    expect(stored?.lastSyncedAt).toBeNull();
    expect(bad.etag).toBeNull();

    // The healthy repo's bookkeeping did advance.
    const storedGood = store.getRepoByFullName("good/x");
    expect(storedGood?.etag).toBe('W/"good-etag"');
    expect(storedGood?.lastSyncedAt).not.toBeNull();
  });
});

describe("formatSyncResult", () => {
  it("groups counts per repo", () => {
    const text = formatSyncResult({
      repos: [
        { repo: "a/x", notModified: false, opened: 2, closed: 1, reopened: 0, commented: 3, processed: 6, error: null },
        { repo: "b/y", notModified: true, opened: 0, closed: 0, reopened: 0, commented: 0, processed: 0, error: null },
        { repo: "c/z", notModified: false, opened: 0, closed: 0, reopened: 0, commented: 0, processed: 4, error: null },
      ],
    });

    expect(text).toBe(["a/x: 2 new, 1 closed, 3 new comments", "b/y: unchanged", "c/z: no changes"].join("\n"));
  });

  it("surfaces a failed repo with its error message", () => {
    const text = formatSyncResult({
      repos: [
        { repo: "a/x", notModified: false, opened: 1, closed: 0, reopened: 0, commented: 0, processed: 1, error: null },
        {
          repo: "b/y",
          notModified: false,
          opened: 0,
          closed: 0,
          reopened: 0,
          commented: 0,
          processed: 0,
          error: "GitHub returned 404: the repo was not found or your token has no access to it.",
        },
      ],
    });

    expect(text).toBe(
      [
        "a/x: 1 new",
        "b/y: failed (GitHub returned 404: the repo was not found or your token has no access to it.)",
      ].join("\n"),
    );
  });
});
