import { AuthError } from "./errors.js";

/**
 * Public client id of the registered GitHub OAuth App used for the device flow.
 *
 * MAINTAINER: this is intentionally empty. Device login does not work until the
 * maintainer registers a GitHub OAuth App with the device flow enabled
 * (https://github.com/settings/applications/new, then turn on "Enable Device
 * Flow") and bakes its PUBLIC client id here. A device-flow client id is not a
 * secret, so it is safe to commit. Users can override it at runtime with the
 * `LORE_GITHUB_CLIENT_ID` environment variable.
 */
export const DEFAULT_GITHUB_CLIENT_ID = "";

/** Default OAuth scope requested by `lore login`; `repo` so private repos work. */
export const DEFAULT_SCOPE = "repo";

/**
 * Resolves the OAuth client id to use for the device flow.
 *
 * `LORE_GITHUB_CLIENT_ID` (trimmed) overrides the baked
 * {@link DEFAULT_GITHUB_CLIENT_ID}.
 *
 * @param env - Environment to read from; defaults to `process.env`.
 * @returns The resolved client id.
 * @throws {AuthError} When no client id is configured.
 */
export function resolveClientId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.LORE_GITHUB_CLIENT_ID ?? "").trim();
  const clientId = fromEnv || DEFAULT_GITHUB_CLIENT_ID;
  if (clientId === "") {
    throw new AuthError(
      "No GitHub OAuth client id is configured, so `lore login` cannot run. " +
        "Set LORE_GITHUB_CLIENT_ID to a GitHub OAuth App client id (device flow enabled), " +
        "or use `export GITHUB_TOKEN=...` instead. " +
        "Maintainers: bake the app's public client id into DEFAULT_GITHUB_CLIENT_ID.",
    );
  }
  return clientId;
}

/**
 * Resolves the OAuth scope to request.
 *
 * `LORE_GITHUB_SCOPE` (trimmed) overrides the default {@link DEFAULT_SCOPE}.
 *
 * @param env - Environment to read from; defaults to `process.env`.
 * @returns The resolved scope string.
 */
export function resolveScope(env: NodeJS.ProcessEnv = process.env): string {
  return (env.LORE_GITHUB_SCOPE ?? "").trim() || DEFAULT_SCOPE;
}
