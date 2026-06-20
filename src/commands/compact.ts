import { Command } from "commander";
import { readFileSync } from "node:fs";
import { CompactValidationError, parseCompact } from "../compact/index.js";
import { loadConfig } from "../config/index.js";
import { openStore, type Issue, type Repo, type Store } from "../store/index.js";

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

/**
 * Parses the `--limit <n>` option value into a positive integer.
 *
 * @throws {CompactCommandError} When the value is not a positive integer.
 */
export function parseLimit(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || String(n) !== value.trim()) {
    throw new CompactCommandError(`Invalid --limit "${value}". Expected a positive integer.`);
  }
  return n;
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
 * Core action for `issuary compact set`: validates the target, looks up the repo
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
    throw new CompactCommandError(`Repo "${fullName}" is not watched. Add it with \`issuary add ${fullName}\` first.`);
  }

  const issue = store.getIssue(repo.id, number);
  if (!issue) {
    throw new CompactCommandError(`Issue ${fullName}#${number} is not in the local store. Run \`issuary sync\` first.`);
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

/** The compaction status of an issue, derived from `compact` and `compact_stale`. */
export type CompactStatus = "compacted" | "stale" | "uncompacted";

/** Why an issue appears in the pending set: never compacted, or compacted but stale. */
export type CompactReason = "uncompacted" | "stale";

/** Options for {@link runCompactList}. */
export interface CompactListOptions {
  /** Narrow to the actionable set: uncompacted or stale issues only. */
  pending?: boolean;
  /** Restrict to a single repo, as `owner/repo`. */
  repo?: string;
  /**
   * Cap the number of returned items. Applied after the pending/repo filter,
   * so a worker can batch how many issues it pulls per run. A non-positive or
   * absent value means no cap.
   */
  limit?: number;
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/**
 * One issue as surfaced by `issuary compact list`. Carries what an AI needs to
 * compact the issue directly: identity, status, and (for pending issues) the
 * raw body plus a hint that comments are fetched on demand via `issuary show --raw`.
 */
export interface CompactListItem {
  /** The repo's `owner/name`. */
  repo: string;
  /** The issue number. */
  number: number;
  /** The issue title. */
  title: string;
  /** `open` or `closed`. */
  state: string;
  /** Compaction status: `compacted`, `stale`, or `uncompacted`. */
  status: CompactStatus;
  /**
   * Why the issue is actionable. Present only for pending issues
   * (`uncompacted` or `stale`); `null` for already-fresh compacts.
   */
  reason: CompactReason | null;
  /** Raw issue body markdown, or null when not fetched yet. */
  rawBody: string | null;
  /**
   * Whether comments may still need fetching. When true, an agent should run
   * `issuary show <repo>#<number> --raw` to pull the comment thread before compacting.
   */
  commentsNeedFetch: boolean;
}

/** Derives the {@link CompactStatus} of an issue from its compact fields. */
function compactStatus(issue: Issue): CompactStatus {
  if (issue.compact === null) {
    return "uncompacted";
  }
  return issue.compactStale ? "stale" : "compacted";
}

/**
 * Core action for `issuary compact list`: walks the watched repos (or a single
 * repo via `options.repo`) and returns their issues with compaction status.
 * With `options.pending`, narrows to the actionable set (uncompacted or stale)
 * and stamps each with a `reason`. With `options.limit`, caps the number of
 * returned items (applied last, after the pending/repo filter).
 *
 * Separated from the Commander wiring so it can be tested without spawning a
 * process. The caller is responsible for opening/closing the {@link Store}.
 *
 * @throws {CompactCommandError} When `options.repo` names an unwatched repo.
 */
export function runCompactList(store: Store, options: CompactListOptions = {}): CompactListItem[] {
  let repos: Repo[];
  if (options.repo) {
    const repo = store.getRepoByFullName(options.repo);
    if (!repo) {
      throw new CompactCommandError(
        `Repo "${options.repo}" is not watched. Add it with \`issuary add ${options.repo}\` first.`,
      );
    }
    repos = [repo];
  } else {
    repos = store.listRepos();
  }

  const items: CompactListItem[] = [];
  for (const repo of repos) {
    for (const issue of store.listIssues(repo.id)) {
      const status = compactStatus(issue);
      const pending = status !== "compacted";
      if (options.pending && !pending) {
        continue;
      }
      items.push({
        repo: repo.fullName,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        status,
        reason: pending ? status : null,
        rawBody: issue.rawBody,
        commentsNeedFetch: issue.rawComments === null && issue.commentCount > 0,
      });
    }
  }

  if (options.limit !== undefined && options.limit > 0) {
    return items.slice(0, options.limit);
  }
  return items;
}

/**
 * Renders the human-readable listing of {@link CompactListItem}s, grouped by
 * repo. Each row shows the issue number, status, and title.
 */
export function formatCompactList(items: CompactListItem[], options: { pending?: boolean } = {}): string {
  if (items.length === 0) {
    return options.pending
      ? "Nothing to compact. Every watched issue has a fresh compact."
      : "No issues found. Run `issuary sync` to mirror issues first.";
  }

  const byRepo = new Map<string, CompactListItem[]>();
  for (const item of items) {
    const bucket = byRepo.get(item.repo);
    if (bucket) {
      bucket.push(item);
    } else {
      byRepo.set(item.repo, [item]);
    }
  }

  const lines: string[] = [];
  for (const [repo, repoItems] of byRepo) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`${repo}:`);
    const numWidth = Math.max(...repoItems.map((item) => `#${item.number}`.length));
    const statusWidth = Math.max(...repoItems.map((item) => item.status.length));
    for (const item of repoItems) {
      const num = `#${item.number}`.padEnd(numWidth);
      const status = item.status.padEnd(statusWidth);
      lines.push(`  ${num}  ${status}  ${item.title}`);
    }
  }
  return lines.join("\n");
}

/**
 * Builds the `compact` command group with its `set` and `list` subcommands.
 *
 * @see file://../../docs/compact-format.md
 */
export function compactCommand(): Command {
  const compact = new Command("compact").description("Read and write AI-written compact summaries of issues");

  compact
    .command("list")
    .description("List issues with their compaction status; --pending narrows to what needs compacting")
    .option("--pending", "only issues that need compacting (uncompacted or stale)")
    .option("--repo <owner/repo>", "restrict to a single watched repo")
    .option("--limit <n>", "cap the number of issues returned, applied after the pending/repo filter", parseLimit)
    .option("--json", "emit machine-readable JSON")
    .action((options: CompactListOptions) => {
      const config = loadConfig({ requireToken: false });
      const store = openStore(config.dbPath);
      try {
        const items = runCompactList(store, options);
        if (options.json) {
          console.log(JSON.stringify(items));
        } else {
          console.log(formatCompactList(items, { pending: options.pending }));
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
