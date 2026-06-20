import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Name of the credentials file inside the lore home directory. */
const CREDENTIALS_FILE = "credentials.json";

/** JSON shape persisted in the credentials file. Kept intentionally small. */
interface CredentialsFile {
  github_token?: string;
}

/** Absolute path to the credentials file inside the given lore home. */
function credentialsPath(home: string): string {
  return join(home, CREDENTIALS_FILE);
}

/**
 * Reads the stored GitHub token from `{home}/credentials.json`.
 *
 * @param home - The lore home directory.
 * @returns The trimmed token, or `null` when absent or unreadable.
 */
export function readStoredToken(home: string): string | null {
  const path = credentialsPath(home);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CredentialsFile;
    const token = (parsed.github_token ?? "").trim();
    return token === "" ? null : token;
  } catch {
    // A corrupt or unreadable file should not crash callers; treat as no token.
    return null;
  }
}

/**
 * Writes the GitHub token to `{home}/credentials.json` with mode `0600`.
 *
 * Creates the home directory if needed. The token is never logged.
 *
 * @param home - The lore home directory.
 * @param token - The GitHub access token to store.
 */
export function writeStoredToken(home: string, token: string): void {
  mkdirSync(home, { recursive: true });
  const path = credentialsPath(home);
  const data: CredentialsFile = { github_token: token };
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Removes the stored credentials file.
 *
 * @param home - The lore home directory.
 * @returns `true` when a file was removed, `false` when none existed.
 */
export function clearStoredToken(home: string): boolean {
  const path = credentialsPath(home);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path);
  return true;
}
