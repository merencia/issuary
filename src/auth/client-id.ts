import { AuthError } from "./errors.js";

/**
 * Public client id of the registered GitHub app used for the device flow.
 *
 * A device-flow client id is not a secret, so it is safe to commit. Users can
 * override it at runtime with the `ISSUARY_GITHUB_CLIENT_ID` environment
 * variable (for example to point at their own app or a GitHub Enterprise one).
 */
export const DEFAULT_GITHUB_CLIENT_ID = "Ov23liOws9jSkjjC2PAL";

/** Default OAuth scope requested by `issuary login`; `repo` so private repos work. */
export const DEFAULT_SCOPE = "repo";

/**
 * Resolves the OAuth client id to use for the device flow.
 *
 * `ISSUARY_GITHUB_CLIENT_ID` (trimmed) overrides the baked
 * {@link DEFAULT_GITHUB_CLIENT_ID}.
 *
 * @param env - Environment to read from; defaults to `process.env`.
 * @param defaultClientId - Baked-in fallback; defaults to {@link DEFAULT_GITHUB_CLIENT_ID}.
 * @returns The resolved client id.
 * @throws {AuthError} When no client id is configured.
 */
export function resolveClientId(
  env: NodeJS.ProcessEnv = process.env,
  defaultClientId: string = DEFAULT_GITHUB_CLIENT_ID,
): string {
  const fromEnv = (env.ISSUARY_GITHUB_CLIENT_ID ?? "").trim();
  const clientId = fromEnv || defaultClientId;
  if (clientId === "") {
    throw new AuthError(
      "No GitHub OAuth client id is configured, so `issuary login` cannot run. " +
        "Set ISSUARY_GITHUB_CLIENT_ID to a GitHub OAuth App client id (device flow enabled), " +
        "or use `export GITHUB_TOKEN=...` instead.",
    );
  }
  return clientId;
}

/**
 * Resolves the OAuth scope to request.
 *
 * `ISSUARY_GITHUB_SCOPE` (trimmed) overrides the default {@link DEFAULT_SCOPE}.
 *
 * @param env - Environment to read from; defaults to `process.env`.
 * @returns The resolved scope string.
 */
export function resolveScope(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ISSUARY_GITHUB_SCOPE ?? "").trim() || DEFAULT_SCOPE;
}
