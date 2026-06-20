/**
 * The installable agent skill for issuary: a `SKILL.md` document an AI coding agent
 * (for example Claude Code) can discover and follow to operate issuary.
 *
 * The skill is intentionally THIN. It states what issuary is and when to reach for
 * it, then defers to `issuary protocol` and `issuary --help` for the exact contract and
 * flags so it can never drift from the actual CLI. The compaction contract itself
 * is reused from {@link COMPACTION_PROTOCOL} rather than restated here.
 */

import { COMPACTION_PROTOCOL } from "../protocol/index.js";

/** The skill name, used as the frontmatter `name` and the install directory. */
export const SKILL_NAME = "issuary";

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

# issuary

\`issuary\` is a CLI (npm \`issuary\`, binary \`issuary\`) that monitors GitHub
issues across many repositories. It keeps a local mirror, detects what changed,
and exposes a compaction layer: structured, AI-written summaries of issues that
save context tokens when you later need to reason over a project's issues.

The tool never calls an LLM. You are the CPU of the compaction: issuary stores raw
content, tells you what needs compacting, and takes your summary back.

## When to use this

Reach for issuary when you need to understand or triage GitHub issues across one or
more repos without burning context on raw bodies and long comment threads, or
when you are asked to keep a project's issue knowledge compacted and
current. If a compact exists and is fresh, read it instead of refetching the
issue.

## issuary vs GitHub's MCP

These are complementary, not competing. GitHub's MCP server gives live, raw
access to issues: use it when you need the current, unfiltered state of an issue
or its comments. issuary is NOT another raw-issue reader. Its value is the
persistent, compacted MEMORY of issues plus the cross-repo digest of what changed
since you last looked. Use issuary for the distilled memory and the "what changed"
digest, and use GitHub's MCP for live, raw issue access.

## Core loop

1. Read the contract first: run \`issuary protocol\` (add \`--json\` for the machine
   form). It defines what \`compact\` and \`compact_stale\` mean and exactly when to
   reuse versus regenerate a compact. Follow it.
2. Find work: \`issuary compact list --pending --json\` lists issues that have no
   compact or whose compact went stale. To read the existing memory with filters
   (state, repo, label, author, since, search, compaction), use \`issuary issues
   --json\`; it returns the matched issues with their compacts and flags.
3. Read the raw issue: \`issuary show <owner/repo>#<n> --raw --json\` returns the raw
   body and comments to summarize.
4. Write a compact in the canonical format (frontmatter copied from the API, body
   written by you). The format and field rules come from \`issuary protocol\`.
5. Persist it: \`issuary compact set <owner/repo>#<n> --from-file <file>\`. Persisting
   clears the stale flag.
6. Re-compact when stale: a new comment marks a compact stale, so repeat the loop
   for anything \`issuary compact list --pending\` reports.

## Flags and exact contract

Do not hardcode flags from memory. Consult \`issuary --help\` (and \`issuary <command>
--help\`) for the current commands and options, and \`issuary protocol\` for the exact
compaction contract and canonical compact format. Those are the source of truth;
this skill only points you at them.

## The compaction contract (for reference)

${COMPACTION_PROTOCOL}
`;

/**
 * The supported install formats for the skill.
 *
 * - `claude`: a `SKILL.md` under a Claude Code skills directory (the default).
 * - `agents`: a delimited, idempotent section inside an `AGENTS.md` project file.
 */
export type SkillFormat = "claude" | "agents";

/** A structured view of the skill, for machine consumption via `--json`. */
export interface SkillJson {
  /** The skill name (frontmatter `name` and install directory). */
  name: string;
  /** The skill description (frontmatter `description`). */
  description: string;
  /** Where `--install` would write the skill, for the selected format. */
  path: string;
  /** The full skill document text. */
  content: string;
  /** The install format this payload describes. */
  format: SkillFormat;
}
