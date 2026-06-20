import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

describe("loadConfig", () => {
  let home: string;

  beforeEach(() => {
    // Point LORE_HOME at an empty temp dir so the stored-token fallback is
    // hermetic and never reads a real ~/.lore/credentials.json.
    home = mkdtempSync(join(tmpdir(), "lore-config-"));
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_API_URL", "");
    vi.stubEnv("LORE_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  describe("token", () => {
    it("reads GITHUB_TOKEN when present", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      expect(loadConfig().token).toBe("ghp_secret");
    });

    it("trims surrounding whitespace from the token", () => {
      vi.stubEnv("GITHUB_TOKEN", "  ghp_secret  ");
      expect(loadConfig().token).toBe("ghp_secret");
    });

    it("throws ConfigError when GITHUB_TOKEN is missing", () => {
      vi.stubEnv("GITHUB_TOKEN", undefined);
      expect(() => loadConfig()).toThrow(ConfigError);
    });

    it("throws ConfigError when GITHUB_TOKEN is empty or whitespace", () => {
      vi.stubEnv("GITHUB_TOKEN", "   ");
      expect(() => loadConfig()).toThrow(ConfigError);
    });

    it("never leaks the token value in the error message", () => {
      vi.stubEnv("GITHUB_TOKEN", "");
      let message = "";
      try {
        loadConfig();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("GITHUB_TOKEN");
      expect(message).toMatch(/scope/i);
    });

    it("mentions `lore login` in the missing-token error message", () => {
      vi.stubEnv("GITHUB_TOKEN", "");
      let message = "";
      try {
        loadConfig();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("lore login");
    });

    it("does not require a token when requireToken is false", () => {
      vi.stubEnv("GITHUB_TOKEN", undefined);
      const config = loadConfig({ requireToken: false });
      expect(config.token).toBe("");
    });

    it("still returns the token when requireToken is false and one is set", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      expect(loadConfig({ requireToken: false }).token).toBe("ghp_secret");
    });

    it("falls back to the stored token when GITHUB_TOKEN is unset", () => {
      vi.stubEnv("GITHUB_TOKEN", "");
      writeFileSync(join(home, "credentials.json"), JSON.stringify({ github_token: "ghp_stored" }));
      expect(loadConfig().token).toBe("ghp_stored");
    });

    it("prefers the GITHUB_TOKEN env over the stored token", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_env");
      writeFileSync(join(home, "credentials.json"), JSON.stringify({ github_token: "ghp_stored" }));
      expect(loadConfig().token).toBe("ghp_env");
    });

    it("throws ConfigError when neither env nor stored token exists", () => {
      vi.stubEnv("GITHUB_TOKEN", "");
      expect(() => loadConfig()).toThrow(ConfigError);
    });
  });

  describe("apiUrl", () => {
    it("defaults to the public GitHub API", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      expect(loadConfig().apiUrl).toBe("https://api.github.com");
    });

    it("honors GITHUB_API_URL override", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("GITHUB_API_URL", "https://ghe.example.com/api/v3");
      expect(loadConfig().apiUrl).toBe("https://ghe.example.com/api/v3");
    });

    it("trims a single trailing slash", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("GITHUB_API_URL", "https://ghe.example.com/api/v3/");
      expect(loadConfig().apiUrl).toBe("https://ghe.example.com/api/v3");
    });

    it("trims multiple trailing slashes", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("GITHUB_API_URL", "https://ghe.example.com///");
      expect(loadConfig().apiUrl).toBe("https://ghe.example.com");
    });

    it("falls back to the default when set to whitespace", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("GITHUB_API_URL", "   ");
      expect(loadConfig().apiUrl).toBe("https://api.github.com");
    });
  });

  describe("home and dbPath", () => {
    it("defaults home to ~/.lore", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("LORE_HOME", undefined);
      expect(loadConfig().home).toBe(join(homedir(), ".lore"));
    });

    it("derives dbPath from the default home", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("LORE_HOME", undefined);
      expect(loadConfig().dbPath).toBe(join(homedir(), ".lore", "db.sqlite"));
    });

    it("honors LORE_HOME override", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("LORE_HOME", "/tmp/custom-lore");
      const config = loadConfig();
      expect(config.home).toBe("/tmp/custom-lore");
      expect(config.dbPath).toBe(join("/tmp/custom-lore", "db.sqlite"));
    });

    it("falls back to the default home when LORE_HOME is whitespace", () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("LORE_HOME", "   ");
      expect(loadConfig().home).toBe(join(homedir(), ".lore"));
    });
  });
});

describe("ConfigError", () => {
  it("is an Error with name ConfigError", () => {
    const err = new ConfigError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ConfigError");
    expect(err.message).toBe("boom");
  });
});
