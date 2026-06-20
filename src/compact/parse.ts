import { parse as parseYaml } from "yaml";

/**
 * Error thrown when a compact file does not conform to the canonical format.
 *
 * Carries a clear, human-readable message pointing at what is wrong. Callers
 * (the `compact set` command) catch this to print a friendly error instead of a
 * stack trace.
 *
 * @see file://../../docs/compact-format.md
 */
export class CompactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactValidationError";
  }
}

/** The allowed values for the frontmatter `status` field. */
const VALID_STATUS = ["open", "closed"] as const;
/** The allowed values for the frontmatter `state_reason` field (besides null). */
const VALID_STATE_REASON = ["completed", "not_planned"] as const;

/** The parsed frontmatter of a compact, copied verbatim from the GitHub API. */
export interface CompactFrontmatter {
  /** `open` or `closed`. */
  status: "open" | "closed";
  /** `completed`, `not_planned`, or `null`. */
  stateReason: "completed" | "not_planned" | null;
  /** Literal cross-reference tokens, or undefined when absent. */
  refs?: string[];
  /** Version object, or undefined when absent. */
  versions?: { affected?: string; fixed?: string };
  /** Signal-carrying labels, or undefined when absent. */
  labels?: string[];
}

/**
 * A validated compact. {@link ParsedCompact.compact} is the full original file
 * text (so it round-trips verbatim), and {@link ParsedCompact.tldr} is the
 * extracted one-line headline stored separately.
 */
export interface ParsedCompact {
  /** The full, original file text, preserved exactly for round-tripping. */
  compact: string;
  /** The extracted `tldr` one-liner. */
  tldr: string;
  /** The parsed frontmatter. */
  frontmatter: CompactFrontmatter;
}

/**
 * Parses and validates a compact file in the canonical format.
 *
 * The canonical format is frontmatter between `---` fences (copied from the
 * GitHub API) followed by an AI-written body. This function validates that the
 * required structure and fields are present and well-formed, extracts the
 * `tldr` for separate storage, and returns the full original text unchanged so
 * it round-trips.
 *
 * @param text - The raw compact file contents.
 * @returns The validated {@link ParsedCompact}.
 * @throws {CompactValidationError} When the structure or any required field is invalid.
 * @see file://../../docs/compact-format.md
 */
export function parseCompact(text: string): ParsedCompact {
  const { frontmatterText, bodyText } = splitFrontmatter(text);
  const frontmatter = parseFrontmatter(frontmatterText);
  const tldr = extractTldr(bodyText);

  return { compact: text, tldr, frontmatter };
}

/**
 * Splits a compact into its frontmatter and body around the `---` fences.
 *
 * The document must open with a `---` line and contain a closing `---` line.
 */
function splitFrontmatter(text: string): { frontmatterText: string; bodyText: string } {
  const lines = text.split(/\r?\n/);

  let start = 0;
  while (start < lines.length && lines[start].trim() === "") {
    start += 1;
  }
  if (start >= lines.length || lines[start].trim() !== "---") {
    throw new CompactValidationError("Compact must start with a `---` frontmatter fence.");
  }

  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new CompactValidationError("Compact frontmatter is missing its closing `---` fence.");
  }

  const frontmatterText = lines.slice(start + 1, end).join("\n");
  const bodyText = lines.slice(end + 1).join("\n");
  return { frontmatterText, bodyText };
}

/**
 * Parses and validates the frontmatter block: `status`, `state_reason`, and the
 * optional `refs`, `versions`, and `labels` fields.
 */
function parseFrontmatter(frontmatterText: string): CompactFrontmatter {
  let raw: unknown;
  try {
    raw = parseYaml(frontmatterText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CompactValidationError(`Compact frontmatter is not valid YAML: ${detail}`);
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CompactValidationError("Compact frontmatter must be a set of key/value fields.");
  }

  const fm = raw as Record<string, unknown>;

  if (!("status" in fm)) {
    throw new CompactValidationError("Compact frontmatter is missing the required `status` field.");
  }
  const status = fm.status;
  if (status !== "open" && status !== "closed") {
    throw new CompactValidationError(
      `Compact \`status\` must be one of ${VALID_STATUS.join(", ")}, got ${formatValue(status)}.`,
    );
  }

  if (!("state_reason" in fm)) {
    throw new CompactValidationError("Compact frontmatter is missing the required `state_reason` field.");
  }
  const stateReason = normalizeStateReason(fm.state_reason);

  if (status === "open" && stateReason !== null) {
    throw new CompactValidationError("An open issue must have `state_reason: null`.");
  }

  const frontmatter: CompactFrontmatter = { status, stateReason };

  if ("refs" in fm && fm.refs !== null && fm.refs !== undefined) {
    frontmatter.refs = validateStringArray(fm.refs, "refs");
  }
  if ("labels" in fm && fm.labels !== null && fm.labels !== undefined) {
    frontmatter.labels = validateStringArray(fm.labels, "labels");
  }
  if ("versions" in fm && fm.versions !== null && fm.versions !== undefined) {
    frontmatter.versions = validateVersions(fm.versions);
  }

  return frontmatter;
}

/** Coerces a YAML `state_reason` value into the allowed set or null. */
function normalizeStateReason(value: unknown): "completed" | "not_planned" | null {
  // `null` (bare or quoted as the string "null") is the no-reason case.
  if (value === null || value === undefined || value === "null") {
    return null;
  }
  if (value === "completed" || value === "not_planned") {
    return value;
  }
  throw new CompactValidationError(
    `Compact \`state_reason\` must be one of ${VALID_STATE_REASON.join(", ")}, or null, got ${formatValue(value)}.`,
  );
}

/** Validates that a frontmatter value is an array of strings. */
function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CompactValidationError(`Compact \`${field}\` must be a list of strings.`);
  }
  return value as string[];
}

/** Validates that a frontmatter `versions` value is an `{ affected?, fixed? }` object. */
function validateVersions(value: unknown): { affected?: string; fixed?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompactValidationError("Compact `versions` must be an object like { affected, fixed }.");
  }
  const obj = value as Record<string, unknown>;
  const result: { affected?: string; fixed?: string } = {};
  for (const key of ["affected", "fixed"] as const) {
    if (key in obj && obj[key] !== null && obj[key] !== undefined) {
      if (typeof obj[key] !== "string") {
        throw new CompactValidationError(`Compact \`versions.${key}\` must be a string.`);
      }
      result[key] = obj[key] as string;
    }
  }
  return result;
}

/**
 * Extracts and validates the `tldr` body field: a non-empty, single-line value
 * on a line of the form `tldr: <text>`.
 */
function extractTldr(bodyText: string): string {
  const lines = bodyText.split("\n");
  const tldrLine = lines.find((line) => /^\s*tldr\s*:/.test(line));
  if (tldrLine === undefined) {
    throw new CompactValidationError("Compact body is missing the required `tldr` field.");
  }

  const tldr = tldrLine.replace(/^\s*tldr\s*:/, "").trim();
  if (tldr === "") {
    throw new CompactValidationError("Compact `tldr` must be a non-empty single line.");
  }
  if (tldr === "null") {
    throw new CompactValidationError("Compact `tldr` must not be null; it is the headline and must stand alone.");
  }

  return tldr;
}

/** Renders an unexpected value compactly for error messages. */
function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  return String(value);
}
