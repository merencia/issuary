# Compact format specification

This is the canonical, authoritative spec of a **compact**: the AI-written,
structured summary of a single GitHub issue. It is the expanded source of truth
behind the condensed protocol in [CLAUDE.md](../CLAUDE.md) and the text emitted
by `issuary protocol`. If anything here conflicts with a shorter restatement
elsewhere, this document wins.

The goal is precision: two different AI agents reading the same issue should
produce compacts that are consistent and interchangeable.

## 1. Purpose

A compact exists to save **context tokens** for AI consumers, not disk space.

The win is that an agent can understand a whole project's issues without
re-fetching them from GitHub or blowing its context window on raw bodies and
long comment threads. A compact distills one issue into a small, predictable,
diffable block that an agent can load cheaply and trust.

Raw content is never deleted. Compacting does not remove `raw_body` or
`raw_comments`; it adds a summary layer on top of them. You can always re-read
the raw, and you can always re-compact. Disk is not the constraint; the
consumer's context window is.

## 2. Canonical format

A compact is a single text document made of two parts in this exact order:

1. **Frontmatter** between `---` fences. Copied from the GitHub API. Never
   invented or interpreted by the AI.
2. **Body** after the closing fence. Written by the AI.

```
---
status: open | closed
state_reason: completed | not_planned | null
refs: ["#812", "owner/repo#45", "PR #820"]
versions: { affected: "...", fixed: "..." }
labels: [bug, timezone]
---
tldr: <one sentence, <= ~20 words>

problem: <what is wrong or being requested>
status_detail: <where it stands: blocked on X / awaiting repro / fixed in vN>
decisions: <what was decided and why | null>
open_questions: <what remains open | null>
```

### 2.1 Frontmatter fields (from the API, never invented)

Field order is fixed and must be reproduced exactly as listed.

| Field | Source | Notes |
|---|---|---|
| `status` | API | `open` or `closed`. Required. |
| `state_reason` | API | `completed`, `not_planned`, or `null`. Never inferred. |
| `refs` | issue text | Literal cross-references found in the issue. |
| `versions` | issue text | `{ affected, fixed }`. Include only if mentioned. |
| `labels` | API | Only labels that carry signal. |

- **`status`**: the issue's open/closed state, copied verbatim from the API.
- **`state_reason`**: copied verbatim from the API. It is `completed`,
  `not_planned`, or `null`. Never guess it. An open issue always has
  `state_reason: null`. If the API reports `null` for a closed issue, write
  `null`. Do not infer `completed` just because the issue looks resolved.
- **`refs`**: a list of literal cross-reference tokens that appear in the issue
  (body or comments). Preserve them exactly as written: `#812`,
  `owner/repo#45`, `PR #820`. Do not normalize, expand, or rewrite them. If the
  text says `PR #820`, the ref is `PR #820`, not `#820`. Omit the field (or use
  an empty list) when there are no references.
- **`versions`**: an object `{ affected, fixed }`. Include it **only** when
  versions are actually mentioned in the issue. Include only the keys that are
  known. Omit the field entirely when no versions are mentioned. Do not invent
  a `fixed` version for an open issue.
- **`labels`**: only the labels that carry signal for an AI consumer (for
  example `bug`, `timezone`, `regression`). Drop process noise (for example
  `triage`, `needs-info`, `good first issue`) unless it is the point of the
  issue. Labels are copied from the API; their selection is the only judgment
  applied, never their text.

### 2.2 Body fields (written by the AI)

Field order is fixed and must be reproduced exactly as listed: `tldr`, then a
blank line, then `problem`, `status_detail`, `decisions`, `open_questions`.

- **`tldr`**: one sentence, soft cap of about 20 words. It is the single line a
  headline view shows (see [Two-level design](#4-two-level-design)). It must
  stand alone without the rest of the body.
- **`problem`**: what is wrong (for a bug) or what is being requested (for a
  feature). State the substance, not the title.
- **`status_detail`**: where the issue stands right now. Examples: "blocked on
  upstream fix", "awaiting reproduction", "fixed in v2.3.0", "merged, pending
  release".
- **`decisions`**: what was decided and why. `null` if nothing was decided.
- **`open_questions`**: what remains unresolved. `null` if nothing is open.

## 3. Rules

These rules make compacts consistent across agents and clean to re-generate.

1. **Note style is fine.** Sentence fragments are acceptable in body fields.
   Optimize for density and clarity, not prose.
2. **Do not repeat the title.** The consumer already has the title. The compact
   adds what the title does not say.
3. **Fixed field order.** Always emit fields in the order above, frontmatter
   then body. This keeps compacts diffable and makes re-compaction produce
   minimal, reviewable changes.
4. **Preserve refs literally.** Copy cross-references exactly as they appear.
   Never rewrite, expand, or normalize them.
5. **Empty textual field is `null`.** If a body field has no content, write the
   literal `null`. Never pad with filler, "N/A", or a restated title.
6. **Soft cap of about 8 lines in the body.** If you need more, you are
   summarizing too much. Distill harder.
7. **Never invent `state_reason`.** Copy it from the API or write `null`.
8. **An open issue has no resolution.** For `status: open`, `state_reason` is
   `null`, there is no `fixed` version, and `status_detail` describes the
   current blocker or waiting state, not an outcome.

## 4. Two-level design

A compact is consumed at two levels so cost matches need.

- **Headline level (`tldr`).** The `tldr` is stored separately from the rest of
  the body. `issuary repo-digest --headlines` can list every issue in a project
  using only its `tldr`, costing roughly 20 tokens per issue. An agent can scan
  an entire repository's open and recent issues for a few hundred tokens.
- **Full level (body).** The full body (`problem`, `status_detail`,
  `decisions`, `open_questions`) loads only when the agent decides a specific
  issue is worth the deeper read.

This is why the `tldr` must stand on its own: in a headline listing it is the
only thing shown. Write it so a reader who never opens the full body still
knows what the issue is.

## 5. Staleness contract

A compact reflects the issue at the moment it was written. The issue can move
on, so compacts can go stale.

- When `sync` pulls a **new comment** on an issue that already has a compact, it
  sets `compact_stale = true` on that issue.
- A stale compact is still readable, but consumers **must re-compact** before
  trusting it.

The protocol an agent follows (see [CLAUDE.md](../CLAUDE.md) and
`issuary protocol`):

1. If the issue has a compact and it is **not** stale
   (`compact != null` and `compact_stale == false`): **use the compact.** Do
   not read the raw, do not re-compact.
2. If the issue has **no** compact or it **is** stale
   (`compact == null` or `compact_stale == true`): read `raw_body` and
   `raw_comments`, write a fresh compact in the canonical format above, and
   persist it:

   ```sh
   issuary compact set <owner/repo>#<n> --from-file <file>
   ```

   Persisting a compact clears the stale flag.

Re-compaction should produce a minimal diff against the previous compact,
because the field order is fixed and the format is stable. Only the parts that
the new comment actually changed should move.

## 6. Worked examples

### 6.1 Closed bug, fixed, with versions and refs

A timezone bug, reproduced, fixed, and released.

```
---
status: closed
state_reason: completed
refs: ["#812", "PR #820"]
versions: { affected: "2.2.0", fixed: "2.3.0" }
labels: [bug, timezone, regression]
---
tldr: Daily digest fired one hour early for users in DST timezones.

problem: Scheduler computed the next run in UTC then applied the offset twice, so digests ran early during DST.
status_detail: fixed in v2.3.0; released.
decisions: Normalize all schedule math to the user's IANA zone before comparing, not after. Regression test added for the DST boundary.
open_questions: null
```

### 6.2 Open feature request, with open questions

A multi-repo grouping feature still under discussion.

```
---
status: open
state_reason: null
refs: ["owner/repo#45"]
labels: [enhancement, digest]
---
tldr: Request to group the digest by team or label instead of a flat per-repo list.

problem: Large multi-repo setups produce a long flat digest; users want to fold issues into team or label sections.
status_detail: in discussion; no implementation started.
decisions: null
open_questions: Group by label, by repo topic, or by a user-defined map? Should grouping be a flag on digest or a separate command?
```

Note in 6.2: `status` is `open`, so `state_reason` is `null`, there is no
`versions` field (no versions mentioned), `decisions` is `null`, and
`status_detail` describes the current state rather than an outcome.
