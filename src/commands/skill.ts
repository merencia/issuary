import { Command } from "commander";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_DESCRIPTION, SKILL_MD, SKILL_NAME, type SkillFormat, type SkillJson } from "../skill/index.js";

/** The install formats the `skill` command accepts. */
export const SKILL_FORMATS: readonly SkillFormat[] = ["claude", "agents"];

/** The default install format, kept as `claude` for back-compat. */
export const DEFAULT_SKILL_FORMAT: SkillFormat = "claude";

/** The marker that opens lore's managed section inside an `AGENTS.md`. */
export const AGENTS_START_MARKER = "<!-- lore:start -->";

/** The marker that closes lore's managed section inside an `AGENTS.md`. */
export const AGENTS_END_MARKER = "<!-- lore:end -->";

/** Options accepted by {@link runSkill} and the `skill` command action. */
export interface SkillOptions {
  /** Write the skill to disk instead of just printing it. */
  install?: boolean;
  /** The install format: `claude` (default) or `agents`. */
  format?: string;
  /**
   * Override the install directory. For `claude` it is the skills root
   * (defaults to `~/.claude/skills`); for `agents` it is the directory that
   * holds `AGENTS.md` (defaults to the current working directory).
   */
  dir?: string;
  /** Emit machine-readable JSON instead of the document text. */
  json?: boolean;
}

/**
 * Validates and normalizes the requested format.
 *
 * @param format - The raw `--format` value, or undefined for the default.
 * @returns The validated {@link SkillFormat}.
 * @throws If the value is not one of {@link SKILL_FORMATS}.
 */
export function resolveFormat(format?: string): SkillFormat {
  const value = (format ?? "").trim() || DEFAULT_SKILL_FORMAT;
  if (!SKILL_FORMATS.includes(value as SkillFormat)) {
    throw new Error(`Unknown skill format "${value}". Expected one of: ${SKILL_FORMATS.join(", ")}.`);
  }
  return value as SkillFormat;
}

/**
 * Resolves the skills root directory for the `claude` format.
 *
 * Precedence: explicit `--dir`, then the `CLAUDE_SKILLS_DIR` environment
 * override, then the default `~/.claude/skills`.
 */
export function resolveSkillsDir(dir?: string): string {
  const fromEnv = (process.env.CLAUDE_SKILLS_DIR ?? "").trim();
  return (dir ?? "").trim() || fromEnv || join(homedir(), ".claude", "skills");
}

/**
 * Resolves the absolute path the skill is (or would be) written to for a format.
 *
 * - `claude`: `<skillsDir>/lore/SKILL.md` (see {@link resolveSkillsDir}).
 * - `agents`: `<dir or cwd>/AGENTS.md`.
 *
 * @param format - The install format.
 * @param dir - Optional directory override.
 * @returns The absolute path for the selected format.
 */
export function resolveSkillPath(format: SkillFormat, dir?: string): string {
  if (format === "agents") {
    return join((dir ?? "").trim() || process.cwd(), "AGENTS.md");
  }
  return join(resolveSkillsDir(dir), SKILL_NAME, "SKILL.md");
}

/** The result of {@link runSkill} when the skill is installed to disk. */
export interface SkillInstallResult {
  /** The format that was installed. */
  format: SkillFormat;
  /** The absolute path the skill was written to. */
  path: string;
  /**
   * Whether existing content was changed. For `claude` this means an existing
   * `SKILL.md` was overwritten; for `agents` it means an existing file was
   * updated (versus a new `AGENTS.md` being created).
   */
  overwrote: boolean;
}

/**
 * Builds the delimited lore section written into an `AGENTS.md`.
 *
 * The content is the same neutral skill body, wrapped in start/end markers so it
 * can be replaced in place on a re-install.
 */
export function buildAgentsSection(): string {
  return `${AGENTS_START_MARKER}\n${SKILL_MD}\n${AGENTS_END_MARKER}`;
}

/**
 * Inserts or replaces lore's delimited section in an existing `AGENTS.md` body.
 *
 * If the markers are present, only the content between them is replaced (leaving
 * the rest untouched). If they are absent, the section is appended. The
 * operation is idempotent: running it twice yields exactly one lore section.
 *
 * @param existing - The current `AGENTS.md` content (empty string if new).
 * @returns The updated file content.
 */
export function upsertAgentsSection(existing: string): string {
  const section = buildAgentsSection();
  const start = existing.indexOf(AGENTS_START_MARKER);
  const end = existing.indexOf(AGENTS_END_MARKER);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + AGENTS_END_MARKER.length);
    return `${before}${section}${after}`;
  }
  if (existing.trim().length === 0) {
    return `${section}\n`;
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${section}\n`;
}

/**
 * Core action for `lore skill`.
 *
 * Separated from the Commander wiring so it can be tested without spawning a
 * process. Behavior by option:
 *
 * - default: returns the neutral skill document text.
 * - `json`: returns the structured {@link SkillJson} payload (includes `format`).
 * - `install`: writes the skill for the selected format and returns a
 *   {@link SkillInstallResult}. `claude` writes a `SKILL.md`; `agents` inserts or
 *   replaces a delimited, idempotent section in an `AGENTS.md`.
 */
export async function runSkill(options: SkillOptions = {}): Promise<string | SkillJson | SkillInstallResult> {
  const format = resolveFormat(options.format);

  if (options.install) {
    const path = resolveSkillPath(format, options.dir);
    const existed = await fileExists(path);
    await mkdir(dirname(path), { recursive: true });
    if (format === "agents") {
      const existing = existed ? await readFile(path, "utf8") : "";
      await writeFile(path, upsertAgentsSection(existing), "utf8");
    } else {
      await writeFile(path, SKILL_MD, "utf8");
    }
    return { format, path, overwrote: existed };
  }

  if (options.json) {
    const json: SkillJson = {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      path: resolveSkillPath(format, options.dir),
      content: SKILL_MD,
      format,
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
 * Builds the `skill` command. It emits lore's neutral agent skill, or installs
 * it for an AI agent: a Claude Code `SKILL.md` (`--format claude`, the default)
 * or a delimited section in a project `AGENTS.md` (`--format agents`). Printing
 * with no `--install` is the universal path: any agent can paste it into a system
 * prompt or rules file.
 *
 * @see file://../skill/skill.ts
 */
export function skillCommand(): Command {
  return new Command("skill")
    .description("Print lore's agent skill, or install it for an AI agent (claude SKILL.md or AGENTS.md)")
    .option("--install", "write the skill to disk instead of printing it")
    .option("--format <format>", `install format: ${SKILL_FORMATS.join("|")} (default ${DEFAULT_SKILL_FORMAT})`)
    .option("--dir <path>", "install directory (claude: skills root ~/.claude/skills; agents: dir holding AGENTS.md)")
    .option("--json", "emit machine-readable JSON ({ name, description, path, content, format })")
    .action(async (options: SkillOptions) => {
      const result = await runSkill(options);
      if (options.install) {
        const { format, path, overwrote } = result as SkillInstallResult;
        const verb = overwrote ? "Updated" : "Wrote";
        console.log(`${verb} lore skill (${format}) at ${path}`);
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(result));
        return;
      }
      console.log(result as string);
    });
}
