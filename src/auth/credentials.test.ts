import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearStoredToken, readStoredToken, writeStoredToken } from "./credentials.js";

describe("credentials store", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lore-creds-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips a written token", () => {
    writeStoredToken(home, "ghp_secret");
    expect(readStoredToken(home)).toBe("ghp_secret");
  });

  it("creates the home directory if it does not exist", () => {
    const nested = join(home, "deeper", "lore");
    writeStoredToken(nested, "ghp_secret");
    expect(readStoredToken(nested)).toBe("ghp_secret");
  });

  it("writes the credentials file with mode 0600", () => {
    writeStoredToken(home, "ghp_secret");
    const mode = statSync(join(home, "credentials.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns null when no token is stored", () => {
    expect(readStoredToken(home)).toBeNull();
  });

  it("returns null on a corrupt credentials file", () => {
    writeStoredToken(home, "ghp_secret");
    rmSync(join(home, "credentials.json"));
    expect(readStoredToken(home)).toBeNull();
  });

  it("clears an existing token and reports it was removed", () => {
    writeStoredToken(home, "ghp_secret");
    expect(clearStoredToken(home)).toBe(true);
    expect(existsSync(join(home, "credentials.json"))).toBe(false);
    expect(readStoredToken(home)).toBeNull();
  });

  it("returns false when clearing an absent token", () => {
    expect(clearStoredToken(home)).toBe(false);
  });
});
