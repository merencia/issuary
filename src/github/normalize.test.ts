import { describe, expect, it } from "vitest";
import { isPullRequest, normalizeComment, normalizeIssue } from "./normalize.js";

describe("normalizeIssue", () => {
  it("maps a full payload", () => {
    const result = normalizeIssue({
      number: 7,
      title: "Title",
      state: "open",
      state_reason: null,
      user: { login: "alice" },
      labels: [{ name: "bug" }, { name: "p1" }],
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      closed_at: null,
      comments: 3,
      body: "Body",
    });
    expect(result).toEqual({
      number: 7,
      title: "Title",
      state: "open",
      state_reason: null,
      author: "alice",
      labels: ["bug", "p1"],
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      closed_at: null,
      comment_count: 3,
      body: "Body",
    });
  });

  it("keeps known state_reason values and nulls unknown ones", () => {
    expect(normalizeIssue({ state_reason: "completed" }).state_reason).toBe("completed");
    expect(normalizeIssue({ state_reason: "not_planned" }).state_reason).toBe("not_planned");
    expect(normalizeIssue({ state_reason: "reopened" }).state_reason).toBeNull();
    expect(normalizeIssue({}).state_reason).toBeNull();
  });

  it("falls back to open for unexpected state", () => {
    expect(normalizeIssue({ state: "closed" }).state).toBe("closed");
    expect(normalizeIssue({ state: "weird" }).state).toBe("open");
  });

  it("handles a deleted author (null user)", () => {
    expect(normalizeIssue({ user: null }).author).toBeNull();
    expect(normalizeIssue({}).author).toBeNull();
  });

  it("returns an empty label array when labels are missing", () => {
    expect(normalizeIssue({}).labels).toEqual([]);
    expect(normalizeIssue({ labels: [{ name: "x" }, {}] }).labels).toEqual(["x"]);
  });

  it("treats an empty body as null", () => {
    expect(normalizeIssue({ body: null }).body).toBeNull();
    expect(normalizeIssue({}).body).toBeNull();
  });
});

describe("normalizeComment", () => {
  it("maps a comment payload", () => {
    expect(
      normalizeComment({
        id: 99,
        user: { login: "bob" },
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        body: "hi",
      }),
    ).toEqual({
      id: 99,
      author: "bob",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      body: "hi",
    });
  });
});

describe("isPullRequest", () => {
  it("detects items with a pull_request field", () => {
    expect(isPullRequest({ pull_request: { url: "x" } })).toBe(true);
    expect(isPullRequest({})).toBe(false);
    expect(isPullRequest({ pull_request: null })).toBe(false);
  });
});
