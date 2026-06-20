import { describe, expect, it, vi } from "vitest";
import { pollForAccessToken, requestDeviceCode } from "./device-flow.js";
import { AuthError } from "./errors.js";

/** Builds a minimal JSON `Response` with optional headers. */
function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

describe("requestDeviceCode", () => {
  it("posts to the device-code endpoint and parses the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        device_code: "dev123",
        user_code: "WXYZ-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );

    const result = await requestDeviceCode({
      clientId: "cid",
      scope: "repo",
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result.device_code).toBe("dev123");
    expect(result.user_code).toBe("WXYZ-1234");
    expect(result.verification_uri).toBe("https://github.com/login/device");
    expect(result.interval).toBe(5);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://github.com/login/device/code");
    expect(init.method).toBe("POST");
    expect(init.headers.Accept).toBe("application/json");
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({ client_id: "cid", scope: "repo" });
  });

  it("honors a custom OAuth host (Enterprise/tests)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ device_code: "d", user_code: "u", verification_uri: "v", expires_in: 1, interval: 1 }),
      );
    await requestDeviceCode({
      clientId: "cid",
      scope: "repo",
      oauthHost: "https://ghe.example.com/",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://ghe.example.com/login/device/code");
  });

  it("throws AuthError on a malformed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ nope: true }));
    await expect(
      requestDeviceCode({ clientId: "cid", scope: "repo", fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("pollForAccessToken", () => {
  const base = {
    clientId: "cid",
    deviceCode: "dev123",
    interval: 5,
    expiresIn: 900,
  };

  it("returns the token after authorization_pending then success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghp_token", token_type: "bearer", scope: "repo" }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const token = await pollForAccessToken({
      ...base,
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
      now: () => 0,
    });

    expect(token).toBe("ghp_token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("increases the interval on slow_down", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "slow_down" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghp_token" }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await pollForAccessToken({
      ...base,
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
      now: () => 0,
    });

    // First sleep at the base interval (5s), second after slow_down bumps +5s.
    expect(sleep.mock.calls[0][0]).toBe(5000);
    expect(sleep.mock.calls[1][0]).toBe(10000);
  });

  it("honors the interval returned by slow_down", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "slow_down", interval: 20 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghp_token" }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await pollForAccessToken({
      ...base,
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
      now: () => 0,
    });

    expect(sleep.mock.calls[1][0]).toBe(20000);
  });

  it("throws AuthError on access_denied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "access_denied" }));
    await expect(
      pollForAccessToken({
        ...base,
        fetch: fetchMock as unknown as typeof fetch,
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => 0,
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError on expired_token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "expired_token" }));
    await expect(
      pollForAccessToken({
        ...base,
        fetch: fetchMock as unknown as typeof fetch,
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => 0,
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError when the device-code window elapses", async () => {
    // GitHub keeps the grant pending; the clock advances past the deadline so
    // the next loop iteration bails out with a timeout AuthError.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "authorization_pending" }));
    let clock = 0;
    await expect(
      pollForAccessToken({
        ...base,
        expiresIn: 10,
        fetch: fetchMock as unknown as typeof fetch,
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => {
          const value = clock;
          clock += 20_000; // jump past the 10s window after the first read
          return value;
        },
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
