/**
 * The installable agent skill for lore: a `SKILL.md` document an AI coding agent
 * (for example Claude Code) can discover and follow to operate lore.
 *
 * The skill is intentionally THIN. It states what lore is and when to reach for
 * it, then defers to `lore protocol` and `lore --help` for the exact contract and
 * flags so it can never drift from the actual CLI. The compaction contract itself
 * is reused from {@link COMPACTION_PROTOCOL} rather than restated here.
 */

import { COMPACTION_PROTOCOL } from "../protocol/index.js";

/** The skill name, used as the frontmatter `name` and the install directory. */
export const SKILL_NAME = "lore";

/** The skill description, used as the frontmatter `description`. */
export const SKILL_DESCRIPTION =
  "Monitor GitHub issues across repos and produce or consume AI-written compactions (structured summaries) of them.";

/**
 * The full `SKILL.md` document text, including YAML frontmatter and body.
 *
 * Asserted on by tests via substrings (the core loop commands) so the skill
 * cannot silently drift away from the CLI it describes.
 */
export const SKILL_MD = `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

# lore

\`lore\` is a CLI (npm \`@merencia/lore\`, binary \`lore\`) that monitors GitHub
issues across many repositories. It keeps a local mirror, detects what changed,
and exposes a compaction layer: structured, AI-written summaries of issues that
save context tokens when you later need to reason over a project's issues.

The tool never calls an LLM. You are the CPU of the compaction: lore stores raw
content, tells you what needs compacting, and takes your summary back.

## When to use this

Reach for lore when you need to understand or triage GitHub issues across one or
more repos without burning context on raw bodies and long comment threads, or
when you are asked to keep a project's issue knowledge ("the lore") compacted and
current. If a compact exists and is fresh, read it instead of refetching the
issue.

## Core loop

1. Read the contract first: run \`lore protocol\` (add \`--json\` for the machine
   form). It defines what \`compact\` and \`compact_stale\` mean and exactly when to
   reuse versus regenerate a compact. Follow it.
2. Find work: \`lore compact list --pending --json\` lists issues that have no
   compact or whose compact went stale.
3. Read the raw issue: \`lore show <owner/repo>#<n> --raw --json\` returns the raw
   body and comments to summarize.
4. Write a compact in the canonical format (frontmatter copied from the API, body
   written by you). The format and field rules come from \`lore protocol\`.
5. Persist it: \`lore compact set <owner/repo>#<n> --from-file <file>\`. Persisting
   clears the stale flag.
6. Re-compact when stale: a new comment marks a compact stale, so repeat the loop
   for anything \`lore compact list --pending\` reports.

## Flags and exact contract

Do not hardcode flags from memory. Consult \`lore --help\` (and \`lore <command>
--help\`) for the current commands and options, and \`lore protocol\` for the exact
compaction contract and canonical compact format. Those are the source of truth;
this skill only points you at them.

## The compaction contract (for reference)

${COMPACTION_PROTOCOL}
`;

/** A structured view of the skill, for machine consumption via `--json`. */
export interface SkillJson {
  /** The skill name (frontmatter `name` and install directory). */
  name: string;
  /** The skill description (frontmatter `description`). */
  description: string;
  /** Where `--install` would write the `SKILL.md`. */
  path: string;
  /** The full `SKILL.md` document text. */
  content: string;
}
