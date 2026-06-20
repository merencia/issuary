import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/index.js";
import { RepoCommandError } from "./add.js";
import { runRemove } from "./remove.js";

describe("runRemove", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("deactivates a watched repo without deleting it", () => {
    const repo = store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
    store.upsertIssue({
      repoId: repo.id,
      number: 1,
      title: "keep me",
      state: "open",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    const result = runRemove(store, "octo/demo");

    expect(result).toEqual({ ok: true, repo: "octo/demo", status: "removed" });
    expect(store.getRepoByFullName("octo/demo")?.active).toBe(false);
    // History is preserved.
    expect(store.getIssue(repo.id, 1)?.title).toBe("keep me");
  });

  it("is idempotent for an already-inactive repo", () => {
    store.insertRepo({ owner: "octo", name: "demo", fullName: "octo/demo" });
    runRemove(store, "octo/demo");

    const result = runRemove(store, "octo/demo");
    expect(result).toEqual({ ok: true, repo: "octo/demo", status: "already-inactive" });
  });

  it("errors when the repo is not watched", () => {
    expect(() => runRemove(store, "ghost/repo")).toThrow(RepoCommandError);
    expect(() => runRemove(store, "ghost/repo")).toThrow(/not watched/);
  });

  it("rejects a malformed arg", () => {
    expect(() => runRemove(store, "not-a-repo")).toThrow(/owner\/repo/);
  });
});
