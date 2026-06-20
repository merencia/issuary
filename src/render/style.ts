import pc from "picocolors";

/**
 * A style wrapper: takes a string and returns it, decorated with ANSI when color
 * is enabled, or untouched (identity) when it is not.
 */
export type Styler = (text: string) => string;

/**
 * Whether `--no-color` was passed on the command line.
 *
 * Resolved by reading `process.argv` directly at module load (NOT via Commander's
 * parsed options), because some human formatters run before Commander has parsed.
 * Waiting for the parsed flag would let those early formatters emit ANSI.
 */
function noColorFlag(): boolean {
  return process.argv.includes("--no-color");
}

/**
 * Builds a set of stylers bound to a single output stream. picocolors decides
 * whether color is on from `stdout.isTTY` (plus `NO_COLOR` / `FORCE_COLOR`); for
 * stderr we recreate the palette against `stderr.isTTY` so error coloring is
 * correct independently of where stdout points. A `--no-color` flag (or a
 * non-TTY / `NO_COLOR`) forces every wrapper to identity.
 */
function buildStyle(enabled: boolean): {
  enabled: boolean;
  bold: Styler;
  dim: Styler;
  green: Styler;
  red: Styler;
  yellow: Styler;
  cyan: Styler;
} {
  const colors = pc.createColors(enabled);
  return {
    enabled,
    bold: colors.bold,
    dim: colors.dim,
    green: colors.green,
    red: colors.red,
    yellow: colors.yellow,
    cyan: colors.cyan,
  };
}

/**
 * Resolves whether color should be enabled for a given stream. picocolors'
 * `isColorSupported` already accounts for `NO_COLOR`, `FORCE_COLOR`, and a TTY on
 * stdout; we additionally require the stream itself to be a TTY (so a piped
 * stderr stays plain) and honor the `--no-color` flag. `FORCE_COLOR` wins.
 */
function resolveEnabled(stream: NodeJS.WriteStream | undefined): boolean {
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") {
    return true;
  }
  if (noColorFlag()) {
    return false;
  }
  return pc.isColorSupported && Boolean(stream?.isTTY);
}

/** Stylers bound to stdout. Used by every `formatXxx()` human formatter. */
const style = buildStyle(resolveEnabled(process.stdout));

/** Stylers bound to stderr. Used by the top-level error handler. */
const errStyle = buildStyle(resolveEnabled(process.stderr));

/** Whether stdout color is enabled (resolved once at load). */
export const enabled = style.enabled;
/** Bold (stdout). */
export const bold = style.bold;
/** Dim / secondary (stdout). */
export const dim = style.dim;
/** Green: open / success (stdout). */
export const green = style.green;
/** Red: error (stdout). */
export const red = style.red;
/** Yellow: stale / warning (stdout). */
export const yellow = style.yellow;
/** Cyan: accents (stdout). */
export const cyan = style.cyan;

/**
 * Error-scoped stylers, resolved against `process.stderr.isTTY`. Use these (not
 * the stdout palette) anywhere that prints to stderr, e.g. the error handler.
 */
export const styleErr = {
  /** Whether stderr color is enabled. */
  enabled: errStyle.enabled,
  bold: errStyle.bold,
  dim: errStyle.dim,
  green: errStyle.green,
  red: errStyle.red,
  yellow: errStyle.yellow,
  cyan: errStyle.cyan,
};
