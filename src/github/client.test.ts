import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient, parseRepo } from "./client.js";
import { GitHubError } from "./errors.js";

interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Builds a Response-like object good enough for the client. */
function mockResponse({ status = 200, body, headers = {} }: MockResponseInit): Response {
  const h = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: h,
    json: async () => body,
  } as unknown as Response;
}

function makeClient(fetchImpl: typeof fetch) {
  return createGitHubClient({ token: "ghp_test", apiUrl: "https://api.github.com", fetch: fetchImpl });
}

const issuePayload = {
  number: 1,
  title: "Bug in timezone handling",
  state: "closed",
  state_reason: "completed",
  user: { login: "alice" },
  labels: [{ name: "bug" }, { name: "timezone" }],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  closed_at: "2024-01-03T00:00:00Z",
  comments: 4,
  body: "It breaks across DST.",
};

const pullRequestPayload = {
  number: 2,
  title: "Fix the timezone bug",
  state: "open",
  user: { login: "bob" },
  labels: [],
  created_at: "2024-01-04T00:00:00Z",
  updated_at: "2024-01-04T00:00:00Z",
  closed_at: null,
  comments: 0,
  body: "PR body",
  pull_request: { url: "https://api.github.com/repos/o/r/pulls/2" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRepo", () => {
  it("parses the owner/name shorthand", () => {
    expect(parseRepo("octocat/hello-world")).toEqual({ owner: "octocat", name: "hello-world" });
  });

  it("passes through an object ref", () => {
    expect(parseRepo({ owner: "o", name: "n" })).toEqual({ owner: "o", name: "n" });
  });

  it("throws on a malformed string", () => {
    expect(() => parseRepo("nope")).toThrow(GitHubError);
    expect(() => parseRepo("a/b/c")).toThrow(GitHubError);
  });
});

describe("listIssues", () => {
  it("normalizes a 200 response, filters PRs, and returns the etag", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        body: [issuePayload, pullRequestPayload],
        headers: { etag: 'W/"abc123"' },
      }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.listIssues("octocat/hello-world");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.etag).toBe('W/"abc123"');
    expect(result.issues).toHaveLength(1);

    const issue = result.issues[0];
    expect(issue.number).toBe(1);
    expect(issue.state).toBe("closed");
    expect(issue.state_reason).toBe("completed");
    expect(issue.author).toBe("alice");
    expect(issue.labels).toEqual(["bug", "timezone"]);
    expect(issue.comment_count).toBe(4);
    expect(issue.closed_at).toBe("2024-01-03T00:00:00Z");
    expect(issue.body).toBe("It breaks across DST.");
  });

  it("requests state=all, per_page=100, sort=updated, direction=asc", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ body: [] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.listIssues("octocat/hello-world");

    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/repos/octocat/hello-world/issues");
    expect(url).toContain("state=all");
    expect(url).toContain("per_page=100");
    expect(url).toContain("sort=updated");
    expect(url).toContain("direction=asc");
  });

  it("includes since when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ body: [] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.listIssues("octocat/hello-world", { since: "2024-05-01T00:00:00Z" });

    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("since=2024-05-01");
  });

  it("sends required auth and version headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ body: [] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.listIssues("o/n");

    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer ghp_test");
    expect(init.headers.Accept).toBe("application/vnd.github+json");
    expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(init.headers["User-Agent"]).toBeTruthy();
  });

  it("sends If-None-Match when an etag is provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ body: [] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.listIssues("o/n", { etag: 'W/"prev"' });

    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(init.headers["If-None-Match"]).toBe('W/"prev"');
  });

  it("returns notModified on 304 without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ status: 304 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.listIssues("o/n", { etag: 'W/"prev"' });

    expect(result.status).toBe("notModified");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows pagination across two pages via the Link header", async () => {
    const page2Url = "https://api.github.com/repos/o/n/issues?page=2";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          body: [{ ...issuePayload, number: 1 }],
          headers: { etag: 'W/"p1"', link: `<${page2Url}>; rel="next", <${page2Url}>; rel="last"` },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ body: [{ ...issuePayload, number: 2 }] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.listIssues("o/n");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String((fetchImpl.mock.calls[1] as unknown[])[0])).toBe(page2Url);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.issues.map((i) => i.number)).toEqual([1, 2]);
    // etag comes from the first page only.
    expect(result.etag).toBe('W/"p1"');
  });

  it("does not resend If-None-Match on the second page", async () => {
    const page2Url = "https://api.github.com/repos/o/n/issues?page=2";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ body: [], headers: { link: `<${page2Url}>; rel="next"` } }))
      .mockResolvedValueOnce(mockResponse({ body: [] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.listIssues("o/n", { etag: 'W/"prev"' });

    const init2 = (fetchImpl.mock.calls[1] as unknown[])[1] as { headers: Record<string, string> };
    expect(init2.headers["If-None-Match"]).toBeUndefined();
  });

  it("parses rate-limit headers onto the client", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        body: [],
        headers: { "x-ratelimit-remaining": "57", "x-ratelimit-reset": "1700000000" },
      }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.listIssues("o/n");

    expect(client.rateLimit).toEqual({ remaining: 57, reset: 1700000000 });
  });
});

describe("getComments", () => {
  it("normalizes and paginates comments", async () => {
    const page2Url = "https://api.github.com/repos/o/n/issues/5/comments?page=2";
    const comment = (id: number, login: string | null) => ({
      id,
      user: login ? { login } : null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      body: `c${id}`,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({ body: [comment(10, "alice")], headers: { link: `<${page2Url}>; rel="next"` } }),
      )
      .mockResolvedValueOnce(mockResponse({ body: [comment(11, null)] }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const comments = await client.getComments("o/n", 5);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("/issues/5/comments");
    expect(comments).toEqual([
      { id: 10, author: "alice", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", body: "c10" },
      { id: 11, author: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", body: "c11" },
    ]);
  });
});

describe("error mapping", () => {
  it("throws GitHubError with status on 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ status: 401, body: { message: "Bad credentials" } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.listIssues("o/n")).rejects.toMatchObject({
      name: "GitHubError",
      status: 401,
    });
  });

  it("throws GitHubError with status on 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ status: 404, body: { message: "Not Found" } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.listIssues("o/n")).rejects.toMatchObject({ status: 404 });
  });

  it("reports a rate-limit message on a 403 with remaining 0", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
      }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.listIssues("o/n")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("rate limit"),
      rateLimit: { remaining: 0, reset: 1700000000 },
    });
  });
});
