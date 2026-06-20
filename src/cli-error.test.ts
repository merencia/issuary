import { describe, expect, it } from "vitest";
import { handleCliError, type CliErrorSink } from "./cli-error.js";
import { ConfigError } from "./config/index.js";
import { GitHubError, NetworkError } from "./github/index.js";

/** A sink that records every line written to it. */
function recordingSink(): CliErrorSink & { lines: string[] } {
  const lines: string[] = [];
  return { lines, error: (message: string) => lines.push(message) };
}

describe("handleCliError", () => {
  it("prints a ConfigError's message alone and exits non-zero, no stack", () => {
    const sink = recordingSink();
    const error = new ConfigError("GITHUB_TOKEN is not set.");

    const code = handleCliError(error, sink);

    expect(code).toBe(1);
    expect(sink.lines).toEqual(["✗ GITHUB_TOKEN is not set."]);
    expect(sink.lines[0]).not.toContain("at ");
    expect(sink.lines[0]).not.toContain("ConfigError");
  });

  it("prints a GitHubError's message alone, no stack", () => {
    const sink = recordingSink();
    const error = new GitHubError(
      "GitHub returned 404: the repo was not found or your token has no access to it.",
      404,
    );

    const code = handleCliError(error, sink);

    expect(code).toBe(1);
    expect(sink.lines).toEqual(["✗ GitHub returned 404: the repo was not found or your token has no access to it."]);
  });

  it("treats a NetworkError as friendly", () => {
    const sink = recordingSink();
    const error = new NetworkError("Network request to GitHub failed after 3 attempts: fetch failed.");

    const code = handleCliError(error, sink);

    expect(code).toBe(1);
    expect(sink.lines).toEqual(["✗ Network request to GitHub failed after 3 attempts: fetch failed."]);
  });

  it("shows more detail for an unknown error and still exits non-zero", () => {
    const sink = recordingSink();
    const error = new Error("something unexpected");

    const code = handleCliError(error, sink);

    expect(code).toBe(1);
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain("Unexpected error:");
    expect(sink.lines[0]).toContain("something unexpected");
  });

  it("handles a non-Error thrown value", () => {
    const sink = recordingSink();

    const code = handleCliError("a string", sink);

    expect(code).toBe(1);
    expect(sink.lines).toEqual(["Unexpected error: a string"]);
  });
});
