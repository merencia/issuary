import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store, type UpsertIssue } from "../store/index.js";
import { formatIssues, IssuesError, runIssues } from "./issues.js";

function makeIssue(overrides: Partial<UpsertIssue> & Pick<UpsertIssue, "repoId" | "number">): UpsertIssue {
  return {
    title: "Something",
    state: "open",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("runIssues", () => {
  let store: Store;
  let alpha: number;

  beforeEach(() => {
    store = openStore(":memory:");
    alpha = store.insertRepo({ owner: "octo", name: "alpha", fullName: "octo/alpha" }).id;
    const beta = store.insertRepo({ owner: "octo", name: "beta", fullName: "octo/beta" }).id;

    const issue1 = store.upsertIssue(
      makeIssue({
        repoId: alpha,
        number: 1,
        title: "Timezone bug",
        state: "open",
        author: "ann",
        labels: JSON.stringify(["bug", "timezone"]),
        commentCount: 3,
        updatedAt: "2024-03-01T00:00:00.000Z",
        compact: "---\nstatus: open\n---\ntldr: tz bug",
        compactTldr: "tz bug",
        compactStale: false,
      }),
    );
    store.replaceIssueRefs(issue1.id, ["#42", "octo/beta#7"]);

    store.upsertIssue(
      makeIssue({
        repoId: alpha,
        number: 2,
        title: "Closed thing",
        state: "closed",
        stateReason: "completed",
        author: "bob",
        labels: JSON.stringify(["feature"]),
        updatedAt: "2024-02-01T00:00:00.000Z",
      }),
    );
    store.upsertIssue(
      makeIssue({
        repoId: beta,
        number: 1,
        title: "Beta open issue",
        state: "open",
        author: "carol",
        labels: JSON.stringify(["timezone"]),
        updatedAt: "2024-04-01T00:00:00.000Z",
      }),
    );
  });

  afterEach(() => {
    store.close();
  });

  it("defaults to open issues across all repos, newest-updated first", () => {
    const result = runIssues(store);
    expect(result.filters.state).toBe("open");
    expect(result.summary).toEqual({ total: 2, open: 2, closed: 0, repos: 2 });
    expect(result.issues.map((i) => `${i.repo}#${i.number}`)).toEqual(["octo/beta#1", "octo/alpha#1"]);
  });

  it("includes compact, tldr, refs and flags but no raw body", () => {
    const result = runIssues(store, { repo: ["octo/alpha"], state: "open" });
    const issue = result.issues[0];
    expect(issue.compact).toContain("tldr: tz bug");
    expect(issue.compactTldr).toBe("tz bug");
    expect(issue.compacted).toBe(true);
    expect(issue.stale).toBe(false);
    expect(issue.refs).toEqual(["#42", "octo/beta#7"]);
    expect(issue.labels).toEqual(["bug", "timezone"]);
    expect(issue.commentCount).toBe(3);
    expect(issue).not.toHaveProperty("rawBody");
    expect(issue).not.toHaveProperty("rawComments");
  });

  it("echoes the normalized filters in the envelope", () => {
    const result = runIssues(store, {
      state: "all",
      label: ["bug"],
      author: "ann",
      search: "bug",
      sort: "created",
      order: "asc",
      limit: 5,
    });
    expect(result.filters).toMatchObject({
      state: "all",
      labels: ["bug"],
      author: "ann",
      search: "bug",
      sort: "created",
      order: "asc",
      limit: 5,
      repos: null,
      compaction: null,
    });
  });

  it("errors on an unwatched --repo", () => {
    expect(() => runIssues(store, { repo: ["octo/ghost"] })).toThrow(IssuesError);
  });

  it("produces a --json envelope with no ANSI escape bytes", () => {
    // The JSON path stringifies the raw result and never calls a formatter, so
    // it must stay free of color even if color were enabled.
    const json = JSON.stringify(runIssues(store, { state: "all" }));
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(json)).toBe(false);
  });

  it("errors when more than one compaction flag is passed", () => {
    expect(() => runIssues(store, { uncompacted: true, stale: true })).toThrow(/mutually exclusive/);
    expect(() => runIssues(store, { stale: true, compacted: true })).toThrow(IssuesError);
  });

  it("accepts a single compaction flag", () => {
    const result = runIssues(store, { state: "all", compacted: true });
    expect(result.filters.compaction).toBe("compacted");
    expect(result.issues.map((i) => `${i.repo}#${i.number}`)).toEqual(["octo/alpha#1"]);
  });

  it("errors on a malformed --since", () => {
    expect(() => runIssues(store, { since: "not-a-date" })).toThrow(IssuesError);
  });
});

describe("formatIssues", () => {
  it("renders a header, grouped rows, labels, comments and compaction markers", () => {
    const text = formatIssues({
      filters: {
        state: "open",
        repos: null,
        labels: null,
        author: null,
        stateReason: null,
        since: null,
        search: null,
        compaction: null,
        sort: "updated",
        order: "desc",
        limit: null,
      },
      summary: { total: 2, open: 2, closed: 0, repos: 1 },
      issues: [
        {
          repo: "octo/alpha",
          number: 1,
          title: "Timezone bug",
          state: "open",
          stateReason: null,
          author: "ann",
          labels: ["bug"],
          commentCount: 3,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-03-01T00:00:00.000Z",
          compact: null,
          compactTldr: null,
          compacted: false,
          stale: false,
          refs: [],
        },
        {
          repo: "octo/alpha",
          number: 2,
          title: "Stale one",
          state: "open",
          stateReason: null,
          author: "bob",
          labels: [],
          commentCount: 0,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-02-01T00:00:00.000Z",
          compact: "x",
          compactTldr: "x",
          compacted: false,
          stale: true,
          refs: [],
        },
      ],
    });
    expect(text).toContain("2 open issues across 1 repo");
    expect(text).toContain("octo/alpha:");
    expect(text).toContain("#1");
    expect(text).toContain("{bug}");
    expect(text).toContain("(3c)");
    expect(text).toContain("(uncompacted)");
    expect(text).toContain("(stale)");
  });

  it("renders a non-default filter suffix", () => {
    const text = formatIssues({
      filters: {
        state: "all",
        repos: ["octo/alpha"],
        labels: ["bug"],
        author: null,
        stateReason: null,
        since: null,
        search: null,
        compaction: null,
        sort: "updated",
        order: "desc",
        limit: null,
      },
      summary: { total: 0, open: 0, closed: 0, repos: 0 },
      issues: [],
    });
    expect(text).toContain("No issues match");
    expect(text).toContain("repos=octo/alpha");
    expect(text).toContain("labels=bug");
  });
});
