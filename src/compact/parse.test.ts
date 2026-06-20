import { describe, expect, it } from "vitest";
import { CompactValidationError, parseCompact } from "./parse.js";

const CLOSED_BUG = `---
status: closed
state_reason: completed
refs: ["#812", "PR #820"]
versions: { affected: "2.2.0", fixed: "2.3.0" }
labels: [bug, timezone, regression]
---
tldr: Daily digest fired one hour early for users in DST timezones.

problem: Scheduler computed the next run in UTC then applied the offset twice.
status_detail: fixed in v2.3.0; released.
decisions: Normalize schedule math to the user's IANA zone before comparing.
open_questions: null
`;

const OPEN_FEATURE = `---
status: open
state_reason: null
refs: ["owner/repo#45"]
labels: [enhancement, digest]
---
tldr: Request to group the digest by team or label instead of a flat list.

problem: Large multi-repo setups produce a long flat digest.
status_detail: in discussion; no implementation started.
decisions: null
open_questions: Group by label, by repo topic, or by a user map?
`;

describe("parseCompact", () => {
  it("parses a valid closed bug and extracts the tldr", () => {
    const result = parseCompact(CLOSED_BUG);
    expect(result.tldr).toBe("Daily digest fired one hour early for users in DST timezones.");
    expect(result.compact).toBe(CLOSED_BUG);
    expect(result.frontmatter.status).toBe("closed");
    expect(result.frontmatter.stateReason).toBe("completed");
    expect(result.frontmatter.refs).toEqual(["#812", "PR #820"]);
    expect(result.frontmatter.versions).toEqual({ affected: "2.2.0", fixed: "2.3.0" });
    expect(result.frontmatter.labels).toEqual(["bug", "timezone", "regression"]);
  });

  it("parses a valid open feature with null state_reason and no versions", () => {
    const result = parseCompact(OPEN_FEATURE);
    expect(result.tldr).toBe("Request to group the digest by team or label instead of a flat list.");
    expect(result.frontmatter.status).toBe("open");
    expect(result.frontmatter.stateReason).toBeNull();
    expect(result.frontmatter.versions).toBeUndefined();
    expect(result.frontmatter.refs).toEqual(["owner/repo#45"]);
  });

  it("preserves the full original text for round-tripping", () => {
    expect(parseCompact(CLOSED_BUG).compact).toBe(CLOSED_BUG);
  });

  it("tolerates leading blank lines before the frontmatter fence", () => {
    const result = parseCompact(`\n\n${OPEN_FEATURE}`);
    expect(result.frontmatter.status).toBe("open");
  });

  describe("validation failures", () => {
    it("rejects missing opening fence", () => {
      expect(() => parseCompact("tldr: x\nproblem: y")).toThrow(CompactValidationError);
      expect(() => parseCompact("tldr: x")).toThrow(/start with a `---`/);
    });

    it("rejects missing closing fence", () => {
      expect(() => parseCompact("---\nstatus: open\nstate_reason: null\ntldr: x")).toThrow(/closing `---`/);
    });

    it("rejects a missing status field", () => {
      const text = `---\nstate_reason: null\n---\ntldr: x`;
      expect(() => parseCompact(text)).toThrow(/missing the required `status`/);
    });

    it("rejects an invalid status value", () => {
      const text = `---\nstatus: pending\nstate_reason: null\n---\ntldr: x`;
      expect(() => parseCompact(text)).toThrow(/`status` must be one of/);
    });

    it("rejects a missing state_reason field", () => {
      const text = `---\nstatus: open\n---\ntldr: x`;
      expect(() => parseCompact(text)).toThrow(/missing the required `state_reason`/);
    });

    it("rejects an invalid state_reason value", () => {
      const text = `---\nstatus: closed\nstate_reason: done\n---\ntldr: x`;
      expect(() => parseCompact(text)).toThrow(/`state_reason` must be one of/);
    });

    it("rejects state_reason on an open issue", () => {
      const text = `---\nstatus: open\nstate_reason: completed\n---\ntldr: x`;
      expect(() => parseCompact(text)).toThrow(/open issue must have `state_reason: null`/);
    });

    it("rejects a missing tldr", () => {
      const text = `---\nstatus: open\nstate_reason: null\n---\nproblem: y`;
      expect(() => parseCompact(text)).toThrow(/missing the required `tldr`/);
    });

    it("rejects an empty tldr", () => {
      const text = `---\nstatus: open\nstate_reason: null\n---\ntldr:   `;
      expect(() => parseCompact(text)).toThrow(/`tldr` must be a non-empty single line/);
    });

    it("rejects a null tldr", () => {
      const text = `---\nstatus: open\nstate_reason: null\n---\ntldr: null`;
      expect(() => parseCompact(text)).toThrow(/`tldr` must not be null/);
    });

    it("rejects non-string refs", () => {
      const text = `---\nstatus: open\nstate_reason: null\nrefs: [1, 2]\n---\ntldr: x`;
      expect(() => parseCompact(text)).toThrow(/`refs` must be a list of strings/);
    });

    it("rejects a non-object versions field", () => {
      const text = `---\nstatus: open\nstate_reason: null\nversions: "2.0"\n---\ntldr: x`;
      expect(() => parseCompact(text)).toThrow(/`versions` must be an object/);
    });

    it("rejects malformed yaml frontmatter", () => {
      const text = `---\nstatus: [open\n---\ntldr: x`;
      expect(() => parseCompact(text)).toThrow(CompactValidationError);
    });
  });
});
