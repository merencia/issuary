import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPE, resolveClientId, resolveScope } from "./client-id.js";
import { AuthError } from "./errors.js";

describe("resolveClientId", () => {
  it("uses LORE_GITHUB_CLIENT_ID when set", () => {
    expect(resolveClientId({ LORE_GITHUB_CLIENT_ID: "cid123" })).toBe("cid123");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveClientId({ LORE_GITHUB_CLIENT_ID: "  cid123  " })).toBe("cid123");
  });

  it("throws AuthError when no client id is configured", () => {
    // DEFAULT_GITHUB_CLIENT_ID is empty in the repo, so an empty env throws.
    expect(() => resolveClientId({})).toThrow(AuthError);
  });

  it("mentions LORE_GITHUB_CLIENT_ID in the error", () => {
    let message = "";
    try {
      resolveClientId({});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("LORE_GITHUB_CLIENT_ID");
  });
});

describe("resolveScope", () => {
  it("defaults to repo", () => {
    expect(resolveScope({})).toBe(DEFAULT_SCOPE);
    expect(resolveScope({})).toBe("repo");
  });

  it("honors LORE_GITHUB_SCOPE override", () => {
    expect(resolveScope({ LORE_GITHUB_SCOPE: "public_repo" })).toBe("public_repo");
  });
});
