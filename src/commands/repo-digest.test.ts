import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store, type UpsertIssue } from "../store/index.js";
import { RepoDigestError, runRepoDigest, runRepoDigestHeadlines } from "./repo-digest.js";

function compactDoc(tldr: string): string {
  return `---
status: open
state_reason: null
---
tldr: ${tldr}

problem: something.
status_detail: null
decisions: null
open_questions: null
`;
}

describe("repo-digest actions", () => {
  let dir: string;
  let store: Store;
  let repoId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-repo-digest-"));
    store = openStore(join(dir, "db.sqlite"));
    const repo = store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
    repoId = repo.id;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(overrides: Partial<UpsertIssue> & Pick<UpsertIssue, "number">): void {
    store.upsertIssue({
      repoId,
      title: `Issue ${overrides.number}`,
      state: "open",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      ...overrides,
    });
  }

  /**
   * Mix: #1 fresh compact (open), #2 stale compact (open), #3 no compact (open),
   * #4 fresh compact (closed/completed), #5 no compact (closed/not_planned).
   */
  function seedMix(): void {
    seed({
      number: 1,
      title: "Fresh open",
      compact: compactDoc("Fresh open tldr."),
      compactTldr: "Fresh open tldr.",
      compactStale: false,
      rawBody: "raw body 1",
    });
    seed({
      number: 2,
      title: "Stale open",
      compact: compactDoc("Stale open tldr."),
      compactTldr: "Stale open tldr.",
      compactStale: true,
      rawBody: "raw body 2",
    });
    seed({ number: 3, title: "Bare open", rawBody: "raw body 3" });
    seed({
      number: 4,
      title: "Fresh closed",
      state: "closed",
      stateReason: "completed",
      closedAt: "2024-02-01T00:00:00Z",
      compact: compactDoc("Fresh closed tldr."),
      compactTldr: "Fresh closed tldr.",
      compactStale: false,
      rawBody: "raw body 4",
    });
    seed({
      number: 5,
      title: "Bare closed",
      state: "closed",
      stateReason: "not_planned",
      closedAt: "2024-02-02T00:00:00Z",
    });
  }

  describe("runRepoDigest", () => {
    it("prefers fresh compacts and falls back to raw otherwise", () => {
      seedMix();
      const result = runRepoDigest(store, "octo/demo");

      const byNumber = new Map(result.issues.map((i) => [i.number, i]));

      const fresh = byNumber.get(1)!;
      expect(fresh.compacted).toBe(true);
      expect(fresh.stale).toBe(false);
      expect(fresh.representation).toContain("tldr: Fresh open tldr.");

      const stale = byNumber.get(2)!;
      expect(stale.compacted).toBe(false);
      expect(stale.stale).toBe(true);
      expect(stale.representation).toBe("raw body 2");

      const bare = byNumber.get(3)!;
      expect(bare.compacted).toBe(false);
      expect(bare.stale).toBe(false);
      expect(bare.representation).toBe("raw body 3");

      const bareClosed = byNumber.get(5)!;
      expect(bareClosed.stateReason).toBe("not_planned");
      expect(bareClosed.representation).toBeNull();
    });

    it("orders open issues before closed", () => {
      seedMix();
      const numbers = runRepoDigest(store, "octo/demo").issues.map((i) => i.number);
      expect(numbers).toEqual([1, 2, 3, 4, 5]);
      const states = runRepoDigest(store, "octo/demo").issues.map((i) => i.state);
      expect(states).toEqual(["open", "open", "open", "closed", "closed"]);
    });

    it("computes correct summary counts", () => {
      seedMix();
      const { summary, repo } = runRepoDigest(store, "octo/demo");
      expect(repo).toBe("octo/demo");
      expect(summary).toEqual({
        total: 5,
        open: 3,
        closed: 2,
        compacted: 2,
        staleOrUncompacted: 3,
      });
    });

    it("produces an empty digest for a watched repo with no issues", () => {
      const result = runRepoDigest(store, "octo/demo");
      expect(result.issues).toEqual([]);
      expect(result.summary.total).toBe(0);
    });

    it("throws RepoDigestError for an unwatched repo", () => {
      expect(() => runRepoDigest(store, "octo/missing")).toThrow(RepoDigestError);
      expect(() => runRepoDigest(store, "octo/missing")).toThrow(/not watched/);
    });
  });

  describe("runRepoDigestHeadlines", () => {
    it("emits one lean line per issue with tldr or title fallback", () => {
      seedMix();
      const result = runRepoDigestHeadlines(store, "octo/demo");
      expect(result.headlines).toHaveLength(5);

      const byNumber = new Map(result.headlines.map((h) => [h.number, h]));

      expect(byNumber.get(1)).toMatchObject({
        state: "open",
        headline: "Fresh open tldr.",
        fromTldr: true,
      });
      // Stale compact still has a tldr, so it is shown.
      expect(byNumber.get(2)).toMatchObject({ headline: "Stale open tldr.", fromTldr: true });
      // No compact: fall back to the title.
      expect(byNumber.get(3)).toMatchObject({ headline: "Bare open", fromTldr: false });
      expect(byNumber.get(5)).toMatchObject({ headline: "Bare closed", fromTldr: false });
    });

    it("carries the same summary as the full digest", () => {
      seedMix();
      const result = runRepoDigestHeadlines(store, "octo/demo");
      expect(result.summary).toEqual(runRepoDigest(store, "octo/demo").summary);
    });

    it("throws RepoDigestError for an unwatched repo", () => {
      expect(() => runRepoDigestHeadlines(store, "octo/missing")).toThrow(RepoDigestError);
    });
  });
});
