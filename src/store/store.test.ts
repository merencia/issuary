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
