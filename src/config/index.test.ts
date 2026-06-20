import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "./index.js";

describe("config barrel", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    vi.stubEnv("GITHUB_API_URL", undefined);
    vi.stubEnv("LORE_HOME", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("re-exports loadConfig", () => {
    const config = loadConfig();
    expect(config.apiUrl).toBe("https://api.github.com");
    expect(config.home).toBe(join(homedir(), ".lore"));
  });

  it("re-exports ConfigError", () => {
    vi.stubEnv("GITHUB_TOKEN", undefined);
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});
