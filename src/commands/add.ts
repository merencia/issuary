import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { createGitHubClient, type GitHubClient, GitHubError } from "../github/index.js";
import { success } from "../render/index.js";
import { openStore, type Store } from "../store/index.js";

/** Parses an `owner/repo` argument into its parts. */
interface RepoArg {
  owner: string;
  name: string;
  fullName: string;
}

/**
 * Error thrown by the repo commands for expected, user-facing failures (malformed
 * argument, repo not found, repo not watched). The CLI prints the message and
 * exits non-zero.
 */
export class RepoCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoCommandError";
  }
}

/**
 * Parses an `owner/repo` string argument.
 *
 * @throws {RepoCommandError} When the argument is not in the expected shape.
 */
export function parseRepoArg(arg: string): RepoArg {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(arg.trim());
  if (!match) {
    throw new RepoCommandError(`Invalid repo "${arg}". Expected the form owner/repo, e.g. octocat/hello.`);
  }
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` };
}

/** Options for {@link runAdd}. */
export interface AddOptions {
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/** The result of a successful {@link runAdd}, mirrored in `--json` output. */
export interface AddResult {
  ok: true;
  repo: string;
  /** What happened: a freshly added repo, an already-watched one, or a reactivation. */
  status: "added" | "already-watched" | "reactivated";
}

/**
 * Core action for `issuary add`: validates the repo exists/accessible on GitHub,
 * then inserts it (or reactivates it if it was previously removed).
 *
 * Separated from the Commander wiring so it can be tested with an injected
 * client and store. The caller owns the {@link Store} lifecycle.
 *
 * @throws {RepoCommandError} For expected, user-facing failures.
 * @throws {GitHubError} For unexpected GitHub failures (auth, rate limit, ...).
 */
export async function runAdd(store: Store, client: GitHubClient, arg: string): Promise<AddResult> {
  const { owner, name, fullName } = parseRepoArg(arg);

  try {
    await client.getRepo({ owner, name });
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      throw new RepoCommandError(`Repo "${fullName}" not found or no access. Check the name and your token's scopes.`);
    }
    throw error;
  }

  const existing = store.getRepoByFullName(fullName);
  if (existing) {
    if (existing.active) {
      return { ok: true, repo: fullName, status: "already-watched" };
    }
    store.setRepoActive(fullName, true);
    return { ok: true, repo: fullName, status: "reactivated" };
  }

  store.insertRepo({ owner, name, fullName });
  return { ok: true, repo: fullName, status: "added" };
}

/** Human-readable line for a successful {@link runAdd}. */
function addMessage(result: AddResult): string {
  switch (result.status) {
    case "added":
      return success(`Now watching ${result.repo}.`);
    case "reactivated":
      return success(`Reactivated ${result.repo} (it was previously removed).`);
    case "already-watched":
      return success(`${result.repo} is already watched.`);
  }
}

/** Builds the `add` command. */
export function addCommand(): Command {
  return new Command("add")
    .description("Watch a GitHub repo's issues (validates it exists via the API)")
    .argument("<owner/repo>", "repository to watch, as owner/repo")
    .option("--json", "emit machine-readable JSON")
    .action(async (arg: string, options: AddOptions) => {
      const config = loadConfig();
      const client = createGitHubClient({ token: config.token, apiUrl: config.apiUrl });
      const store = openStore(config.dbPath);
      try {
        const result = await runAdd(store, client, arg);
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(addMessage(result));
        }
      } catch (error) {
        if (error instanceof RepoCommandError || error instanceof GitHubError) {
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
