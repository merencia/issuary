import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_DESCRIPTION, SKILL_MD, SKILL_NAME, type SkillJson } from "../skill/index.js";
import { runSkill, type SkillInstallResult } from "./skill.js";

describe("runSkill", () => {
  it("returns the SKILL.md text by default", async () => {
    expect(await runSkill()).toBe(SKILL_MD);
  });

  it("returns the SKILL.md text when no options are set", async () => {
    expect(await runSkill({})).toBe(SKILL_MD);
  });

  it("returns the structured payload with --json", async () => {
    const dir = join(tmpdir(), "lore-skill-json");
    const json = (await runSkill({ json: true, dir })) as SkillJson;
    expect(json).toEqual({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      path: join(dir, SKILL_NAME, "SKILL.md"),
      content: SKILL_MD,
    });
  });

  it("emits json that round-trips through JSON.stringify", async () => {
    const json = (await runSkill({ json: true })) as SkillJson;
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  describe("--install", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "lore-skill-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("writes the SKILL.md under <dir>/lore/SKILL.md and returns the path", async () => {
      const result = (await runSkill({ install: true, dir })) as SkillInstallResult;
      const expectedPath = join(dir, SKILL_NAME, "SKILL.md");
      expect(result.path).toBe(expectedPath);
      expect(result.overwrote).toBe(false);
      expect(await readFile(expectedPath, "utf8")).toBe(SKILL_MD);
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
});
