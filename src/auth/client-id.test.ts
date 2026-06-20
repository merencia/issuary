import { describe, expect, it } from "vitest";
import { DEFAULT_GITHUB_CLIENT_ID, DEFAULT_SCOPE, resolveClientId, resolveScope } from "./client-id.js";
import { AuthError } from "./errors.js";

describe("resolveClientId", () => {
  it("uses ISSUARY_GITHUB_CLIENT_ID when set", () => {
    expect(resolveClientId({ ISSUARY_GITHUB_CLIENT_ID: "cid123" })).toBe("cid123");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveClientId({ ISSUARY_GITHUB_CLIENT_ID: "  cid123  " })).toBe("cid123");
  });

  it("falls back to the baked client id when no env override is set", () => {
    expect(DEFAULT_GITHUB_CLIENT_ID).not.toBe("");
    expect(resolveClientId({})).toBe(DEFAULT_GITHUB_CLIENT_ID);
  });

  it("throws AuthError when neither env nor a baked default is configured", () => {
    expect(() => resolveClientId({}, "")).toThrow(AuthError);
  });

  it("mentions ISSUARY_GITHUB_CLIENT_ID in the error", () => {
    let message = "";
    try {
      resolveClientId({}, "");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("ISSUARY_GITHUB_CLIENT_ID");
  });
});

describe("resolveScope", () => {
  it("defaults to repo", () => {
    expect(resolveScope({})).toBe(DEFAULT_SCOPE);
    expect(resolveScope({})).toBe("repo");
  });

  it("honors ISSUARY_GITHUB_SCOPE override", () => {
    expect(resolveScope({ ISSUARY_GITHUB_SCOPE: "public_repo" })).toBe("public_repo");
  });
});
