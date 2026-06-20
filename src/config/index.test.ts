import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "./index.js";

describe("config barrel", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    vi.stubEnv("GITHUB_API_URL", undefined);
    vi.stubEnv("ISSUARY_HOME", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("re-exports loadConfig", () => {
    const config = loadConfig();
    expect(config.apiUrl).toBe("https://api.github.com");
    expect(config.home).toBe(join(homedir(), ".issuary"));
  });

  it("re-exports ConfigError", () => {
    // Point at an empty temp home so the stored-token fallback is hermetic and
    // never reads a real ~/.issuary/credentials.json left by `issuary login`.
    const emptyHome = mkdtempSync(join(tmpdir(), "issuary-cfg-"));
    vi.stubEnv("ISSUARY_HOME", emptyHome);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    try {
      expect(() => loadConfig()).toThrow(ConfigError);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
