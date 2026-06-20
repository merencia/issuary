import pc from "picocolors";
import { describe, expect, it } from "vitest";
import { compactMark, stateBadge } from "./index.js";
import { bold, cyan, dim, enabled, green, red, yellow } from "./style.js";

/** Matches any ANSI escape sequence. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[/;

describe("style (resolved disabled in vitest's non-TTY env)", () => {
  it("is disabled because stdout is not a TTY", () => {
    expect(enabled).toBe(false);
  });

  it("every wrapper returns the raw string with no ANSI when disabled", () => {
    for (const wrap of [bold, dim, green, red, yellow, cyan]) {
      expect(wrap("plain")).toBe("plain");
      expect(ANSI.test(wrap("plain"))).toBe(false);
    }
  });

  it("stateBadge produces plain open/closed text when disabled", () => {
    expect(stateBadge("open")).toBe("open");
    expect(stateBadge("closed")).toBe("closed");
  });

  it("compactMark produces the expected plain markers when disabled", () => {
    expect(compactMark({ compacted: true, stale: false })).toBe("");
    expect(compactMark({ compacted: false, stale: true })).toBe(" (stale)");
    expect(compactMark({ compacted: false, stale: false })).toBe(" (uncompacted)");
  });
});

describe("style (color forced on via picocolors.createColors)", () => {
  it("emits an ANSI escape when a palette is created with color enabled", () => {
    // Prove the wiring: with color forced on, picocolors decorates the string.
    const colors = pc.createColors(true);
    expect(ANSI.test(colors.green("x"))).toBe(true);
    expect(ANSI.test(colors.bold("x"))).toBe(true);
  });
});
