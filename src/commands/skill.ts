import { Command } from "commander";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_DESCRIPTION, SKILL_MD, SKILL_NAME, type SkillJson } from "../skill/index.js";

/** Options accepted by {@link runSkill} and the `skill` command action. */
export interface SkillOptions {
  /** Write the `SKILL.md` to disk instead of just printing it. */
  install?: boolean;
  /** Override the skills directory (defaults to `~/.claude/skills`). */
  dir?: string;
  /** Emit machine-readable JSON instead of the document text. */
  json?: boolean;
}

/**
 * Resolves the skills root directory.
 *
 * Precedence: explicit `--dir`, then the `CLAUDE_SKILLS_DIR` environment
 * override, then the default `~/.claude/skills`.
 */
export function resolveSkillsDir(dir?: string): string {
  const fromEnv = (process.env.CLAUDE_SKILLS_DIR ?? "").trim();
  return (dir ?? "").trim() || fromEnv || join(homedir(), ".claude", "skills");
}

/**
 * Resolves the absolute path the skill's `SKILL.md` is (or would be) written to.
 *
 * @param dir - Optional skills directory override; see {@link resolveSkillsDir}.
 * @returns The absolute `SKILL.md` path under the resolved skills directory.
 */
export function resolveSkillPath(dir?: string): string {
  return join(resolveSkillsDir(dir), SKILL_NAME, "SKILL.md");
}

/** The result of {@link runSkill} when the skill is installed to disk. */
export interface SkillInstallResult {
  /** The absolute path the `SKILL.md` was written to. */
  path: string;
  /** Whether an existing file at that path was overwritten. */
  overwrote: boolean;
}

/**
 * Core action for `lore skill`.
 *
 * Separated from the Commander wiring so it can be tested without spawning a
 * process. Behavior by option:
 *
 * - default: returns the `SKILL.md` document text.
 * - `json`: returns the structured {@link SkillJson} payload.
 * - `install`: writes the `SKILL.md` to the resolved path (creating parent
 *   directories) and returns a {@link SkillInstallResult}.
 */
export async function runSkill(options: SkillOptions = {}): Promise<string | SkillJson | SkillInstallResult> {
  if (options.install) {
    const path = resolveSkillPath(options.dir);
    const overwrote = await fileExists(path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, SKILL_MD, "utf8");
    return { path, overwrote };
  }

  if (options.json) {
    const json: SkillJson = {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      path: resolveSkillPath(options.dir),
      content: SKILL_MD,
    };
    return json;
  }

  return SKILL_MD;
}

/** Returns whether a file already exists at the given path. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the `skill` command. It emits lore's installable agent skill
 * (a `SKILL.md`) so an AI coding agent can discover and operate lore.
 *
 * @see file://../skill/skill.ts
 */
export function skillCommand(): Command {
  return new Command("skill")
    .description("Print lore's agent skill (SKILL.md), or install it for an AI coding agent")
    .option("--install", "write the SKILL.md to the skills directory instead of printing it")
    .option("--dir <path>", "skills directory to install into (default ~/.claude/skills)")
    .option("--json", "emit machine-readable JSON ({ name, description, path, content })")
    .action(async (options: SkillOptions) => {
      const result = await runSkill(options);
      if (options.install) {
        const { path, overwrote } = result as SkillInstallResult;
        console.log(`${overwrote ? "Overwrote" : "Wrote"} lore skill to ${path}`);
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(result));
        return;
      }
      console.log(result as string);
    });
}
