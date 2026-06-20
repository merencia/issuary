/**
 * Names of the typed errors issuary raises for expected, user-facing failures.
 *
 * These carry a message written for a human, so the CLI prints just that line
 * (no stack trace) and exits non-zero. Anything else is treated as unexpected
 * and shown with more detail to aid debugging.
 */
const FRIENDLY_ERROR_NAMES = new Set([
  "ConfigError",
  "GitHubError",
  "NetworkError",
  "RepoCommandError",
  "SyncCommandError",
  "DigestError",
  "RepoDigestError",
  "CompactCommandError",
  "CompactValidationError",
  "ShowCommandError",
  "SkillCommandError",
  "AuthError",
]);

/** Output sink for {@link handleCliError}, injectable so tests avoid real I/O. */
export interface CliErrorSink {
  /** Writes an error line to stderr. */
  error(message: string): void;
}

/**
 * Top-level error handler for the CLI entry point.
 *
 * Known typed errors ({@link FRIENDLY_ERROR_NAMES}) print their message alone,
 * with no stack trace. Unknown errors print a generic line plus their stack (or
 * string form) so genuine bugs stay debuggable. Always sets a non-zero exit
 * code; never swallows an error silently.
 *
 * @param error - The thrown value to report.
 * @param sink - Output sink; defaults to `console`.
 * @returns The process exit code to use (always 1).
 */
export function handleCliError(error: unknown, sink: CliErrorSink = console): number {
  if (error instanceof Error && FRIENDLY_ERROR_NAMES.has(error.name)) {
    sink.error(error.message);
    return 1;
  }

  if (error instanceof Error) {
    sink.error(`Unexpected error: ${error.stack ?? error.message}`);
    return 1;
  }

  sink.error(`Unexpected error: ${String(error)}`);
  return 1;
}
