import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/index.js";
import { DigestError, formatDigest, resolveSince, runDigest, type DigestResult } from "./digest.js";

/**
 * Seeds two repos with a mix of seen/unseen events across multiple types and
 * timestamps. Returns the inserted event ids by a readable label.
 */
function seed(store: Store): Record<string, number> {
  const repoA = store.insertRepo({ owner: "octo", name: "alpha", fullName: "octo/alpha" });
  const repoB = store.insertRepo({ owner: "octo", name: "beta", fullName: "octo/beta" });

  const a1 = store.upsertIssue({
    repoId: repoA.id,
    number: 1,
    title: "Alpha opened",
    state: "open",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  }).id;
  const a2 = store.upsertIssue({
    repoId: repoA.id,
    number: 2,
    title: "Alpha closed",
    state: "closed",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  }).id;
  const b1 = store.upsertIssue({
    repoId: repoB.id,
    number: 9,
    title: "Beta commented",
    state: "open",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  }).id;

  const ids: Record<string, number> = {};
  ids.aOpened = store.insertEvent(a1, "opened", "2024-05-01T00:00:00Z").id;
  ids.aClosed = store.insertEvent(a2, "closed", "2024-05-02T00:00:00Z").id;
  ids.aComment = store.insertEvent(a1, "commented", "2024-05-03T00:00:00Z").id;
  ids.bComment = store.insertEvent(b1, "commented", "2024-05-04T00:00:00Z").id;
  // Pre-seen event: should not appear in the inbox.
  ids.bSeen = store.insertEvent(b1, "reopened", "2024-04-01T00:00:00Z").id;
  store.markEventsSeen([ids.bSeen]);
  return ids;
}

describe("resolveSince", () => {
  it("passes through an ISO date", () => {
    expect(resolveSince("2024-05-01T00:00:00Z")).toBe("2024-05-01T00:00:00.000Z");
  });

  it("resolves a relative day duration", () => {
    const now = new Date("2024-05-10T00:00:00Z");
    expect(resolveSince("7d", now)).toBe("2024-05-03T00:00:00.000Z");
  });

  it("resolves a relative hour duration", () => {
    const now = new Date("2024-05-10T12:00:00Z");
    expect(resolveSince("24h", now)).toBe("2024-05-09T12:00:00.000Z");
  });

  it("throws on a malformed value", () => {
    expect(() => resolveSince("not-a-date")).toThrow(DigestError);
  });
});

describe("runDigest", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-digest-"));
    store = openStore(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("default inbox mode", () => {
    it("shows only unseen events and marks them seen", () => {
      seed(store);
      const first = runDigest(store);
      expect(first.mode).toBe("inbox");
      expect(first.total).toBe(4);

      // A second call shows nothing: the inbox was drained.
      const second = runDigest(store);
      expect(second.total).toBe(0);
      expect(second.repos).toEqual([]);
    });

    it("aggregates and groups across repos by type in canonical order", () => {
      seed(store);
      const result = runDigest(store);
      expect(result.repos.map((r) => r.repo)).toEqual(["octo/alpha", "octo/beta"]);

      const alpha = result.repos[0];
      expect(alpha.groups.map((g) => g.type)).toEqual(["opened", "closed", "commented"]);
      expect(alpha.groups[0].events[0].issueNumber).toBe(1);
      expect(alpha.groups[0].events[0].issueTitle).toBe("Alpha opened");

      const beta = result.repos[1];
      expect(beta.groups.map((g) => g.type)).toEqual(["commented"]);
    });
  });

  describe("--since mode", () => {
    it("filters by time and does not mark seen", () => {
      seed(store);
      const result = runDigest(store, { since: "2024-05-03T00:00:00Z" });
      expect(result.mode).toBe("since");
      expect(result.total).toBe(2); // aComment + bComment

      // Nothing was marked: the inbox still has all four unseen events.
      expect(runDigest(store, { all: true }).repos.length).toBe(2);
      const inbox = runDigest(store, {});
      expect(inbox.total).toBe(4);
    });

    it("rejects a malformed since value", () => {
      seed(store);
      expect(() => runDigest(store, { since: "yesterday" })).toThrow(DigestError);
    });
  });

  describe("--all mode", () => {
    it("shows seen and unseen without marking", () => {
      seed(store);
      const result = runDigest(store, { all: true });
      expect(result.mode).toBe("all");
      expect(result.total).toBe(5); // includes the pre-seen reopened event

      // Unseen inbox is untouched.
      expect(runDigest(store, {}).total).toBe(4);
    });
  });

  describe("--repo filter", () => {
    it("limits to one repo and still marks seen in inbox mode", () => {
      seed(store);
      const result = runDigest(store, { repo: "octo/alpha" });
      expect(result.repos.map((r) => r.repo)).toEqual(["octo/alpha"]);
      expect(result.total).toBe(3);

      // Alpha's events are now seen; only beta's unseen comment remains.
      const remaining = runDigest(store, {});
      expect(remaining.repos.map((r) => r.repo)).toEqual(["octo/beta"]);
      expect(remaining.total).toBe(1);
    });

    it("throws for an unwatched repo", () => {
      seed(store);
      expect(() => runDigest(store, { repo: "octo/nope" })).toThrow(DigestError);
    });
  });

  describe("--json shape", () => {
    it("is serializable and grouped by repo", () => {
      seed(store);
      const result = runDigest(store, { all: true });
      const roundTrip = JSON.parse(JSON.stringify(result)) as DigestResult;
      expect(roundTrip.mode).toBe("all");
      expect(roundTrip.repos[0].groups[0].events[0]).toMatchObject({
        type: expect.any(String),
        issueNumber: expect.any(Number),
        issueTitle: expect.any(String),
        issueState: expect.any(String),
      });
    });
  });
});

describe("formatDigest", () => {
  it("renders an inbox-empty message", () => {
    const result: DigestResult = { mode: "inbox", total: 0, repos: [] };
    expect(formatDigest(result)).toBe("Inbox empty: no new changes.");
  });

  it("renders a no-match message for read-only modes", () => {
    const result: DigestResult = { mode: "all", total: 0, repos: [] };
    expect(formatDigest(result)).toBe("No matching events.");
  });

  it("renders repos, type labels, and issue lines", () => {
    const result: DigestResult = {
      mode: "inbox",
      total: 1,
      repos: [
        {
          repo: "octo/alpha",
          groups: [
            {
              type: "opened",
              events: [
                {
                  id: 1,
                  type: "opened",
                  detectedAt: "2024-05-01T00:00:00Z",
                  issueNumber: 1,
                  issueTitle: "Alpha opened",
                  issueState: "open",
                },
              ],
            },
          ],
        },
      ],
    };
    const text = formatDigest(result);
    expect(text).toContain("octo/alpha");
    expect(text).toContain("new issues (1)");
    expect(text).toContain("#1 [open] Alpha opened");
  });
});
