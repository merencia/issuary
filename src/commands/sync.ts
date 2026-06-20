import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { createGitHubClient, type GitHubClient } from "../github/index.js";
import { CHECK, CROSS, dim, green, red } from "../render/index.js";
import { openStore, type Repo, type Store } from "../store/index.js";
import { runSync, type RepoSyncResult, type SyncResult } from "../sync/index.js";

/** Options for {@link runSyncCommand}. */
export interface SyncCommandOptions {
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
  /**
   * Suppress output when there was no activity across all repos. Intended for
   * unattended/cron runs so a quiet run produces no noise. Errors are always
   * printed regardless. Has no effect on `--json`.
   */
  quiet?: boolean;
}

/**
 * Error thrown by the `sync` action for expected, user-facing failures (no repos
 * watched, the named repo is not watched). The CLI prints the message and exits
 * non-zero.
 */
export class SyncCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncCommandError";
  }
}

/**
 * Resolves which repos to sync: the single named one (when `repo` is given), or
 * every active repo otherwise.
 *
 * @throws {SyncCommandError} When the named repo is not watched, or when no
 *   active repos exist.
 */
function resolveRepos(store: Store, repo: string | undefined): Repo[] {
  if (repo) {
    const found = store.getRepoByFullName(repo);
    if (!found) {
      throw new SyncCommandError(`Repo "${repo}" is not watched. Add it with \`issuary add ${repo}\` first.`);
    }
    return [found];
  }
  const active = store.listRepos({ activeOnly: true });
  if (active.length === 0) {
    throw new SyncCommandError("No active repos to sync. Add one with `issuary add <owner/repo>`.");
  }
  return active;
}

/**
 * Core action for `issuary sync [repo]`: resolves the target repos and runs the
 * diff engine over them. Separated from the Commander wiring so it can be tested
 * without spawning a process. The caller owns the {@link Store} and client.
 *
 * @throws {SyncCommandError} For expected, user-facing failures.
 */
export async function runSyncCommand(
  store: Store,
  client: GitHubClient,
  repo: string | undefined,
): Promise<SyncResult> {
  const repos = resolveRepos(store, repo);
  return runSync({ store, client }, repos);
}

/**
 * True when a repo result carries noteworthy activity worth reporting even in
 * quiet mode: a failure, or any recorded event (opened/closed/reopened/new
 * comments). A 304, a no-op incremental sync, and a silent baseline import all
 * count as no activity.
 */
function hasActivity(r: RepoSyncResult): boolean {
  return r.error !== null || r.opened > 0 || r.closed > 0 || r.reopened > 0 || r.commented > 0;
}

/** Renders a single repo result as one human-readable line. */
function formatRepoLine(r: RepoSyncResult): string {
  if (r.error) {
    return `${red(CROSS)} ${r.repo}: failed (${r.error})`;
  }
  if (r.notModified) {
    return `${green(CHECK)} ${r.repo}: ${dim("unchanged")}`;
  }
  const parts: string[] = [];
  if (r.opened > 0) parts.push(`${r.opened} new`);
  if (r.closed > 0) parts.push(`${r.closed} closed`);
  if (r.reopened > 0) parts.push(`${r.reopened} reopened`);
  if (r.commented > 0) parts.push(`${r.commented} new comments`);
  if (parts.length > 0) {
    return `${green(CHECK)} ${r.repo}: ${green(parts.join(", "))}`;
  }
  if (r.processed > 0) {
    // Issues were fetched and mirrored but produced no noteworthy events. This
    // is the common case on a first sync of a repo whose issues are all closed
    // (closed issues are imported as a silent baseline). Saying "no changes"
    // here would wrongly imply nothing was stored.
    return `${green(CHECK)} ${r.repo}: ${dim(`no new activity (${r.processed} issues synced)`)}`;
  }
  return `${green(CHECK)} ${r.repo}: ${dim("no changes")}`;
}

/** Renders a sync result as grouped, human-readable lines. */
export function formatSyncResult(result: SyncResult): string {
  return result.repos.map(formatRepoLine).join("\n");
}

/**
 * Quiet rendering for unattended/cron runs. Returns the empty string when no
 * repo had any activity (no events and no errors), so a scheduled run is silent
 * on a quiet cycle. When something happened it returns only the repos that had
 * activity (their event lines and any failures), never the "unchanged" or
 * "no changes" noise.
 */
export function formatSyncResultQuiet(result: SyncResult): string {
  return result.repos.filter(hasActivity).map(formatRepoLine).join("\n");
}

/**
 * Process exit code for a sync result: `1` when any repo failed to sync (a
 * non-null `error`), `0` otherwise. Lets a scheduler/monitor detect failures
 * even when output is suppressed. Kept as a pure helper so the exit-code
 * contract can be tested without spawning a process or calling `process.exit`.
 */
export function syncExitCode(result: SyncResult): number {
  return result.repos.some((r) => r.error !== null) ? 1 : 0;
}

/**
 * Builds the `sync` command.
 *
 * `issuary sync [repo]` hits the GitHub API, so a token is required. The action is
 * kept thin: it wires config, store, and client, then delegates to
 * {@link runSyncCommand}.
 */
export function syncCommand(): Command {
  return new Command("sync")
    .description("Fetch issue updates for watched repos and record what changed")
    .argument("[repo]", "limit the sync to a single watched repo, as owner/repo")
    .option("--json", "emit machine-readable JSON")
    .option("--quiet", "print nothing when there was no activity (errors are always printed); for cron")
    .action(async (repo: string | undefined, options: SyncCommandOptions) => {
      const config = loadConfig();
      const store = openStore(config.dbPath);
      const client = createGitHubClient({ token: config.token, apiUrl: config.apiUrl });
      try {
        const result = await runSyncCommand(store, client, repo);
        if (options.json) {
          // --json always emits the full result; --quiet does not change it.
          console.log(JSON.stringify(result));
        } else if (options.quiet) {
          // Print only when something happened; stay silent on a no-op cycle.
          const text = formatSyncResultQuiet(result);
          if (text !== "") {
            console.log(text);
          }
        } else {
          console.log(formatSyncResult(result));
        }
        // Signal failures to the scheduler/monitor even when output is quiet.
        const code = syncExitCode(result);
        if (code !== 0) {
          process.exitCode = code;
        }
      } catch (error) {
        if (error instanceof SyncCommandError) {
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      } finally {
        store.close();
      }
    });
}
