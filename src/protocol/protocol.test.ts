import { describe, expect, it } from "vitest";
import { COMPACT_FORMAT_DOC, COMPACT_FORMAT_SPEC, COMPACTION_PROTOCOL } from "./protocol.js";

describe("COMPACTION_PROTOCOL", () => {
  it("describes the two fields each issue exposes", () => {
    expect(COMPACTION_PROTOCOL).toContain("compact");
    expect(COMPACTION_PROTOCOL).toContain("compact_stale");
  });

  it("states rule 1: use the compact when present and not stale", () => {
    expect(COMPACTION_PROTOCOL).toContain("compact != null AND compact_stale == false");
    expect(COMPACTION_PROTOCOL).toMatch(/USE the compact/);
    expect(COMPACTION_PROTOCOL).toMatch(/do not recompact/i);
  });

  it("states rule 2: recompact when missing or stale", () => {
    expect(COMPACTION_PROTOCOL).toContain("compact == null OR compact_stale == true");
    expect(COMPACTION_PROTOCOL).toMatch(/read raw_body and raw_comments/);
  });

  it("names the persistence command that clears the stale flag", () => {
    expect(COMPACTION_PROTOCOL).toContain("lore compact set <owner/repo>#<n> --from-file <file>");
    expect(COMPACTION_PROTOCOL).toMatch(/clears the stale flag/);
  });

  it("states what a compact must preserve", () => {
    expect(COMPACTION_PROTOCOL).toMatch(/state_reason/);
    expect(COMPACTION_PROTOCOL).toMatch(/copied verbatim from the GitHub API/);
    expect(COMPACTION_PROTOCOL).toMatch(/preserved literally/);
  });

  it("points to the full canonical spec", () => {
    expect(COMPACTION_PROTOCOL).toContain("docs/compact-format.md");
  });

  it("never uses the em dash character", () => {
    expect(COMPACTION_PROTOCOL).not.toContain("\u2014");
  });
});

describe("COMPACT_FORMAT_SPEC", () => {
  it("points to the canonical document", () => {
    expect(COMPACT_FORMAT_SPEC.doc).toBe(COMPACT_FORMAT_DOC);
    expect(COMPACT_FORMAT_DOC).toBe("docs/compact-format.md");
  });

  it("lists the frontmatter fields in fixed order", () => {
    expect(COMPACT_FORMAT_SPEC.frontmatterFields).toEqual(["status", "state_reason", "refs", "versions", "labels"]);
  });

  it("lists the body fields in fixed order", () => {
    expect(COMPACT_FORMAT_SPEC.bodyFields).toEqual(["tldr", "problem", "status_detail", "decisions", "open_questions"]);
  });

  it("carries the persistence command", () => {
    expect(COMPACT_FORMAT_SPEC.persistCommand).toBe("lore compact set <owner/repo>#<n> --from-file <file>");
  });
});
