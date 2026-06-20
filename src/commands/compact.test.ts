import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/index.js";
import {
  CompactCommandError,
  formatCompactList,
  parseTarget,
  runCompactList,
  runCompactSet,
  type CompactListItem,
} from "./compact.js";

const VALID_COMPACT = `---
status: open
state_reason: null
labels: [bug]
---
tldr: Something is wrong with the scheduler.

problem: The scheduler runs twice.
status_detail: awaiting repro.
decisions: null
open_questions: null
`;

describe("parseTarget", () => {
  it("parses owner/repo#number", () => {
    expect(parseTarget("octocat/hello#42")).toEqual({ fullName: "octocat/hello", number: 42 });
  });

  it("trims surrounding whitespace", () => {
    expect(parseTarget("  octo/demo#7 ")).toEqual({ fullName: "octo/demo", number: 7 });
  });

  it.each(["octocat/hello", "octocat#42", "octocat/hello#", "octocat/hello#abc", "a/b/c#1"])(
    "rejects malformed target %s",
    (target) => {
      expect(() => parseTarget(target)).toThrow(/owner\/repo#number/);
    },
  );
});

describe("runCompactSet", () => {
  let dir: string;
  let store: Store;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-compact-"));
    store = openStore(join(dir, "db.sqlite"));
    filePath = join(dir, "compact.md");
    writeFileSync(filePath, VALID_COMPACT, "utf8");
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedIssue(overrides: { compactStale?: boolean } = {}) {
    const repo = store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
    store.upsertIssue({
      repoId: repo.id,
      number: 7,
      title: "Scheduler bug",
      state: "open",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      compactStale: overrides.compactStale ?? false,
    });
    return repo;
  }

  it("persists the compact and clears the stale flag", () => {
    const repo = seedIssue({ compactStale: true });

    const result = runCompactSet(store, "octo/demo#7", { fromFile: filePath });

    expect(result).toEqual({
      ok: true,
      repo: "octo/demo",
      number: 7,
      tldr: "Something is wrong with the scheduler.",
    });

    const issue = store.getIssue(repo.id, 7);
    expect(issue?.compact).toBe(VALID_COMPACT);
    expect(issue?.compactTldr).toBe("Something is wrong with the scheduler.");
    expect(issue?.compactStale).toBe(false);
    expect(issue?.compactedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("errors when the repo is not watched", () => {
    expect(() => runCompactSet(store, "ghost/repo#1", { fromFile: filePath })).toThrow(CompactCommandError);
    expect(() => runCompactSet(store, "ghost/repo#1", { fromFile: filePath })).toThrow(/not watched/);
  });

  it("errors when the issue is not in the local store", () => {
    store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
    expect(() => runCompactSet(store, "octo/demo#7", { fromFile: filePath })).toThrow(/Run `lore sync` first/);
  });

  it("errors when the file cannot be read", () => {
    seedIssue();
    expect(() => runCompactSet(store, "octo/demo#7", { fromFile: join(dir, "missing.md") })).toThrow(
      /Could not read compact file/,
    );
  });

  it("errors on an invalid compact file", () => {
    seedIssue();
    writeFileSync(filePath, "no frontmatter here", "utf8");
    expect(() => runCompactSet(store, "octo/demo#7", { fromFile: filePath })).toThrow(/Invalid compact/);
  });

  it("errors on a malformed target", () => {
    seedIssue();
    expect(() => runCompactSet(store, "not-a-target", { fromFile: filePath })).toThrow(/owner\/repo#number/);
  });
});

describe("runCompactList", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-compact-list-"));
    store = openStore(join(dir, "db.sqlite"));
    seed();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Seeds two repos with a mix of compaction states:
   * - octo/demo#1 never compacted (uncompacted)
   * - octo/demo#2 compacted but stale (stale)
   * - octo/demo#3 freshly compacted (compacted)
   * - other/lib#10 never compacted (uncompacted), with comments to fetch
   */
  function seed() {
    const demo = store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
    const lib = store.insertRepo({ owner: "other", name: "lib", fullName: "other/lib" });

    store.upsertIssue({
      repoId: demo.id,
      number: 1,
      title: "Never compacted bug",
      state: "open",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      rawBody: "body for #1",
    });
    store.upsertIssue({
      repoId: demo.id,
      number: 2,
      title: "Stale compact",
      state: "closed",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      compact: "---\nstatus: closed\n---\ntldr: x\n",
      compactTldr: "x",
      compactStale: true,
      rawBody: "body for #2",
    });
    store.upsertIssue({
      repoId: demo.id,
      number: 3,
      title: "Fresh compact",
      state: "open",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      compact: "---\nstatus: open\n---\ntldr: y\n",
      compactTldr: "y",
      compactStale: false,
      rawBody: "body for #3",
    });
    store.upsertIssue({
      repoId: lib.id,
      number: 10,
      title: "Lib issue",
      state: "open",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      rawBody: "body for #10",
      commentCount: 3,
    });
  }

  function find(items: CompactListItem[], repo: string, number: number): CompactListItem | undefined {
    return items.find((item) => item.repo === repo && item.number === number);
  }

  it("--pending returns only uncompacted and stale issues with a reason", () => {
    const items = runCompactList(store, { pending: true });

    expect(items.map((item) => [item.repo, item.number]).sort()).toEqual([
      ["octo/demo", 1],
      ["octo/demo", 2],
      ["other/lib", 10],
    ]);
    expect(find(items, "octo/demo", 1)?.reason).toBe("uncompacted");
    expect(find(items, "octo/demo", 2)?.reason).toBe("stale");
    expect(find(items, "other/lib", 10)?.reason).toBe("uncompacted");
    // The fresh compact must not appear.
    expect(find(items, "octo/demo", 3)).toBeUndefined();
  });

  it("without --pending returns all issues with status and a null reason for fresh", () => {
    const items = runCompactList(store);

    expect(items).toHaveLength(4);
    expect(find(items, "octo/demo", 1)?.status).toBe("uncompacted");
    expect(find(items, "octo/demo", 2)?.status).toBe("stale");
    expect(find(items, "octo/demo", 3)?.status).toBe("compacted");
    expect(find(items, "octo/demo", 3)?.reason).toBeNull();
  });

  it("--repo restricts to a single repo", () => {
    const items = runCompactList(store, { repo: "other/lib" });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: "other/lib", number: 10, status: "uncompacted" });
  });

  it("errors when --repo names an unwatched repo", () => {
    expect(() => runCompactList(store, { repo: "ghost/repo" })).toThrow(CompactCommandError);
    expect(() => runCompactList(store, { repo: "ghost/repo" })).toThrow(/not watched/);
  });

  it("carries the raw body and a comments-need-fetch hint for AI consumers", () => {
    const items = runCompactList(store, { pending: true });

    const one = find(items, "octo/demo", 1);
    expect(one?.rawBody).toBe("body for #1");
    expect(one?.commentsNeedFetch).toBe(false);

    const lib = find(items, "other/lib", 10);
    expect(lib?.rawBody).toBe("body for #10");
    // commentCount > 0 and raw_comments not yet fetched.
    expect(lib?.commentsNeedFetch).toBe(true);
  });

  it("json shape matches the typed item", () => {
    const items = runCompactList(store, { pending: true });
    const parsed = JSON.parse(JSON.stringify(items)) as CompactListItem[];

    const one = parsed.find((item) => item.repo === "octo/demo" && item.number === 1);
    expect(one).toEqual({
      repo: "octo/demo",
      number: 1,
      title: "Never compacted bug",
      state: "open",
      status: "uncompacted",
      reason: "uncompacted",
      rawBody: "body for #1",
      commentsNeedFetch: false,
    });
  });

  it("formats a human listing grouped by repo", () => {
    const items = runCompactList(store);
    const text = formatCompactList(items);

    expect(text).toContain("octo/demo:");
    expect(text).toContain("other/lib:");
    expect(text).toContain("#1");
    expect(text).toContain("uncompacted");
    expect(text).toContain("Never compacted bug");
  });

  it("formats an empty pending listing with an all-clear message", () => {
    expect(formatCompactList([], { pending: true })).toMatch(/Nothing to compact/);
  });
});
