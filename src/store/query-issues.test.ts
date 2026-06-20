import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "./store.js";
import type { UpsertIssue } from "./types.js";

function makeIssue(overrides: Partial<UpsertIssue> & Pick<UpsertIssue, "repoId" | "number">): UpsertIssue {
  return {
    title: "Something",
    state: "open",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("queryIssues", () => {
  let store: Store;
  let alpha: number;
  let beta: number;

  beforeEach(() => {
    store = openStore(":memory:");
    alpha = store.insertRepo({ owner: "octo", name: "alpha", fullName: "octo/alpha" }).id;
    beta = store.insertRepo({ owner: "octo", name: "beta", fullName: "octo/beta" }).id;

    // alpha: a mix of open/closed, labels, authors, compaction states, dates.
    store.upsertIssue(
      makeIssue({
        repoId: alpha,
        number: 1,
        title: "Timezone bug in scheduler",
        state: "open",
        author: "ann",
        labels: JSON.stringify(["bug", "timezone"]),
        updatedAt: "2024-03-01T00:00:00.000Z",
        createdAt: "2024-01-10T00:00:00.000Z",
      }),
    );
    store.upsertIssue(
      makeIssue({
        repoId: alpha,
        number: 2,
        title: "Add dark mode",
        state: "open",
        author: "bob",
        labels: JSON.stringify(["feature"]),
        updatedAt: "2024-02-01T00:00:00.000Z",
        createdAt: "2024-02-01T00:00:00.000Z",
        compact: "---\nstatus: open\n---\ntldr: dark mode",
        compactTldr: "dark mode",
        compactStale: false,
      }),
    );
    store.upsertIssue(
      makeIssue({
        repoId: alpha,
        number: 3,
        title: "Crash on startup",
        state: "closed",
        stateReason: "completed",
        author: "ann",
        labels: JSON.stringify(["bug"]),
        updatedAt: "2024-04-01T00:00:00.000Z",
        createdAt: "2024-03-15T00:00:00.000Z",
        compact: "---\nstatus: closed\n---\ntldr: crash",
        compactTldr: "crash",
        compactStale: true,
      }),
    );

    // beta: closed not_planned, no labels.
    store.upsertIssue(
      makeIssue({
        repoId: beta,
        number: 1,
        title: "Wontfix request",
        state: "closed",
        stateReason: "not_planned",
        author: "carol",
        labels: JSON.stringify([]),
        updatedAt: "2024-05-01T00:00:00.000Z",
        createdAt: "2024-05-01T00:00:00.000Z",
      }),
    );
    store.upsertIssue(
      makeIssue({
        repoId: beta,
        number: 2,
        title: "Open feature in beta",
        state: "open",
        author: "bob",
        labels: JSON.stringify(["feature", "timezone"]),
        updatedAt: "2024-06-01T00:00:00.000Z",
        createdAt: "2024-06-01T00:00:00.000Z",
      }),
    );
  });

  afterEach(() => {
    store.close();
  });

  const ids = (rows: { repoFullName: string; number: number }[]) => rows.map((r) => `${r.repoFullName}#${r.number}`);

  it("defaults to open state across all repos", () => {
    const rows = store.queryIssues({ state: "open" });
    expect(ids(rows).sort()).toEqual(["octo/alpha#1", "octo/alpha#2", "octo/beta#2"]);
    expect(rows.every((r) => r.state === "open")).toBe(true);
    expect(rows[0].repoFullName).toBeTypeOf("string");
  });

  it("supports state all and closed", () => {
    expect(store.queryIssues({ state: "all" })).toHaveLength(5);
    const closed = store.queryIssues({ state: "closed" });
    expect(ids(closed).sort()).toEqual(["octo/alpha#3", "octo/beta#1"]);
  });

  it("scopes to specific repos", () => {
    const rows = store.queryIssues({ state: "all", repoIds: [beta] });
    expect(rows.every((r) => r.repoFullName === "octo/beta")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("filters by author", () => {
    const rows = store.queryIssues({ state: "all", author: "ann" });
    expect(ids(rows).sort()).toEqual(["octo/alpha#1", "octo/alpha#3"]);
  });

  it("filters by state_reason", () => {
    const rows = store.queryIssues({ state: "all", stateReason: "not_planned" });
    expect(ids(rows)).toEqual(["octo/beta#1"]);
  });

  it("filters by since on updated_at", () => {
    const rows = store.queryIssues({ state: "all", since: "2024-05-01T00:00:00.000Z" });
    expect(ids(rows).sort()).toEqual(["octo/beta#1", "octo/beta#2"]);
  });

  it("filters by case-insensitive title search", () => {
    const rows = store.queryIssues({ state: "all", search: "BUG" });
    expect(ids(rows)).toEqual(["octo/alpha#1"]);
  });

  it("filters by labels with OR semantics via json_each", () => {
    const rows = store.queryIssues({ state: "all", labels: ["timezone"] });
    expect(ids(rows).sort()).toEqual(["octo/alpha#1", "octo/beta#2"]);

    const multi = store.queryIssues({ state: "all", labels: ["bug", "feature"] });
    expect(ids(multi).sort()).toEqual(["octo/alpha#1", "octo/alpha#2", "octo/alpha#3", "octo/beta#2"]);
  });

  it("filters by compaction state", () => {
    expect(ids(store.queryIssues({ state: "all", compaction: "compacted" }))).toEqual(["octo/alpha#2"]);
    expect(ids(store.queryIssues({ state: "all", compaction: "stale" }))).toEqual(["octo/alpha#3"]);
    const uncompacted = store.queryIssues({ state: "all", compaction: "uncompacted" });
    expect(ids(uncompacted).sort()).toEqual(["octo/alpha#1", "octo/beta#1", "octo/beta#2"]);
  });

  it("sorts by the requested key and order", () => {
    const updatedDesc = store.queryIssues({ state: "all", sort: "updated", order: "desc" });
    expect(ids(updatedDesc)).toEqual(["octo/beta#2", "octo/beta#1", "octo/alpha#3", "octo/alpha#1", "octo/alpha#2"]);

    const createdAsc = store.queryIssues({ state: "all", sort: "created", order: "asc" });
    expect(ids(createdAsc)[0]).toBe("octo/alpha#1");

    const numberAsc = store.queryIssues({ state: "all", repoIds: [alpha], sort: "number", order: "asc" });
    expect(numberAsc.map((r) => r.number)).toEqual([1, 2, 3]);
  });

  it("applies a limit", () => {
    expect(store.queryIssues({ state: "all", limit: 2 })).toHaveLength(2);
    expect(store.queryIssues({ state: "all", limit: 0 })).toHaveLength(5);
  });

  it("returns the full Issue shape plus repoFullName", () => {
    const [row] = store.queryIssues({ state: "all", repoIds: [alpha], sort: "number", order: "asc" });
    expect(row).toMatchObject({
      number: 1,
      title: "Timezone bug in scheduler",
      repoFullName: "octo/alpha",
      compactStale: false,
    });
    expect(row).toHaveProperty("rawBody");
  });
});
