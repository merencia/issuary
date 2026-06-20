/**
 * The canonical AI compaction protocol, exposed as a first-class, machine-readable
 * contract. Kept consistent with the "Protocolo de compactacao" section of
 * `CLAUDE.md` and the full spec in `docs/compact-format.md`.
 *
 * The full field-by-field specification lives in {@link COMPACT_FORMAT_DOC}.
 */

/** Pointer to the full, authoritative compact format specification. */
export const COMPACT_FORMAT_DOC = "docs/compact-format.md";

/**
 * The canonical compaction protocol text that AI consumers follow.
 *
 * It states what each issue exposes (`compact` and `compact_stale`), the two
 * rules for using or regenerating a compact, the persistence command, and what
 * a compact must preserve. It points to {@link COMPACT_FORMAT_DOC} for the full
 * field spec.
 *
 * Asserted on by tests via substrings so the contract cannot silently drift.
 */
export const COMPACTION_PROTOCOL = `lore compaction protocol (contract for AI consumers)

Each issue lore exposes carries two fields:
  - compact: string | null   the AI-written structured summary, or null if none
  - compact_stale: boolean    true when the compact no longer reflects the issue

Rule 1 (use when fresh):
  If compact != null AND compact_stale == false, USE the compact. Do not refetch
  the raw issue, do not re-read raw_comments, and do not recompact. The compact is
  trusted and current.

Rule 2 (recompact when missing or stale):
  If compact == null OR compact_stale == true, read raw_body and raw_comments,
  write a fresh compact in the canonical format, and persist it:

    lore compact set <owner/repo>#<n> --from-file <file>

  Persisting a compact clears the stale flag.

What a compact must preserve:
  - status and state_reason are copied verbatim from the GitHub API, never inferred.
  - labels are copied from the API; only their selection is a judgment call.
  - refs are preserved literally, exactly as written (for example "#812", "PR #820").
  - tldr is one standalone sentence (soft cap about 20 words).
  - The body fields tldr, problem, status_detail, decisions, open_questions keep a
    fixed order. An empty textual field is the literal null. Soft cap about 8 lines.

Full field-by-field specification, rules, and worked examples: ${COMPACT_FORMAT_DOC}.`;

/** A structured view of the compact format, for machine consumption via `--json`. */
export interface CompactFormatSpec {
  /** Pointer to the full canonical specification document. */
  doc: string;
  /** Frontmatter fields copied from the GitHub API, never invented. */
  frontmatterFields: string[];
  /** Body fields written by the AI, in their fixed order. */
  bodyFields: string[];
  /** The command that persists a compact and clears the stale flag. */
  persistCommand: string;
}

/** Structured, machine-readable description of the canonical compact format. */
export const COMPACT_FORMAT_SPEC: CompactFormatSpec = {
  doc: COMPACT_FORMAT_DOC,
  frontmatterFields: ["status", "state_reason", "refs", "versions", "labels"],
  bodyFields: ["tldr", "problem", "status_detail", "decisions", "open_questions"],
  persistCommand: "lore compact set <owner/repo>#<n> --from-file <file>",
};
