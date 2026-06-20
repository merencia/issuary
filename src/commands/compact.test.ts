import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/index.js";
import { CompactCommandError, parseTarget, runCompactSet } from "./compact.js";

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
