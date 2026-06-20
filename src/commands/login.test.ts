import { describe, expect, it, vi } from "vitest";
import { AuthError } from "../auth/errors.js";
import { runLogin } from "./login.js";

describe("runLogin", () => {
  it("runs the device flow, stores the token, and reports the user", async () => {
    const requestDeviceCode = vi.fn().mockResolvedValue({
      device_code: "dev123",
      user_code: "WXYZ-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
    const pollForAccessToken = vi.fn().mockResolvedValue("ghp_token");
    const writeStoredToken = vi.fn();
    const getAuthenticatedUser = vi.fn().mockResolvedValue({ login: "octocat", scopes: ["repo"] });
    const log = vi.fn();

    const result = await runLogin({
      home: "/tmp/issuary-home",
      apiUrl: "https://api.github.com",
      clientId: "cid",
      scope: "repo",
      requestDeviceCode,
      pollForAccessToken,
      writeStoredToken,
      getAuthenticatedUser,
      log,
    });

    expect(result).toEqual({ ok: true, login: "octocat", scopes: ["repo"] });
    expect(writeStoredToken).toHaveBeenCalledWith("/tmp/issuary-home", "ghp_token");
    expect(getAuthenticatedUser).toHaveBeenCalledWith("https://api.github.com", "ghp_token");

    // The user code and verification URI are shown; the token never is.
    const printed = log.mock.calls.map((c) => c[0]).join("\n");
    expect(printed).toContain("WXYZ-1234");
    expect(printed).toContain("https://github.com/login/device");
    expect(printed).not.toContain("ghp_token");
  });

  it("passes device-flow timing from the device code into the poll", async () => {
    const requestDeviceCode = vi.fn().mockResolvedValue({
      device_code: "dev123",
      user_code: "u",
      verification_uri: "v",
      expires_in: 600,
      interval: 7,
    });
    const pollForAccessToken = vi.fn().mockResolvedValue("ghp_token");

    await runLogin({
      home: "/tmp/h",
      apiUrl: "https://api.github.com",
      clientId: "cid",
      scope: "repo",
      requestDeviceCode,
      pollForAccessToken,
      writeStoredToken: vi.fn(),
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: "x", scopes: [] }),
      log: vi.fn(),
    });

    expect(pollForAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ deviceCode: "dev123", interval: 7, expiresIn: 600 }),
    );
  });

  it("does not store a token when polling fails", async () => {
    const writeStoredToken = vi.fn();
    await expect(
      runLogin({
        home: "/tmp/h",
        apiUrl: "https://api.github.com",
        clientId: "cid",
        scope: "repo",
        requestDeviceCode: vi.fn().mockResolvedValue({
          device_code: "d",
          user_code: "u",
          verification_uri: "v",
          expires_in: 1,
          interval: 1,
        }),
        pollForAccessToken: vi.fn().mockRejectedValue(new AuthError("denied")),
        writeStoredToken,
        getAuthenticatedUser: vi.fn(),
        log: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(writeStoredToken).not.toHaveBeenCalled();
  });
});
