import { Command } from "commander";
import { clearStoredToken } from "../auth/credentials.js";
import { loadConfig } from "../config/index.js";

/** Result of {@link runLogout}, mirrored in `--json` output. */
export interface LogoutResult {
  ok: true;
  /** `true` when a stored token was removed, `false` when there was none. */
  removed: boolean;
}

/** Dependencies for {@link runLogout}; injected so the action is testable. */
export interface LogoutDeps {
  /** Lore home directory holding the credentials file. */
  home: string;
  /** Clears the stored token. Defaults to {@link clearStoredToken}. */
  clearStoredToken?: (home: string) => boolean;
}

/**
 * Core action for `lore logout`: clears the stored token. Local only; it does
 * not contact GitHub or revoke the token server-side.
 *
 * @param deps - Injected dependencies; see {@link LogoutDeps}.
 * @returns A {@link LogoutResult} reporting whether anything was removed.
 */
export function runLogout(deps: LogoutDeps): LogoutResult {
  const clear = deps.clearStoredToken ?? clearStoredToken;
  const removed = clear(deps.home);
  return { ok: true, removed };
}

/** Options for the `logout` command action. */
interface LogoutCommandOptions {
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/**
 * Builds the `logout` command.
 *
 * `lore logout` removes the locally stored token. It never hits the network.
 */
export function logoutCommand(): Command {
  return new Command("logout")
    .description("Remove the stored GitHub token saved by `lore login`")
    .option("--json", "emit machine-readable JSON")
    .action((options: LogoutCommandOptions) => {
      const config = loadConfig({ requireToken: false });
      const result = runLogout({ home: config.home });
      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(result.removed ? "Logged out. Stored token removed." : "No stored token to remove.");
      }
    });
}
