import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubError, type GitHubClient, type RepoInfo } from "../github/index.js";
import { openStore, type Store } from "../store/index.js";
import { parseRepoArg, RepoCommandError, runAdd } from "./add.js";

/** A GitHub client stub: getRepo resolves unless told to 404. */
function fakeClient(options: { notFound?: boolean } = {}): GitHubClient {
  return {
    async getRepo(repo): Promise<RepoInfo> {
      if (options.notFound) {
        throw new GitHubError("GitHub request failed with 404: Not Found.", 404);
      }
      const fullName = typeof repo === "string" ? repo : `${repo.owner}/${repo.name}`;
      const [owner, name] = fullName.split("/");
      return { owner, name, fullName, private: false };
    },
    listIssues: async () => {
      throw new Error("not used");
    },
    getComments: async () => {
      throw new Error("not used");
    },
    rateLimit: null,
  };
}

describe("parseRepoArg", () => {
  it("parses owner/repo", () => {
    expect(parseRepoArg("octocat/hello")).toEqual({
      owner: "octocat",
      name: "hello",
      fullName: "octocat/hello",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseRepoArg("  octo/demo ")).toEqual({ owner: "octo", name: "demo", fullName: "octo/demo" });
  });

  it.each(["octocat", "octocat/", "/hello", "a/b/c", "octo hub/repo"])("rejects malformed arg %s", (arg) => {
    expect(() => parseRepoArg(arg)).toThrow(RepoCommandError);
  });
});

describe("runAdd", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("validates and inserts a new repo", async () => {
    const result = await runAdd(store, fakeClient(), "octo/demo");

    expect(result).toEqual({ ok: true, repo: "octo/demo", status: "added" });
    const repo = store.getRepoByFullName("octo/demo");
    expect(repo?.active).toBe(true);
    expect(repo?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("errors when the repo 404s", async () => {
    await expect(runAdd(store, fakeClient({ notFound: true }), "octo/missing")).rejects.toThrow(RepoCommandError);
    await expect(runAdd(store, fakeClient({ notFound: true }), "octo/missing")).rejects.toThrow(
      /not found or no access/,
    );
    expect(store.getRepoByFullName("octo/missing")).toBeUndefined();
  });

  it("reports an already-watched active repo without changing it", async () => {
    await runAdd(store, fakeClient(), "octo/demo");
    const result = await runAdd(store, fakeClient(), "octo/demo");

    expect(result).toEqual({ ok: true, repo: "octo/demo", status: "already-watched" });
    expect(store.listRepos()).toHaveLength(1);
  });

  it("reactivates an inactive repo", async () => {
    store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
    store.setRepoActive("octo/demo", false);

    const result = await runAdd(store, fakeClient(), "octo/demo");

    expect(result).toEqual({ ok: true, repo: "octo/demo", status: "reactivated" });
    expect(store.getRepoByFullName("octo/demo")?.active).toBe(true);
    expect(store.listRepos()).toHaveLength(1);
  });

  it("propagates non-404 GitHub errors", async () => {
    const client: GitHubClient = {
      async getRepo(): Promise<RepoInfo> {
        throw new GitHubError("GitHub request failed with 401.", 401);
      },
      listIssues: async () => {
        throw new Error("not used");
      },
      getComments: async () => {
        throw new Error("not used");
      },
      rateLimit: null,
    };

    await expect(runAdd(store, client, "octo/demo")).rejects.toMatchObject({ name: "GitHubError", status: 401 });
  });

  it("rejects a malformed arg before touching the client", async () => {
    await expect(runAdd(store, fakeClient(), "not-a-repo")).rejects.toThrow(/owner\/repo/);
  });
});
