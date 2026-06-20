import { bold, dim, green, red, yellow } from "./style.js";
import { BULLET, CHECK, CROSS } from "./symbols.js";

export * from "./style.js";
export * from "./symbols.js";

/**
 * A colored state badge for an issue: `open` in green, anything else (closed) in
 * dim. The color is chosen from `state`; pass `display` to render a different
 * string (e.g. a padded one) with that color. The text is unchanged when color
 * is disabled, so plain-text assertions still see the raw `open` / `closed`.
 */
export function stateBadge(state: string, display: string = state): string {
  return state === "open" ? green(display) : dim(display);
}

/** Inputs for {@link compactMark}: the compaction signals of an issue. */
export interface CompactMarkInput {
  /** Whether a fresh, trustworthy compact exists. */
  compacted: boolean;
  /** Whether a compact exists but is stale. */
  stale: boolean;
}

/**
 * The discreet trailing compaction marker for an issue:
 * `(stale)` in yellow, `(uncompacted)` in dim, and nothing when fresh. The
 * returned string includes its own leading space, or is empty.
 */
export function compactMark({ compacted, stale }: CompactMarkInput): string {
  if (compacted) {
    return "";
  }
  return stale ? ` ${yellow("(stale)")}` : ` ${dim("(uncompacted)")}`;
}

/** A success line, prefixed with a green check. */
export function success(message: string): string {
  return `${green(CHECK)} ${message}`;
}

/** An error line, prefixed with a red cross. */
export function errorLine(message: string): string {
  return `${red(CROSS)} ${message}`;
}

/** A warning line, prefixed with a yellow bang. */
export function warn(message: string): string {
  return `${yellow("!")} ${message}`;
}

/** Renders a list of labels as dim, brace-wrapped chips, or empty when none. */
export function labelChips(labels: string[]): string {
  if (labels.length === 0) {
    return "";
  }
  return ` ${dim(`{${labels.join(", ")}}`)}`;
}

/** A bold repo header (the `owner/name:` line that opens a repo group). */
export function repoHeader(repo: string): string {
  return bold(`${repo}:`);
}

/**
 * A count header line: the summary sentence with the leading count emphasized.
 * Pass the count and the rest of the sentence; the count is bolded.
 */
export function countHeader(count: number, rest: string): string {
  return `${bold(String(count))} ${rest}`;
}

/** A dim bullet for list rows. */
export const bullet: string = dim(BULLET);
