import { homedir } from "node:os";
import { join } from "node:path";

/** Default GitHub REST API base URL used when `GITHUB_API_URL` is unset. */
const DEFAULT_API_URL = "https://api.github.com";

/**
 * Typed, resolved configuration consumed by the CLI.
 *
 * Produced by {@link loadConfig} from environment variables. All paths are
 * absolute and the API URL is normalized (no trailing slash).
 */
export interface Config {
  /**
   * GitHub personal access token (from `GITHUB_TOKEN`). Empty string only when
   * config was loaded with `requireToken: false` and no token is set.
   */
  token: string;
  /** GitHub REST API base URL, trailing slash trimmed. */
  apiUrl: string;
  /** Lore home directory holding local state. */
  home: string;
  /** Absolute path to the SQLite database file inside {@link Config.home}. */
  dbPath: string;
}

/** Options controlling how {@link loadConfig} resolves the configuration. */
export interface LoadConfigOptions {
  /**
   * Whether a `GITHUB_TOKEN` is required. Defaults to `true`. Set to `false`
   * for commands that never hit the GitHub API and can run without auth.
   */
  requireToken?: boolean;
}

/**
 * Error thrown when configuration is invalid or incomplete.
 *
 * Callers should catch this to print a friendly, actionable message instead of
 * a stack trace. Messages never contain secret values such as the token.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Loads and validates configuration from the environment.
 *
 * Reads `GITHUB_TOKEN`, `GITHUB_API_URL` and `LORE_HOME`, applying defaults and
 * normalization. Throws {@link ConfigError} when a required value is missing.
 *
 * @param options - Resolution options; see {@link LoadConfigOptions}.
 * @returns The resolved {@link Config}.
 * @throws {ConfigError} When `requireToken` is `true` and `GITHUB_TOKEN` is unset or empty.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const { requireToken = true } = options;

  const token = (process.env.GITHUB_TOKEN ?? "").trim();
  if (requireToken && token === "") {
    throw new ConfigError(
      "GITHUB_TOKEN is not set. lore needs a GitHub personal access token to reach the API. " +
        "Create one at https://github.com/settings/tokens with the `repo` (or `public_repo`) read scope, " +
        "then export it, e.g. `export GITHUB_TOKEN=ghp_...`.",
    );
  }

  const apiUrl = normalizeApiUrl(process.env.GITHUB_API_URL);
  const home = (process.env.LORE_HOME ?? "").trim() || join(homedir(), ".lore");
  const dbPath = join(home, "db.sqlite");

  return { token, apiUrl, home, dbPath };
}

/**
 * Normalizes the API base URL: falls back to the default when unset/empty and
 * trims any trailing slashes.
 */
function normalizeApiUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim() || DEFAULT_API_URL;
  return value.replace(/\/+$/, "");
}
