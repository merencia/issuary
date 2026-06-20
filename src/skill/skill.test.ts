import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SKILL_DESCRIPTION, SKILL_MD, SKILL_NAME } from "./skill.js";

/** Extracts the YAML frontmatter block (between the first two `---` fences). */
function frontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match, "SKILL.md must start with a YAML frontmatter block").not.toBeNull();
  return parse(match![1]) as Record<string, unknown>;
}

describe("SKILL_MD", () => {
  it("has valid frontmatter with name lore and a non-empty description", () => {
    const fm = frontmatter(SKILL_MD);
    expect(fm.name).toBe("lore");
    expect(fm.name).toBe(SKILL_NAME);
    expect(typeof fm.description).toBe("string");
    expect((fm.description as string).trim().length).toBeGreaterThan(0);
    expect(fm.description).toBe(SKILL_DESCRIPTION);
  });

  it("mentions the key loop commands so it cannot silently drift", () => {
    expect(SKILL_MD).toContain("lore protocol");
    expect(SKILL_MD).toContain("compact list --pending");
    expect(SKILL_MD).toContain("lore show <owner/repo>#<n> --raw --json");
    expect(SKILL_MD).toContain("lore compact set <owner/repo>#<n> --from-file <file>");
  });

  it("tells the agent to defer to lore --help and lore protocol for exact flags", () => {
    expect(SKILL_MD).toContain("lore --help");
    expect(SKILL_MD).toContain("lore protocol");
  });

  it("never uses the em dash character", () => {
    expect(SKILL_MD).not.toContain("—");
  });
});
