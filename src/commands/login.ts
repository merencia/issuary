import { Command } from "commander";
import { resolveClientId, resolveScope } from "../auth/client-id.js";
import { writeStoredToken } from "../auth/credentials.js";
import {
  pollForAccessToken,
  requestDeviceCode,
  type DeviceCodeResponse,
  type PollForAccessTokenOptions,
  type RequestDeviceCodeOptions,
} from "../auth/device-flow.js";
import { AuthError } from "../auth/errors.js";
import { loadConfig } from "../config/index.js";

/** Result of a successful {@link runLogin}, mirrored in `--json` output. */
export interface LoginResult {
  ok: true;
  /** The authenticated GitHub login (username). */
  login: string;
  /** The OAuth scopes granted to the token, when GitHub reports them. */
  scopes: string[];
}

/** Identity returned by the GitHub `/user` confirmation call. */
interface AuthenticatedUser {
  /** The GitHub login (username). */
  login: string;
  /** Scopes from the `x-oauth-scopes` response header, parsed into a list. */
  scopes: string[];
}

/**
 * Dependencies for {@link runLogin}. All side effects (network, storage, output)
 * are injected so the action is testable without touching GitHub or disk.
 */
export interface LoginDeps {
  /** Lore home directory where the token is persisted. */
  home: string;
  /** GitHub REST API base URL for the `/user` confirmation call. */
  apiUrl: string;
  /** OAuth App client id. */
  clientId: string;
  /** OAuth scope to request. */
  scope: string;
  /** OAuth endpoints host; defaults to `https://github.com` inside the flow. */
  oauthHost?: string;
  /** Starts the device flow. Defaults to {@link requestDeviceCode}. */
  requestDeviceCode?: (options: RequestDeviceCodeOptions) => Promise<DeviceCodeResponse>;
  /** Polls for the access token. Defaults to {@link pollForAccessToken}. */
  pollForAccessToken?: (options: PollForAccessTokenOptions) => Promise<string>;
  /** Persists the token. Defaults to {@link writeStoredToken}. */
  writeStoredToken?: (home: string, token: string) => void;
  /** Confirms the token by fetching the authenticated user. */
  getAuthenticatedUser?: (apiUrl: string, token: string) => Promise<AuthenticatedUser>;
  /** Human-readable progress sink. Defaults to `console.log`. */
  log?: (message: string) => void;
}

/** Default `/user` lookup used to confirm the freshly stored token. */
async function defaultGetAuthenticatedUser(apiUrl: string, token: string): Promise<AuthenticatedUser> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "merencia-lore",
      },
    });
  } catch (error) {
    throw new AuthError(`Logged in, but could not confirm the token with GitHub: ${(error as Error).message}.`);
  }
  if (!response.ok) {
    throw new AuthError(`Logged in, but GitHub rejected the token confirmation with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { login?: unknown };
  const scopesHeader = response.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopesHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    login: typeof body.login === "string" ? body.login : "unknown",
    scopes,
  };
}

/**
 * Core action for `lore login`: runs the GitHub device flow, prints the user
 * code and verification URL, polls until the user authorizes, stores the token,
 * and confirms it by fetching the authenticated user. Never prints the token.
 *
 * Separated from the Commander wiring so it can be tested with injected fakes.
 *
 * @param deps - Injected dependencies; see {@link LoginDeps}.
 * @returns The {@link LoginResult} on success.
 * @throws {AuthError} For device-flow and confirmation failures.
 */
export async function runLogin(deps: LoginDeps): Promise<LoginResult> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const doRequest = deps.requestDeviceCode ?? requestDeviceCode;
  const doPoll = deps.pollForAccessToken ?? pollForAccessToken;
  const store = deps.writeStoredToken ?? writeStoredToken;
  const getUser = deps.getAuthenticatedUser ?? defaultGetAuthenticatedUser;

  const device = await doRequest({
    clientId: deps.clientId,
    scope: deps.scope,
    oauthHost: deps.oauthHost,
  });

  log(`To authorize lore, open ${device.verification_uri} and enter the code: ${device.user_code}`);
  log("Waiting for you to authorize in the browser...");

  const token = await doPoll({
    clientId: deps.clientId,
    deviceCode: device.device_code,
    interval: device.interval,
    expiresIn: device.expires_in,
    oauthHost: deps.oauthHost,
  });

  store(deps.home, token);

  const user = await getUser(deps.apiUrl, token);
  return { ok: true, login: user.login, scopes: user.scopes };
}

/** Options for the `login` command action. */
interface LoginCommandOptions {
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/**
 * Builds the `login` command.
 *
 * `lore login` authenticates via the GitHub OAuth device flow and stores the
 * resulting token in the credentials file. The action is kept thin: it resolves
 * config and the client id, then delegates to {@link runLogin}.
 */
export function loginCommand(): Command {
  return new Command("login")
    .description("Authenticate with GitHub via the device flow and store the token")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: LoginCommandOptions) => {
      // No token is required to log in; that is the whole point.
      const config = loadConfig({ requireToken: false });
      const clientId = resolveClientId();
      const scope = resolveScope();
      const result = await runLogin({
        home: config.home,
        apiUrl: config.apiUrl,
        clientId,
        scope,
        // Silence the human progress lines in --json mode so stdout stays clean.
        log: options.json ? () => {} : undefined,
      });
      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Logged in as ${result.login}.`);
      }
    });
}
