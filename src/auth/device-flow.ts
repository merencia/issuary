import { AuthError } from "./errors.js";

/** Default OAuth endpoints host; overridable for tests and GitHub Enterprise. */
const DEFAULT_OAUTH_HOST = "https://github.com";

/** Standard extra delay (seconds) applied when GitHub asks us to `slow_down`. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Fallback poll interval (seconds) when GitHub omits one. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Default sleep backed by a real timer. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalizes an OAuth host: trims trailing slashes, falls back to the default. */
function normalizeHost(raw: string | undefined): string {
  return ((raw ?? "").trim() || DEFAULT_OAUTH_HOST).replace(/\/+$/, "");
}

/** The device/user codes returned by {@link requestDeviceCode}. */
export interface DeviceCodeResponse {
  /** Long device verification code used when polling for the token. */
  device_code: string;
  /** Short code the user types into the verification page. */
  user_code: string;
  /** URL the user opens to enter the {@link DeviceCodeResponse.user_code}. */
  verification_uri: string;
  /** Seconds until the device/user codes expire. */
  expires_in: number;
  /** Minimum seconds to wait between token polls. */
  interval: number;
}

/** Options for {@link requestDeviceCode}. */
export interface RequestDeviceCodeOptions {
  /** OAuth App client id. */
  clientId: string;
  /** OAuth scope to request, e.g. `repo`. */
  scope: string;
  /** OAuth endpoints host; defaults to `https://github.com`. */
  oauthHost?: string;
  /** `fetch` override; defaults to the global `fetch`. For tests. */
  fetch?: typeof fetch;
}

/** Options for {@link pollForAccessToken}. */
export interface PollForAccessTokenOptions {
  /** OAuth App client id. */
  clientId: string;
  /** The `device_code` from {@link requestDeviceCode}. */
  deviceCode: string;
  /** Initial poll interval in seconds (from the device-code response). */
  interval: number;
  /** Seconds until the device code expires; polling stops past this window. */
  expiresIn: number;
  /** OAuth endpoints host; defaults to `https://github.com`. */
  oauthHost?: string;
  /** `fetch` override; defaults to the global `fetch`. For tests. */
  fetch?: typeof fetch;
  /** Sleep used between polls; defaults to a real timer. For tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock returning epoch milliseconds; defaults to `Date.now`. For tests. */
  now?: () => number;
}

/**
 * Requests a device and user code to start the GitHub device flow.
 *
 * `POST {oauthHost}/login/device/code` with the client id and scope.
 *
 * @param options - Client id, scope, and optional host/`fetch` overrides.
 * @returns The parsed {@link DeviceCodeResponse}.
 * @throws {AuthError} When the request fails or the response is malformed.
 */
export async function requestDeviceCode(options: RequestDeviceCodeOptions): Promise<DeviceCodeResponse> {
  const doFetch = options.fetch ?? fetch;
  const host = normalizeHost(options.oauthHost);

  let response: Response;
  try {
    response = await doFetch(`${host}/login/device/code`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: options.clientId, scope: options.scope }),
    });
  } catch (error) {
    throw new AuthError(`Could not reach GitHub to start device login: ${(error as Error).message}.`);
  }

  if (!response.ok) {
    throw new AuthError(`GitHub rejected the device-code request with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as Partial<DeviceCodeResponse> & { error?: string; error_description?: string };
  if (body.error) {
    throw new AuthError(`GitHub device-code request failed: ${body.error_description ?? body.error}.`);
  }
  if (
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  ) {
    throw new AuthError("GitHub returned an unexpected device-code response.");
  }

  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    expires_in: typeof body.expires_in === "number" ? body.expires_in : 900,
    interval: typeof body.interval === "number" ? body.interval : DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

/** Shape of the `POST /login/oauth/access_token` JSON response. */
interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

/**
 * Polls GitHub for the access token after the user authorizes the device.
 *
 * `POST {oauthHost}/login/oauth/access_token` on the given `interval`, handling
 * the documented device-flow responses: `authorization_pending` (keep polling),
 * `slow_down` (back off by the standard 5s plus any returned interval),
 * `expired_token` and `access_denied` (throw), and success (`access_token`).
 * Stops once the `expiresIn` window elapses. Uses an injectable `sleep` and
 * `now` so tests never actually wait.
 *
 * @param options - Client id, device code, timing, and overrides.
 * @returns The access token string.
 * @throws {AuthError} On denial, expiry, timeout, or an unexpected response.
 */
export async function pollForAccessToken(options: PollForAccessTokenOptions): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const host = normalizeHost(options.oauthHost);

  const deadline = now() + options.expiresIn * 1000;
  let intervalSeconds = options.interval > 0 ? options.interval : DEFAULT_POLL_INTERVAL_SECONDS;

  for (;;) {
    if (now() >= deadline) {
      throw new AuthError("Device login timed out before it was authorized. Run `lore login` again.");
    }

    await sleep(intervalSeconds * 1000);

    let response: Response;
    try {
      response = await doFetch(`${host}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: options.clientId,
          device_code: options.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
    } catch (error) {
      throw new AuthError(`Could not reach GitHub while polling for the token: ${(error as Error).message}.`);
    }

    if (!response.ok) {
      throw new AuthError(`GitHub rejected the token poll with HTTP ${response.status}.`);
    }

    const body = (await response.json()) as AccessTokenResponse;

    if (typeof body.access_token === "string" && body.access_token !== "") {
      return body.access_token;
    }

    switch (body.error) {
      case "authorization_pending":
        // The user has not finished authorizing yet; keep the same interval.
        continue;
      case "slow_down":
        // GitHub asks us to back off. Honor a returned interval if present,
        // otherwise bump the current one by the standard 5 seconds.
        intervalSeconds =
          typeof body.interval === "number" && body.interval > 0
            ? body.interval
            : intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS;
        continue;
      case "expired_token":
        throw new AuthError("The device code expired before login was authorized. Run `lore login` again.");
      case "access_denied":
        throw new AuthError("Device login was denied. You cancelled or rejected the authorization.");
      default:
        throw new AuthError(`Device login failed: ${body.error_description ?? body.error ?? "unknown error"}.`);
    }
  }
}
