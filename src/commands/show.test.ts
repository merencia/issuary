import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubClient, NormalizedComment } from "../github/index.js";
import { openStore, type Store } from "../store/index.js";
import { formatShow, runShow, ShowCommandError } from "./show.js";

const SAMPLE_COMMENTS: NormalizedComment[] = [
  { id: 1, author: "octocat", created_at: "2024-01-02T00:00:00Z", updated_at: "2024-01-02T00:00:00Z", body: "first" },
  { id: 2, author: null, created_at: "2024-01-03T00:00:00Z", updated_at: "2024-01-03T00:00:00Z", body: "second" },
];

/** A fake GitHub client whose `getComments` is a spy. */
function fakeClient(comments: NormalizedComment[]): GitHubClient {
  return {
    listIssues: vi.fn(),
    getComments: vi.fn(async () => comments),
    getRepo: vi.fn(),
    rateLimit: null,
  };
}

describe("runShow", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-show-"));
    store = openStore(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedIssue(overrides: Partial<Parameters<Store["upsertIssue"]>[0]> = {}) {
    const repo = store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
    store.upsertIssue({
      repoId: repo.id,
      number: 7,
      title: "Scheduler bug",
      state: "open",
      author: "octocat",
      labels: JSON.stringify(["bug"]),
      commentCount: 2,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      rawBody: "the raw body",
      ...overrides,
    });
    return repo;
  }

  describe("target parsing", () => {
    it("rejects a malformed target", async () => {
      await expect(runShow(store, "not-a-target", {})).rejects.toThrow(/owner\/repo#number/);
    });
  });

  describe("default view", () => {
    it("shows the compact when present", async () => {
      seedIssue({ compact: "---\nstatus: open\n---\ntldr: hi", compactTldr: "hi" });

      const result = await runShow(store, "octo/demo#7", {});

      expect(result.compact).toBe("---\nstatus: open\n---\ntldr: hi");
      expect(result.rawBody).toBe("the raw body");
      expect(result.labels).toEqual(["bug"]);
      expect(result.comments).toBeUndefined();
    });

    it("falls back to raw_body when there is no compact", async () => {
      seedIssue();

      const result = await runShow(store, "octo/demo#7", {});

      expect(result.compact).toBeNull();
      expect(result.rawBody).toBe("the raw body");
    });

    it("errors when the repo is not watched", async () => {
      await expect(runShow(store, "ghost/repo#1", {})).rejects.toThrow(ShowCommandError);
      await expect(runShow(store, "ghost/repo#1", {})).rejects.toThrow(/not watched/);
    });

    it("errors when the issue is not in the local store", async () => {
      store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
      await expect(runShow(store, "octo/demo#7", {})).rejects.toThrow(/Run `lore sync` first/);
    });
  });

  describe("--raw", () => {
    it("fetches and caches comments when not cached", async () => {
      const repo = seedIssue();
      const client = fakeClient(SAMPLE_COMMENTS);

      const result = await runShow(store, "octo/demo#7", { raw: true }, client);

      expect(client.getComments).toHaveBeenCalledTimes(1);
      expect(client.getComments).toHaveBeenCalledWith("octo/demo", 7);
      expect(result.comments).toEqual(SAMPLE_COMMENTS);

      const cached = store.getIssue(repo.id, 7);
      expect(JSON.parse(cached?.rawComments ?? "null")).toEqual(SAMPLE_COMMENTS);
      expect(cached?.rawFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("uses the cache and does not refetch when comments are cached", async () => {
      seedIssue({ rawComments: JSON.stringify(SAMPLE_COMMENTS), rawFetchedAt: "2024-02-01T00:00:00Z" });
      const client = fakeClient([]);

      const result = await runShow(store, "octo/demo#7", { raw: true }, client);

      expect(client.getComments).not.toHaveBeenCalled();
      expect(result.comments).toEqual(SAMPLE_COMMENTS);
    });

    it("errors when --raw is requested without a client", async () => {
      seedIssue();
      await expect(runShow(store, "octo/demo#7", { raw: true })).rejects.toThrow(/client is required/);
    });
  });

  describe("json shape", () => {
    it("includes the expected fields and comments under --raw", async () => {
      seedIssue({ compact: "c", compactStale: true });
      const client = fakeClient(SAMPLE_COMMENTS);

      const result = await runShow(store, "octo/demo#7", { raw: true, json: true }, client);

      expect(result).toMatchObject({
        repo: "octo/demo",
        number: 7,
        title: "Scheduler bug",
        state: "open",
        stateReason: null,
        author: "octocat",
        labels: ["bug"],
        commentCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        closedAt: null,
        compact: "c",
        compactStale: true,
        rawBody: "the raw body",
        comments: SAMPLE_COMMENTS,
      });
    });
  });

  describe("references", () => {
    it("includes the issue's refs in the result", async () => {
      const repo = seedIssue();
      const issue = store.getIssue(repo.id, 7);
      store.replaceIssueRefs(issue!.id, ["#12", "owner/repo#45"]);

      const result = await runShow(store, "octo/demo#7", {});

      expect(result.refs).toEqual(["#12", "owner/repo#45"]);
    });

    it("returns an empty refs array when the issue has none", async () => {
      seedIssue();
      const result = await runShow(store, "octo/demo#7", {});
      expect(result.refs).toEqual([]);
    });

    it("renders a references line in human output", async () => {
      const repo = seedIssue();
      const issue = store.getIssue(repo.id, 7);
      store.replaceIssueRefs(issue!.id, ["#12", "owner/repo#45"]);

      const result = await runShow(store, "octo/demo#7", {});
      expect(formatShow(result, {})).toContain("references: #12, owner/repo#45");
    });

    it("renders (none) when there are no references", async () => {
      seedIssue();
      const result = await runShow(store, "octo/demo#7", {});
      expect(formatShow(result, {})).toContain("references: (none)");
    });
  });
});
