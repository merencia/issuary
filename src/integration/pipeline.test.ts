/**
 * End-to-end integration tests for the lore pipeline.
 *
 * These tests exercise the SEAMS between modules: they compose the real command
 * actions (`run*`), the real {@link runSync} engine, a real on-disk SQLite store,
 * and the real {@link createGitHubClient} driven by an injected `fetch`. Only the
 * network is faked. There is no real sleeping and no real HTTP.
 *
 * Per-module behavior is covered by the co-located unit tests; here we only
 * assert observable, cross-module outcomes (store rows and action return values).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdd } from "../commands/add.js";
import { runCompactList, runCompactSet } from "../commands/compact.js";
import { runDigest } from "../commands/digest.js";
import { runRepoDigest } from "../commands/repo-digest.js";
import { runShow } from "../commands/show.js";
import { runSyncCommand } from "../commands/sync.js";
import { createGitHubClient, type GitHubClient } from "../github/index.js";
import { openStore, type Store } from "../store/index.js";

const API_URL = "https://api.github.com";

/** A canned issue payload in the raw GitHub REST shape, with sane defaults. */
interface IssueSeed {
  number: number;
  title?: string;
  state?: "open" | "closed";
  state_reason?: "completed" | "not_planned" | null;
  user?: { login: string } | null;
  labels?: { name: string }[];
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  comments?: number;
  body?: string | null;
  /** Set to mark this payload as a pull request (filtered out by the client). */
  pull_request?: { url: string };
}

function issuePayload(seed: IssueSeed): Record<string, unknown> {
  return {
    number: seed.number,
    title: seed.title ?? `Issue ${seed.number}`,
    state: seed.state ?? "open",
    state_reason: seed.state_reason ?? null,
    user: seed.user === undefined ? { login: "octocat" } : seed.user,
    labels: seed.labels ?? [],
    created_at: seed.created_at ?? "2024-01-01T00:00:00Z",
    updated_at: seed.updated_at ?? "2024-01-02T00:00:00Z",
    closed_at: seed.closed_at ?? null,
    comments: seed.comments ?? 0,
    body: seed.body ?? null,
    ...(seed.pull_request ? { pull_request: seed.pull_request } : {}),
  };
}

/** Builds a minimal Response-like object good enough for the real client. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

/**
 * A programmable fake `fetch`. Routes are keyed by an exact path+query match or a
 * predicate, and each route can return a static response or be a function of the
 * request. Records every requested URL so tests can assert on call counts (the
 * "do not fetch twice" principle) and on conditional-request headers.
 */
interface FakeFetch {
  fetch: typeof fetch;
  /** Every URL requested, in order. */
  urls: string[];
  /** Every request's headers, parallel to {@link urls}. */
  headers: Headers[];
  /**
   * Registers a handler for requests whose path matches `test` (a substring of
   * the URL or a predicate). Handlers are tried in registration order.
   */
  on(test: string | ((url: string) => boolean), handler: (url: string, init?: RequestInit) => Response): void;
}

function makeFakeFetch(): FakeFetch {
  const routes: { test: (url: string) => boolean; handler: (url: string, init?: RequestInit) => Response }[] = [];
  const urls: string[] = [];
  const headers: Headers[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    headers.push(new Headers(init?.headers));
    for (const route of routes) {
      if (route.test(url)) {
        return route.handler(url, init);
      }
    }
    throw new Error(`fake fetch: no route for ${url}`);
  }) as unknown as typeof fetch;

  return {
    fetch: fetchImpl,
    urls,
    headers,
    on(test, handler) {
      const predicate = typeof test === "string" ? (url: string) => url.includes(test) : test;
      routes.push({ test: predicate, handler });
    },
  };
}

/** Builds the real GitHub client over a fake fetch, with sleep stubbed out. */
function clientOver(fake: FakeFetch): GitHubClient {
  return createGitHubClient({
    token: "ghp_test",
    apiUrl: API_URL,
    fetch: fake.fetch,
    sleep: async () => {},
  });
}

/** A repo's first-page issues URL (state=all, sorted, page 1). */
function issuesPath(fullName: string): string {
  return `${API_URL}/repos/${fullName}/issues?`;
}

let dbPath: string;
let tmpDir: string;
let store: Store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lore-it-"));
  dbPath = join(tmpDir, "db.sqlite");
  store = openStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Registers a `getRepo` route that succeeds for any repo (used by `add`). */
function allowAnyRepo(fake: FakeFetch): void {
  fake.on(
    (url) => /\/repos\/[^/]+\/[^/]+$/.test(url),
    (url) => {
      const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(url);
      const owner = match?.[1] ?? "owner";
      const name = match?.[2] ?? "repo";
      return jsonResponse(200, { owner: { login: owner }, name, full_name: `${owner}/${name}`, private: false });
    },
  );
}

describe("integration: add -> sync -> digest", () => {
  it("syncs two repos and aggregates new/closed/commented events into the inbox, then drains", async () => {
    const fake = makeFakeFetch();
    allowAnyRepo(fake);
    const client = clientOver(fake);

    // alpha: one open, one closed-with-comments.
    fake.on(issuesPath("acme/alpha"), () =>
      jsonResponse(200, [
        issuePayload({ number: 1, state: "open", comments: 0 }),
        issuePayload({ number: 2, state: "closed", state_reason: "completed", comments: 3 }),
      ]),
    );
    // beta: one open with comments.
    fake.on(issuesPath("acme/beta"), () =>
      jsonResponse(200, [issuePayload({ number: 7, state: "open", comments: 2 })]),
    );

    await runAdd(store, client, "acme/alpha");
    await runAdd(store, client, "acme/beta");
    expect(store.listRepos({ activeOnly: true }).map((r) => r.fullName)).toEqual(["acme/alpha", "acme/beta"]);

    const sync = await runSyncCommand(store, client, undefined);
    expect(sync.repos.map((r) => ({ repo: r.repo, opened: r.opened, error: r.error }))).toEqual([
      { repo: "acme/alpha", opened: 1, error: null },
      { repo: "acme/beta", opened: 1, error: null },
    ]);

    // Store holds the issues from both repos.
    const alpha = store.getRepoByFullName("acme/alpha")!;
    const beta = store.getRepoByFullName("acme/beta")!;
    expect(store.listIssues(alpha.id).map((i) => i.number)).toEqual([1, 2]);
    expect(store.listIssues(beta.id).map((i) => i.number)).toEqual([7]);

    // A brand-new issue that arrives closed is stored silently (no event); the
    // open ones emit `opened`. beta#7 arrived open: just `opened`.
    const digest = runDigest(store, {});
    expect(digest.mode).toBe("inbox");
    expect(digest.total).toBe(2);
    expect(digest.repos.map((r) => r.repo)).toEqual(["acme/alpha", "acme/beta"]);
    const types = digest.repos.flatMap((r) => r.groups.map((g) => g.type)).sort();
    expect(types).toEqual(["opened", "opened"]);

    // Inbox drains: a second digest is empty (events were marked seen).
    expect(runDigest(store, {}).total).toBe(0);
  });

  it("emits commented and closed_commented events on a follow-up sync across both repos", async () => {
    const fake = makeFakeFetch();
    allowAnyRepo(fake);
    const client = clientOver(fake);

    let alphaPage = [
      issuePayload({ number: 1, state: "open", comments: 0 }),
      issuePayload({ number: 2, state: "closed", state_reason: "completed", comments: 1 }),
    ];
    fake.on(issuesPath("acme/alpha"), () => jsonResponse(200, alphaPage));
    fake.on(issuesPath("acme/beta"), () =>
      jsonResponse(200, [issuePayload({ number: 7, state: "open", comments: 0 })]),
    );

    await runAdd(store, client, "acme/alpha");
    await runAdd(store, client, "acme/beta");
    await runSyncCommand(store, client, undefined);
    runDigest(store, {}); // drain the initial opened events.

    // alpha#1 gains a comment (open -> commented); alpha#2 gains a comment while
    // closed (-> closed_commented).
    alphaPage = [
      issuePayload({ number: 1, state: "open", comments: 1, updated_at: "2024-02-01T00:00:00Z" }),
      issuePayload({
        number: 2,
        state: "closed",
        state_reason: "completed",
        comments: 2,
        updated_at: "2024-02-01T00:00:00Z",
      }),
    ];
    await runSyncCommand(store, client, undefined);

    const digest = runDigest(store, {});
    const alphaGroup = digest.repos.find((r) => r.repo === "acme/alpha")!;
    expect(alphaGroup.groups.map((g) => g.type).sort()).toEqual(["closed_commented", "commented"]);
  });
});

describe("integration: incremental sync with ETag", () => {
  it("treats a 304 as a no-op and never advances bookkeeping (do not fetch twice)", async () => {
    const fake = makeFakeFetch();
    allowAnyRepo(fake);
    const client = clientOver(fake);

    const etag = '"etag-abc"';
    let firstList = true;
    fake.on(issuesPath("acme/alpha"), (_url, init) => {
      const ifNoneMatch = new Headers(init?.headers).get("If-None-Match");
      if (firstList) {
        firstList = false;
        return jsonResponse(200, [issuePayload({ number: 1, state: "open" })], { etag });
      }
      // The engine must send the stored etag back; honor it with a 304.
      expect(ifNoneMatch).toBe(etag);
      return jsonResponse(304, undefined);
    });

    await runAdd(store, client, "acme/alpha");

    const first = await runSyncCommand(store, client, undefined);
    expect(first.repos[0]).toMatchObject({ notModified: false, opened: 1 });

    const repoAfterFirst = store.getRepoByFullName("acme/alpha")!;
    expect(repoAfterFirst.etag).toBe(etag);
    const syncedAt = repoAfterFirst.lastSyncedAt;
    expect(syncedAt).not.toBeNull();
    runDigest(store, {}); // drain.

    const second = await runSyncCommand(store, client, undefined);
    expect(second.repos[0]).toMatchObject({ notModified: true, opened: 0, processed: 0 });

    // 304 path: bookkeeping is untouched and no new events were produced.
    const repoAfterSecond = store.getRepoByFullName("acme/alpha")!;
    expect(repoAfterSecond.lastSyncedAt).toBe(syncedAt);
    expect(repoAfterSecond.etag).toBe(etag);
    expect(runDigest(store, {}).total).toBe(0);
  });
});

describe("integration: change detection marks a compacted issue stale", () => {
  it("flips open->closed and bumps comment_count, emitting closed + commented and staling the compact", async () => {
    const fake = makeFakeFetch();
    allowAnyRepo(fake);
    const client = clientOver(fake);

    let page = [issuePayload({ number: 1, state: "open", comments: 0, updated_at: "2024-01-01T00:00:00Z" })];
    fake.on(issuesPath("acme/alpha"), () => jsonResponse(200, page));

    await runAdd(store, client, "acme/alpha");
    await runSyncCommand(store, client, undefined);
    runDigest(store, {}); // drain the opened event.

    // Persist a compact via the store so the change can be detected as staling.
    const repo = store.getRepoByFullName("acme/alpha")!;
    store.setCompact(repo.id, 1, { compact: "compact text", tldr: "a short tldr" });
    expect(store.getIssue(repo.id, 1)!.compactStale).toBe(false);

    // Flip the issue closed and add a comment; bump updated_at so the change is meaningful.
    page = [
      issuePayload({
        number: 1,
        state: "closed",
        state_reason: "completed",
        comments: 2,
        updated_at: "2024-03-01T00:00:00Z",
      }),
    ];
    const result = await runSyncCommand(store, client, undefined);
    expect(result.repos[0]).toMatchObject({ closed: 1, commented: 1 });

    const digest = runDigest(store, {});
    const types = digest.repos[0].groups.map((g) => g.type).sort();
    expect(types).toEqual(["closed", "closed_commented"]);

    // The previously-compacted issue is now stale.
    expect(store.getIssue(repo.id, 1)!.compactStale).toBe(true);
  });
});

describe("integration: compaction loop", () => {
  it("pending -> compacted via runCompactSet, repo-digest prefers the compact, then goes stale on change", async () => {
    const fake = makeFakeFetch();
    allowAnyRepo(fake);
    const client = clientOver(fake);

    let page = [issuePayload({ number: 1, state: "open", title: "Memory leak", body: "raw body text", comments: 0 })];
    fake.on(issuesPath("acme/alpha"), () => jsonResponse(200, page));

    await runAdd(store, client, "acme/alpha");
    await runSyncCommand(store, client, undefined);

    // Pending list shows the uncompacted issue.
    let pending = runCompactList(store, { pending: true });
    expect(pending.map((i) => ({ repo: i.repo, number: i.number, status: i.status }))).toEqual([
      { repo: "acme/alpha", number: 1, status: "uncompacted" },
    ]);

    // repo-digest falls back to the raw body before compaction.
    let rd = runRepoDigest(store, "acme/alpha");
    expect(rd.issues[0]).toMatchObject({ compacted: false, representation: "raw body text" });
    expect(rd.summary).toMatchObject({ compacted: 0, staleOrUncompacted: 1 });

    // Persist a compact from a real temp file via the real action.
    const compactFile = join(tmpDir, "compact.md");
    writeFileSync(
      compactFile,
      [
        "---",
        "status: open",
        "state_reason: null",
        "---",
        "tldr: leaks one connection per request",
        "",
        "problem: connections are never released.",
      ].join("\n"),
    );
    const set = runCompactSet(store, "acme/alpha#1", { fromFile: compactFile });
    expect(set).toMatchObject({ ok: true, repo: "acme/alpha", number: 1, tldr: "leaks one connection per request" });

    // Pending no longer lists it.
    pending = runCompactList(store, { pending: true });
    expect(pending).toEqual([]);

    // repo-digest now prefers the compact representation.
    rd = runRepoDigest(store, "acme/alpha");
    expect(rd.issues[0]).toMatchObject({ compacted: true });
    expect(rd.issues[0].representation).toContain("tldr: leaks one connection per request");
    expect(rd.summary).toMatchObject({ compacted: 1, staleOrUncompacted: 0 });

    // A new comment via sync flips it stale: it shows up pending again and
    // repo-digest no longer prefers the (now stale) compact.
    page = [
      issuePayload({
        number: 1,
        state: "open",
        title: "Memory leak",
        body: "raw body text",
        comments: 1,
        updated_at: "2024-05-01T00:00:00Z",
      }),
    ];
    await runSyncCommand(store, client, undefined);

    pending = runCompactList(store, { pending: true });
    expect(pending.map((i) => i.status)).toEqual(["stale"]);

    rd = runRepoDigest(store, "acme/alpha");
    expect(rd.issues[0]).toMatchObject({ compacted: false, stale: true, representation: "raw body text" });
  });
});

describe("integration: refs + show", () => {
  it("stores parsed refs, surfaces them in show, and caches comments on first --raw", async () => {
    const fake = makeFakeFetch();
    allowAnyRepo(fake);
    const client = clientOver(fake);

    fake.on(issuesPath("acme/alpha"), () =>
      jsonResponse(200, [
        issuePayload({
          number: 5,
          state: "open",
          comments: 1,
          body: "Related to #123 and owner/repo#45 for context.",
        }),
      ]),
    );

    let commentFetches = 0;
    fake.on(
      (url) => url.includes("/issues/5/comments"),
      () => {
        commentFetches += 1;
        return jsonResponse(200, [
          {
            id: 1001,
            user: { login: "reviewer" },
            created_at: "2024-02-01T00:00:00Z",
            updated_at: "2024-02-01T00:00:00Z",
            body: "Confirmed on main.",
          },
        ]);
      },
    );

    await runAdd(store, client, "acme/alpha");
    await runSyncCommand(store, client, undefined);

    // Refs were parsed from the body and persisted during sync.
    const repo = store.getRepoByFullName("acme/alpha")!;
    const issue = store.getIssue(repo.id, 5)!;
    expect(store.listIssueRefs(issue.id).map((r) => r.target)).toEqual(["owner/repo#45", "#123"]);

    // show (no token needed) surfaces the refs.
    const shown = await runShow(store, "acme/alpha#5", {});
    expect(shown.refs).toEqual(["owner/repo#45", "#123"]);
    expect(shown.comments).toBeUndefined();

    // show --raw fetches comments via the client and caches them.
    const raw1 = await runShow(store, "acme/alpha#5", { raw: true }, client);
    expect(raw1.comments?.map((c) => c.body)).toEqual(["Confirmed on main."]);
    expect(commentFetches).toBe(1);
    expect(store.getIssue(repo.id, 5)!.rawComments).not.toBeNull();

    // A second show --raw uses the cache: no refetch.
    const raw2 = await runShow(store, "acme/alpha#5", { raw: true }, client);
    expect(raw2.comments?.map((c) => c.body)).toEqual(["Confirmed on main."]);
    expect(commentFetches).toBe(1);
  });
});

describe("integration: resilient sync", () => {
  it("isolates one repo's failure: the other still syncs and the failed repo's bookkeeping is untouched", async () => {
    const fake = makeFakeFetch();
    allowAnyRepo(fake);
    const client = clientOver(fake);

    // alpha fails (404 -> the client throws); beta succeeds.
    fake.on(issuesPath("acme/alpha"), () => jsonResponse(404, { message: "Not Found" }));
    fake.on(issuesPath("acme/beta"), () => jsonResponse(200, [issuePayload({ number: 9, state: "open" })]));

    await runAdd(store, client, "acme/alpha");
    await runAdd(store, client, "acme/beta");

    const result = await runSyncCommand(store, client, undefined);
    const byRepo = new Map(result.repos.map((r) => [r.repo, r]));
    expect(byRepo.get("acme/alpha")!.error).toBeTruthy();
    expect(byRepo.get("acme/alpha")!.processed).toBe(0);
    expect(byRepo.get("acme/beta")!).toMatchObject({ error: null, opened: 1 });

    // The healthy repo synced its issue and produced an event.
    const beta = store.getRepoByFullName("acme/beta")!;
    expect(store.listIssues(beta.id).map((i) => i.number)).toEqual([9]);
    expect(runDigest(store, { repo: "acme/beta" }).total).toBe(1);

    // The failing repo never advanced its etag/last_synced_at, so a retry is clean.
    const alpha = store.getRepoByFullName("acme/alpha")!;
    expect(alpha.lastSyncedAt).toBeNull();
    expect(alpha.etag).toBeNull();
    expect(store.listIssues(alpha.id)).toEqual([]);
  });
});

describe("integration: pagination via Link headers", () => {
  it("follows rel=next across pages and mirrors every issue (do not fetch twice across reruns)", async () => {
    const fake = makeFakeFetch();
    allowAnyRepo(fake);
    const client = clientOver(fake);

    const page2Url = `${API_URL}/repos/acme/alpha/issues?page=2`;
    fake.on(
      (url) => url.startsWith(issuesPath("acme/alpha")) && !url.includes("page=2"),
      () =>
        jsonResponse(200, [issuePayload({ number: 1, state: "open" }), issuePayload({ number: 2, state: "open" })], {
          link: `<${page2Url}>; rel="next"`,
          etag: '"page-etag"',
        }),
    );
    fake.on(
      (url) => url === page2Url,
      () => jsonResponse(200, [issuePayload({ number: 3, state: "open" })]),
    );

    await runAdd(store, client, "acme/alpha");
    const result = await runSyncCommand(store, client, undefined);
    expect(result.repos[0]).toMatchObject({ processed: 3, opened: 3 });

    const repo = store.getRepoByFullName("acme/alpha")!;
    expect(store.listIssues(repo.id).map((i) => i.number)).toEqual([1, 2, 3]);
    // The etag captured from page 1 is stored for the next conditional request.
    expect(repo.etag).toBe('"page-etag"');
  });
});
