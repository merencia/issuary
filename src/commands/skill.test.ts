import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_DESCRIPTION, SKILL_MD, SKILL_NAME, type SkillJson } from "../skill/index.js";
import { AGENTS_END_MARKER, AGENTS_START_MARKER, runSkill, type SkillInstallResult } from "./skill.js";

describe("runSkill", () => {
  it("returns the SKILL.md text by default", async () => {
    expect(await runSkill()).toBe(SKILL_MD);
  });

  it("returns the SKILL.md text when no options are set", async () => {
    expect(await runSkill({})).toBe(SKILL_MD);
  });

  it("returns the structured payload with --json (format defaults to claude)", async () => {
    const dir = join(tmpdir(), "lore-skill-json");
    const json = (await runSkill({ json: true, dir })) as SkillJson;
    expect(json).toEqual({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      path: join(dir, SKILL_NAME, "SKILL.md"),
      content: SKILL_MD,
      format: "claude",
    });
  });

  it("emits json that round-trips through JSON.stringify", async () => {
    const json = (await runSkill({ json: true })) as SkillJson;
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it("rejects an unknown format", async () => {
    await expect(runSkill({ format: "bogus" })).rejects.toThrow(/Unknown skill format/);
    await expect(runSkill({ install: true, format: "bogus" })).rejects.toThrow(/Unknown skill format/);
  });

  describe("--install (claude, default format)", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "lore-skill-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("defaults to the claude format and writes the SKILL.md path", async () => {
      const result = (await runSkill({ install: true, dir })) as SkillInstallResult;
      const expectedPath = join(dir, SKILL_NAME, "SKILL.md");
      expect(result.format).toBe("claude");
      expect(result.path).toBe(expectedPath);
      expect(result.overwrote).toBe(false);
      expect(await readFile(expectedPath, "utf8")).toBe(SKILL_MD);
    });

    it("writes the SKILL.md when format is explicitly claude", async () => {
      const result = (await runSkill({ install: true, format: "claude", dir })) as SkillInstallResult;
      expect(result.path).toBe(join(dir, SKILL_NAME, "SKILL.md"));
      expect(await readFile(result.path, "utf8")).toBe(SKILL_MD);
    });

    it("reports overwrote=true when the file already exists", async () => {
      const path = join(dir, SKILL_NAME, "SKILL.md");
      await runSkill({ install: true, dir });
      await writeFile(path, "stale content", "utf8");
      const result = (await runSkill({ install: true, dir })) as SkillInstallResult;
      expect(result.overwrote).toBe(true);
      expect(await readFile(path, "utf8")).toBe(SKILL_MD);
    });
  });

  describe("--install --format agents", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "lore-agents-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("creates AGENTS.md with a delimited lore section", async () => {
      const result = (await runSkill({ install: true, format: "agents", dir })) as SkillInstallResult;
      const expectedPath = join(dir, "AGENTS.md");
      expect(result.format).toBe("agents");
      expect(result.path).toBe(expectedPath);
      expect(result.overwrote).toBe(false);
      const content = await readFile(expectedPath, "utf8");
      expect(content).toContain(AGENTS_START_MARKER);
      expect(content).toContain(AGENTS_END_MARKER);
      expect(content).toContain(SKILL_MD);
    });

    it("is idempotent: running twice yields exactly one lore section", async () => {
      const path = join(dir, "AGENTS.md");
      await runSkill({ install: true, format: "agents", dir });
      const second = (await runSkill({ install: true, format: "agents", dir })) as SkillInstallResult;
      expect(second.overwrote).toBe(true);
      const content = await readFile(path, "utf8");
      expect(content.split(AGENTS_START_MARKER)).toHaveLength(2);
      expect(content.split(AGENTS_END_MARKER)).toHaveLength(2);
    });

    it("preserves unrelated existing AGENTS.md content", async () => {
      const path = join(dir, "AGENTS.md");
      const original = "# House rules\n\nUse tabs, not spaces.\n";
      await writeFile(path, original, "utf8");
      await runSkill({ install: true, format: "agents", dir });
      const content = await readFile(path, "utf8");
      expect(content).toContain("# House rules");
      expect(content).toContain("Use tabs, not spaces.");
      expect(content).toContain(AGENTS_START_MARKER);
      expect(content).toContain(SKILL_MD);
    });

    it("replaces only the lore section, leaving surrounding content intact", async () => {
      const path = join(dir, "AGENTS.md");
      await writeFile(path, "# Top\n", "utf8");
      await runSkill({ install: true, format: "agents", dir });
      const afterFirst = await readFile(path, "utf8");
      // Append something below the lore section, then re-install.
      await writeFile(path, `${afterFirst}\n# Bottom\n`, "utf8");
      await runSkill({ install: true, format: "agents", dir });
      const content = await readFile(path, "utf8");
      expect(content).toContain("# Top");
      expect(content).toContain("# Bottom");
      expect(content.split(AGENTS_START_MARKER)).toHaveLength(2);
    });
  });
});
