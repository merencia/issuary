import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./migrations.js";
import { defaultDbPath, openStore, type Store } from "./store.js";
import type { UpsertIssue } from "./types.js";

function makeIssue(overrides: Partial<UpsertIssue> & Pick<UpsertIssue, "repoId">): UpsertIssue {
  return {
    number: 1,
    title: "Something is broken",
    state: "open",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("openStore", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("migrations", () => {
    it("creates exactly the expected tables", () => {
      const rows = store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
        name: string;
      }[];
      const names = rows.map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(["repos", "issues", "events", "refs"]));
    });

    it("sets user_version to the schema version", () => {
      expect(store.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    });

    it("enables foreign keys and WAL", () => {
      expect(store.db.pragma("foreign_keys", { simple: true })).toBe(1);
      // :memory: databases report "memory" for journal_mode regardless of request.
      expect(store.db.pragma("journal_mode", { simple: true })).toBe("memory");
    });

    it("is idempotent when re-opened", () => {
      const dir = mkdtempSync(join(tmpdir(), "lore-test-"));
      const path = join(dir, "db.sqlite");
      try {
        const a = openStore(path);
        a.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
        a.close();

        const b = openStore(path);
        expect(b.listRepos()).toHaveLength(1);
        expect(b.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
        b.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("repos", () => {
    it("inserts and reads back a repo", () => {
      const repo = store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
      expect(repo.id).toBeGreaterThan(0);
      expect(repo.fullName).toBe("octo/demo");
      expect(repo.active).toBe(true);
      expect(repo.lastSyncedAt).toBeNull();
      expect(repo.etag).toBeNull();
      expect(repo.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      expect(store.getRepo(repo.id)).toEqual(repo);
      expect(store.getRepoByFullName("octo/demo")).toEqual(repo);
    });

    it("returns undefined for missing repos", () => {
      expect(store.getRepo(999)).toBeUndefined();
      expect(store.getRepoByFullName("nope/nope")).toBeUndefined();
    });

    it("enforces unique full_name", () => {
      store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
      expect(() => store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" })).toThrow();
    });

    it("lists repos and filters by active", () => {
      const a = store.insertRepo({ owner: "octo", name: "a", fullName: "octo/a" });
      store.insertRepo({ owner: "octo", name: "b", fullName: "octo/b" });
      store.db.prepare(`UPDATE repos SET active = 0 WHERE id = ?`).run(a.id);

      expect(store.listRepos()).toHaveLength(2);
      const active = store.listRepos({ activeOnly: true });
      expect(active).toHaveLength(1);
      expect(active[0].fullName).toBe("octo/b");
    });

    describe("setRepoActive", () => {
      it("deactivates and reactivates a repo without deleting it", () => {
        store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });

        const deactivated = store.setRepoActive("octo/demo", false);
        expect(deactivated?.active).toBe(false);
        expect(store.getRepoByFullName("octo/demo")?.active).toBe(false);
        expect(store.listRepos()).toHaveLength(1);

        const reactivated = store.setRepoActive("octo/demo", true);
        expect(reactivated?.active).toBe(true);
        expect(store.getRepoByFullName("octo/demo")?.active).toBe(true);
      });

      it("returns undefined when no repo matches", () => {
        expect(store.setRepoActive("ghost/repo", false)).toBeUndefined();
      });
    });
  });

  describe("issues", () => {
    let repoId: number;

    beforeEach(() => {
      repoId = store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" }).id;
    });

    it("inserts an issue with defaulted optional fields", () => {
      const issue = store.upsertIssue(makeIssue({ repoId, number: 7 }));
      expect(issue.id).toBeGreaterThan(0);
      expect(issue.number).toBe(7);
      expect(issue.commentCount).toBe(0);
      expect(issue.compactStale).toBe(false);
      expect(issue.stateReason).toBeNull();
      expect(issue.labels).toBeNull();
    });

    it("round-trips all provided fields including JSON columns and booleans", () => {
      const issue = store.upsertIssue(
        makeIssue({
          repoId,
          number: 12,
          stateReason: "completed",
          state: "closed",
          author: "octocat",
          labels: JSON.stringify(["bug", "timezone"]),
          closedAt: "2024-02-01T00:00:00Z",
          commentCount: 3,
          rawBody: "the body",
          rawComments: JSON.stringify([{ body: "hi" }]),
          rawFetchedAt: "2024-02-02T00:00:00Z",
          compact: "tldr: x",
          compactTldr: "x",
          compactStale: true,
          compactedAt: "2024-02-03T00:00:00Z",
        }),
      );
      expect(JSON.parse(issue.labels ?? "[]")).toEqual(["bug", "timezone"]);
      expect(JSON.parse(issue.rawComments ?? "[]")).toEqual([{ body: "hi" }]);
      expect(issue.compactStale).toBe(true);
      expect(issue.commentCount).toBe(3);
      expect(issue.stateReason).toBe("completed");
    });

    it("is idempotent on (repoId, number): upsert updates instead of duplicating", () => {
      const first = store.upsertIssue(makeIssue({ repoId, number: 5, title: "v1" }));
      const second = store.upsertIssue(makeIssue({ repoId, number: 5, title: "v2", commentCount: 9 }));

      expect(second.id).toBe(first.id);
      expect(second.title).toBe("v2");
      expect(second.commentCount).toBe(9);
      expect(store.listIssues(repoId)).toHaveLength(1);
    });

    it("same number in different repos are distinct", () => {
      const other = store.insertRepo({ owner: "octo", name: "two", fullName: "octo/two" });
      store.upsertIssue(makeIssue({ repoId, number: 1 }));
      store.upsertIssue(makeIssue({ repoId: other.id, number: 1 }));

      expect(store.listIssues(repoId)).toHaveLength(1);
      expect(store.listIssues(other.id)).toHaveLength(1);
    });

    it("gets an issue by repo and number", () => {
      const created = store.upsertIssue(makeIssue({ repoId, number: 42 }));
      expect(store.getIssue(repoId, 42)).toEqual(created);
      expect(store.getIssue(repoId, 999)).toBeUndefined();
    });

    it("lists issues ordered by number", () => {
      store.upsertIssue(makeIssue({ repoId, number: 3 }));
      store.upsertIssue(makeIssue({ repoId, number: 1 }));
      store.upsertIssue(makeIssue({ repoId, number: 2 }));
      expect(store.listIssues(repoId).map((i) => i.number)).toEqual([1, 2, 3]);
    });

    it("enforces the foreign key to repos", () => {
      expect(() => store.upsertIssue(makeIssue({ repoId: 9999, number: 1 }))).toThrow(/FOREIGN KEY/i);
    });

    describe("setCompact", () => {
      it("sets compact and tldr, clears stale, and stamps compacted_at", () => {
        store.upsertIssue(makeIssue({ repoId, number: 7, compactStale: true }));

        const updated = store.setCompact(repoId, 7, { compact: "---\nstatus: open\n---\ntldr: hi", tldr: "hi" });

        expect(updated).toBeDefined();
        expect(updated?.compact).toBe("---\nstatus: open\n---\ntldr: hi");
        expect(updated?.compactTldr).toBe("hi");
        expect(updated?.compactStale).toBe(false);
        expect(updated?.compactedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const reread = store.getIssue(repoId, 7);
        expect(reread?.compactStale).toBe(false);
        expect(reread?.compactTldr).toBe("hi");
      });

      it("returns undefined for an unknown issue", () => {
        expect(store.setCompact(repoId, 999, { compact: "x", tldr: "y" })).toBeUndefined();
      });
    });

    describe("setIssueRawComments", () => {
      it("caches raw comments and stamps raw_fetched_at", () => {
        store.upsertIssue(makeIssue({ repoId, number: 7 }));
        const commentsJson = JSON.stringify([{ id: 1, author: "octocat", body: "hi" }]);

        const updated = store.setIssueRawComments(repoId, 7, commentsJson, "2024-03-01T00:00:00Z");

        expect(updated).toBeDefined();
        expect(updated?.rawComments).toBe(commentsJson);
        expect(updated?.rawFetchedAt).toBe("2024-03-01T00:00:00Z");

        const reread = store.getIssue(repoId, 7);
        expect(reread?.rawComments).toBe(commentsJson);
        expect(reread?.rawFetchedAt).toBe("2024-03-01T00:00:00Z");
      });

      it("returns undefined for an unknown issue", () => {
        expect(store.setIssueRawComments(repoId, 999, "[]", "2024-03-01T00:00:00Z")).toBeUndefined();
      });
    });
  });

  describe("events and refs foreign keys", () => {
    it("rejects events for a non-existent issue", () => {
      expect(() =>
        store.db
          .prepare(`INSERT INTO events (issue_id, type, detected_at) VALUES (?, ?, ?)`)
          .run(123, "opened", "2024-01-01T00:00:00Z"),
      ).toThrow(/FOREIGN KEY/i);
    });

    it("rejects refs for a non-existent issue", () => {
      expect(() => store.db.prepare(`INSERT INTO refs (issue_id, target) VALUES (?, ?)`).run(123, "#1")).toThrow(
        /FOREIGN KEY/i,
      );
    });
  });

  describe("sync helpers", () => {
    let repoId: number;
    let issueId: number;

    beforeEach(() => {
      repoId = store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" }).id;
      issueId = store.upsertIssue(makeIssue({ repoId, number: 1 })).id;
    });

    describe("insertEvent", () => {
      it("records an event with the given type and timestamp", () => {
        const event = store.insertEvent(issueId, "opened", "2024-03-01T00:00:00Z");
        expect(event.id).toBeGreaterThan(0);
        expect(event.issueId).toBe(issueId);
        expect(event.type).toBe("opened");
        expect(event.detectedAt).toBe("2024-03-01T00:00:00Z");
        expect(event.seen).toBe(false);

        const rows = store.db.prepare(`SELECT type FROM events WHERE issue_id = ?`).all(issueId) as { type: string }[];
        expect(rows.map((r) => r.type)).toEqual(["opened"]);
      });

      it("rejects events for a non-existent issue", () => {
        expect(() => store.insertEvent(9999, "opened", "2024-03-01T00:00:00Z")).toThrow(/FOREIGN KEY/i);
      });
    });

    describe("setCompactStale", () => {
      it("flips the stale flag", () => {
        store.setCompactStale(issueId, true);
        expect(store.getIssue(repoId, 1)?.compactStale).toBe(true);
        store.setCompactStale(issueId, false);
        expect(store.getIssue(repoId, 1)?.compactStale).toBe(false);
      });

      it("is a no-op for an unknown issue", () => {
        expect(() => store.setCompactStale(9999, true)).not.toThrow();
      });
    });

    describe("updateRepoSync", () => {
      it("writes last_synced_at and etag", () => {
        store.updateRepoSync(repoId, { lastSyncedAt: "2024-04-01T00:00:00Z", etag: 'W/"e1"' });
        const repo = store.getRepo(repoId);
        expect(repo?.lastSyncedAt).toBe("2024-04-01T00:00:00Z");
        expect(repo?.etag).toBe('W/"e1"');
      });

      it("can clear the etag with null", () => {
        store.updateRepoSync(repoId, { lastSyncedAt: "2024-04-01T00:00:00Z", etag: 'W/"e1"' });
        store.updateRepoSync(repoId, { lastSyncedAt: "2024-04-02T00:00:00Z", etag: null });
        expect(store.getRepo(repoId)?.etag).toBeNull();
      });
    });

    describe("issue refs", () => {
      it("listIssueRefs returns the inserted refs in order", () => {
        store.replaceIssueRefs(issueId, ["#10", "owner/repo#45", "#20"]);
        expect(store.listIssueRefs(issueId).map((r) => r.target)).toEqual(["#10", "owner/repo#45", "#20"]);
      });

      it("returns an empty list when an issue has no refs", () => {
        expect(store.listIssueRefs(issueId)).toEqual([]);
      });

      it("replaceIssueRefs is idempotent for the same input", () => {
        store.replaceIssueRefs(issueId, ["#10", "#20"]);
        store.replaceIssueRefs(issueId, ["#10", "#20"]);
        expect(store.listIssueRefs(issueId).map((r) => r.target)).toEqual(["#10", "#20"]);
      });

      it("replaceIssueRefs clears previous refs before inserting", () => {
        store.replaceIssueRefs(issueId, ["#10", "#20"]);
        store.replaceIssueRefs(issueId, ["#30"]);
        expect(store.listIssueRefs(issueId).map((r) => r.target)).toEqual(["#30"]);
      });

      it("collapses duplicate targets in a single input", () => {
        store.replaceIssueRefs(issueId, ["#10", "#10", "#20"]);
        expect(store.listIssueRefs(issueId).map((r) => r.target)).toEqual(["#10", "#20"]);
      });

      it("clears all refs when given an empty list", () => {
        store.replaceIssueRefs(issueId, ["#10"]);
        store.replaceIssueRefs(issueId, []);
        expect(store.listIssueRefs(issueId)).toEqual([]);
      });
    });
  });

  describe("listEvents and markEventsSeen", () => {
    let repoAId: number;
    let repoBId: number;
    let issueA1: number;
    let issueB1: number;

    beforeEach(() => {
      repoAId = store.insertRepo({ owner: "octo", name: "a", fullName: "octo/a" }).id;
      repoBId = store.insertRepo({ owner: "octo", name: "b", fullName: "octo/b" }).id;
      issueA1 = store.upsertIssue(makeIssue({ repoId: repoAId, number: 1, title: "A bug", state: "open" })).id;
      issueB1 = store.upsertIssue(makeIssue({ repoId: repoBId, number: 5, title: "B bug", state: "closed" })).id;
    });

    it("joins each event with its issue and repo context", () => {
      const event = store.insertEvent(issueA1, "opened", "2024-05-01T00:00:00Z");
      const [row] = store.listEvents();
      expect(row).toEqual({
        id: event.id,
        issueId: issueA1,
        type: "opened",
        detectedAt: "2024-05-01T00:00:00Z",
        seen: false,
        repoId: repoAId,
        repoFullName: "octo/a",
        issueNumber: 1,
        issueTitle: "A bug",
        issueState: "open",
      });
    });

    it("orders newest first by detected_at then id", () => {
      store.insertEvent(issueA1, "opened", "2024-05-01T00:00:00Z");
      store.insertEvent(issueB1, "closed", "2024-05-03T00:00:00Z");
      store.insertEvent(issueA1, "commented", "2024-05-02T00:00:00Z");
      expect(store.listEvents().map((e) => e.type)).toEqual(["closed", "commented", "opened"]);
    });

    it("filters by seen state", () => {
      const e1 = store.insertEvent(issueA1, "opened", "2024-05-01T00:00:00Z");
      store.insertEvent(issueB1, "closed", "2024-05-02T00:00:00Z");
      store.markEventsSeen([e1.id]);
      expect(store.listEvents({ seen: false }).map((e) => e.type)).toEqual(["closed"]);
      expect(store.listEvents({ seen: true }).map((e) => e.type)).toEqual(["opened"]);
    });

    it("filters by since (inclusive lower bound)", () => {
      store.insertEvent(issueA1, "opened", "2024-05-01T00:00:00Z");
      store.insertEvent(issueB1, "closed", "2024-05-05T00:00:00Z");
      const since = store.listEvents({ since: "2024-05-05T00:00:00Z" });
      expect(since.map((e) => e.type)).toEqual(["closed"]);
    });

    it("filters by repoId", () => {
      store.insertEvent(issueA1, "opened", "2024-05-01T00:00:00Z");
      store.insertEvent(issueB1, "closed", "2024-05-02T00:00:00Z");
      expect(store.listEvents({ repoId: repoBId }).map((e) => e.repoFullName)).toEqual(["octo/b"]);
    });

    it("marks events seen and ignores unknown ids", () => {
      const e1 = store.insertEvent(issueA1, "opened", "2024-05-01T00:00:00Z");
      store.markEventsSeen([e1.id, 9999]);
      expect(store.listEvents({ seen: false })).toHaveLength(0);
      expect(store.listEvents({ seen: true }).map((e) => e.id)).toEqual([e1.id]);
    });

    it("is a no-op for an empty id list", () => {
      const e1 = store.insertEvent(issueA1, "opened", "2024-05-01T00:00:00Z");
      expect(() => store.markEventsSeen([])).not.toThrow();
      expect(store.listEvents({ seen: false }).map((e) => e.id)).toEqual([e1.id]);
    });
  });
});

describe("defaultDbPath", () => {
  const original = process.env.LORE_HOME;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LORE_HOME;
    } else {
      process.env.LORE_HOME = original;
    }
  });

  it("uses LORE_HOME when set", () => {
    process.env.LORE_HOME = "/tmp/custom-lore";
    expect(defaultDbPath()).toBe("/tmp/custom-lore/db.sqlite");
  });

  it("falls back to ~/.lore when LORE_HOME is unset", () => {
    delete process.env.LORE_HOME;
    expect(defaultDbPath()).toMatch(/\.lore\/db\.sqlite$/);
  });
});
