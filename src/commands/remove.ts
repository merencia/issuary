import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { openStore, type Store } from "../store/index.js";
import { parseRepoArg, RepoCommandError } from "./add.js";

/** Options for {@link runRemove}. */
export interface RemoveOptions {
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/** The result of a successful {@link runRemove}, mirrored in `--json` output. */
export interface RemoveResult {
  ok: true;
  repo: string;
  /** Whether the repo went from active to inactive, or was already inactive. */
  status: "removed" | "already-inactive";
}

/**
 * Core action for `lore remove`: deactivates a watched repo (sets `active = 0`).
 * Never deletes, so issues and compacts are preserved for history.
 *
 * Separated from the Commander wiring for testing. The caller owns the
 * {@link Store} lifecycle.
 *
 * @throws {RepoCommandError} When the repo is not watched.
 */
export function runRemove(store: Store, arg: string, _options: RemoveOptions = {}): RemoveResult {
  const { fullName } = parseRepoArg(arg);

  const existing = store.getRepoByFullName(fullName);
  if (!existing) {
    throw new RepoCommandError(`Repo "${fullName}" is not watched. Nothing to remove.`);
  }

  if (!existing.active) {
    return { ok: true, repo: fullName, status: "already-inactive" };
  }

  store.setRepoActive(fullName, false);
  return { ok: true, repo: fullName, status: "removed" };
}

/** Human-readable line for a successful {@link runRemove}. */
function removeMessage(result: RemoveResult): string {
  return result.status === "removed"
    ? `Stopped watching ${result.repo}. Its history and compacts are kept.`
    : `${result.repo} was already not being watched.`;
}

/** Builds the `remove` command. */
export function removeCommand(): Command {
  return new Command("remove")
    .description("Stop watching a repo (deactivates it; history and compacts are kept)")
    .argument("<owner/repo>", "repository to stop watching, as owner/repo")
    .option("--json", "emit machine-readable JSON")
    .action((arg: string, options: RemoveOptions) => {
      const config = loadConfig({ requireToken: false });
      const store = openStore(config.dbPath);
      try {
        const result = runRemove(store, arg, options);
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(removeMessage(result));
        }
      } catch (error) {
        if (error instanceof RepoCommandError) {
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
