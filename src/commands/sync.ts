import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { createGitHubClient, type GitHubClient } from "../github/index.js";
import { openStore, type Repo, type Store } from "../store/index.js";
import { runSync, type SyncResult } from "../sync/index.js";

/** Options for {@link runSyncCommand}. */
export interface SyncCommandOptions {
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
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
      throw new SyncCommandError(`Repo "${repo}" is not watched. Add it with \`lore add ${repo}\` first.`);
    }
    return [found];
  }
  const active = store.listRepos({ activeOnly: true });
  if (active.length === 0) {
    throw new SyncCommandError("No active repos to sync. Add one with `lore add <owner/repo>`.");
  }
  return active;
}

/**
 * Core action for `lore sync [repo]`: resolves the target repos and runs the
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

/** Renders a sync result as grouped, human-readable lines. */
export function formatSyncResult(result: SyncResult): string {
  const lines: string[] = [];
  for (const r of result.repos) {
    if (r.error) {
      lines.push(`${r.repo}: failed (${r.error})`);
      continue;
    }
    if (r.notModified) {
      lines.push(`${r.repo}: unchanged`);
      continue;
    }
    const parts: string[] = [];
    if (r.opened > 0) parts.push(`${r.opened} new`);
    if (r.closed > 0) parts.push(`${r.closed} closed`);
    if (r.reopened > 0) parts.push(`${r.reopened} reopened`);
    if (r.commented > 0) parts.push(`${r.commented} new comments`);
    if (parts.length > 0) {
      lines.push(`${r.repo}: ${parts.join(", ")}`);
    } else if (r.processed > 0) {
      // Issues were fetched and mirrored but produced no noteworthy events. This
      // is the common case on a first sync of a repo whose issues are all closed
      // (closed issues are imported as a silent baseline). Saying "no changes"
      // here would wrongly imply nothing was stored.
      lines.push(`${r.repo}: no new activity (${r.processed} issues synced)`);
    } else {
      lines.push(`${r.repo}: no changes`);
    }
  }
  return lines.join("\n");
}

/**
 * Builds the `sync` command.
 *
 * `lore sync [repo]` hits the GitHub API, so a token is required. The action is
 * kept thin: it wires config, store, and client, then delegates to
 * {@link runSyncCommand}.
 */
export function syncCommand(): Command {
  return new Command("sync")
    .description("Fetch issue updates for watched repos and record what changed")
    .argument("[repo]", "limit the sync to a single watched repo, as owner/repo")
    .option("--json", "emit machine-readable JSON")
    .action(async (repo: string | undefined, options: SyncCommandOptions) => {
      const config = loadConfig();
      const store = openStore(config.dbPath);
      const client = createGitHubClient({ token: config.token, apiUrl: config.apiUrl });
      try {
        const result = await runSyncCommand(store, client, repo);
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(formatSyncResult(result));
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
