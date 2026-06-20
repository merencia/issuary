import { Command } from "commander";
import { readFileSync } from "node:fs";
import { CompactValidationError, parseCompact } from "../compact/index.js";
import { loadConfig } from "../config/index.js";
import { openStore, type Store } from "../store/index.js";

/** A parsed `owner/repo#number` target. */
interface CompactTarget {
  /** The repo's `owner/name`. */
  fullName: string;
  /** The issue number. */
  number: number;
}

/**
 * Parses an `owner/repo#number` target string.
 *
 * @throws {Error} When the target is not in the expected shape.
 */
export function parseTarget(target: string): CompactTarget {
  const match = /^([^/\s]+\/[^/\s#]+)#(\d+)$/.exec(target.trim());
  if (!match) {
    throw new Error(`Invalid target "${target}". Expected the form owner/repo#number, e.g. octocat/hello#42.`);
  }
  return { fullName: match[1], number: Number.parseInt(match[2], 10) };
}

/** Options for {@link runCompactSet}. */
export interface CompactSetOptions {
  /** Path to the compact file to read. */
  fromFile: string;
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/** The result of a successful {@link runCompactSet}, mirrored in `--json` output. */
export interface CompactSetResult {
  ok: true;
  repo: string;
  number: number;
  tldr: string;
}

/**
 * Error thrown by the `compact set` action for expected, user-facing failures
 * (malformed target, unwatched repo, missing issue, invalid file). The CLI
 * prints the message and exits non-zero.
 */
export class CompactCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactCommandError";
  }
}

/**
 * Core action for `lore compact set`: validates the target, looks up the repo
 * and issue, parses the compact file, and persists it via the store.
 *
 * Separated from the Commander wiring so it can be tested without spawning a
 * process. The caller is responsible for opening/closing the {@link Store}.
 *
 * @throws {CompactCommandError} For expected, user-facing failures.
 */
export function runCompactSet(store: Store, target: string, options: CompactSetOptions): CompactSetResult {
  const { fullName, number } = parseTarget(target);

  const repo = store.getRepoByFullName(fullName);
  if (!repo) {
    throw new CompactCommandError(`Repo "${fullName}" is not watched. Add it with \`lore add ${fullName}\` first.`);
  }

  const issue = store.getIssue(repo.id, number);
  if (!issue) {
    throw new CompactCommandError(`Issue ${fullName}#${number} is not in the local store. Run \`lore sync\` first.`);
  }

  let text: string;
  try {
    text = readFileSync(options.fromFile, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CompactCommandError(`Could not read compact file "${options.fromFile}": ${detail}`);
  }

  let parsed;
  try {
    parsed = parseCompact(text);
  } catch (error) {
    if (error instanceof CompactValidationError) {
      throw new CompactCommandError(`Invalid compact: ${error.message}`);
    }
    throw error;
  }

  store.setCompact(repo.id, number, { compact: parsed.compact, tldr: parsed.tldr });

  return { ok: true, repo: fullName, number, tldr: parsed.tldr };
}

/**
 * Builds the `compact` command group with its `set` subcommand.
 *
 * @see file://../../docs/compact-format.md
 */
export function compactCommand(): Command {
  const compact = new Command("compact").description("Read and write AI-written compact summaries of issues");

  compact
    .command("set")
    .description("Persist a compact for an issue from a file in the canonical format")
    .argument("<target>", "issue to compact, as owner/repo#number")
    .requiredOption("--from-file <file>", "path to the compact file to read")
    .option("--json", "emit machine-readable JSON")
    .action((target: string, options: CompactSetOptions) => {
      const config = loadConfig({ requireToken: false });
      const store = openStore(config.dbPath);
      try {
        const result = runCompactSet(store, target, options);
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Saved compact for ${result.repo}#${result.number}: ${result.tldr}`);
        }
      } catch (error) {
        if (error instanceof CompactCommandError) {
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      } finally {
        store.close();
      }
    });

  return compact;
}
