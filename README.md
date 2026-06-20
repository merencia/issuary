# lore

CLI to monitor and AI-compact GitHub issues across multiple repositories.

`lore` keeps a local, incremental mirror of the issues in the repos you watch,
tells you what changed since the last sync (new issues, closed issues, new
comments), and offers a compaction layer: structured summaries written and
consumed by AIs so an agent can understand a whole project's issues without
re-fetching from GitHub or blowing its context window.

The name is the *lore*: the accumulated, distilled knowledge of a project's
issues.

## Core idea

- **Local incremental mirror.** `lore` mirrors issues from many repos into a
  local SQLite database and only fetches what changed since the last sync.
- **Change detection.** Each sync records events (opened, closed, reopened, new
  comments) so you can see what moved across every watched repo at a glance.
- **AI compaction layer.** `lore` never calls an LLM. It stores raw issue
  content, exposes which issues need a summary, and accepts the summary back. The
  agent that consumes the tool is the one that writes the summaries. A compact
  saves context tokens for that agent, not disk space: the raw is never deleted.

The core (mirror, change detection, digests) works on its own. Compaction is an
optional layer on top.

## Install

```sh
npm install -g @merencia/lore
```

Requirements:

- **Node.js >= 20.**
- **A `GITHUB_TOKEN`** in the environment, a GitHub personal access token with
  read access to the repos you watch (the `repo` scope, or `public_repo` for
  public repos only). Commands that hit the GitHub API (`add`, `sync`, and
  `show --raw`) require it; purely local commands do not.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `GITHUB_TOKEN` | GitHub personal access token used to reach the API. | (required for API commands) |
| `GITHUB_API_URL` | REST API base URL. Set this for GitHub Enterprise, e.g. `https://github.example.com/api/v3`. Trailing slashes are trimmed. | `https://api.github.com` |
| `LORE_HOME` | Directory holding local state (the SQLite database). | `~/.lore` |

The database lives at `$LORE_HOME/db.sqlite` (so `~/.lore/db.sqlite` by default).

## Quickstart

```sh
# 1. Watch a couple of repos (each is validated against the API).
lore add octocat/hello-world
lore add facebook/react

# 2. Mirror their issues locally (incremental: only what changed is fetched).
lore sync

# 3. See what changed everywhere, as an aggregated inbox.
lore digest

# 4. Get the full project-wide view of one repo's issues.
lore repo-digest facebook/react

# 5. Read a single issue (compact if present, otherwise raw body).
lore show facebook/react#123

# Read the same issue's full raw body and comments.
lore show facebook/react#123 --raw
```

Every command also supports `--json` for machine and AI consumption.

## Command reference

All commands accept `--json`, which prints a single JSON document to stdout and
suppresses the human formatting. Expected, user-facing errors (a malformed
argument, an unwatched repo, a missing issue) print a message to stderr and exit
with a non-zero status.

### `lore add <owner/repo>`

Start watching a repo. Validates that the repo exists and is accessible via the
GitHub API before recording it. Re-adding a previously removed repo reactivates
it. Requires `GITHUB_TOKEN`.

- Argument: `<owner/repo>`, e.g. `octocat/hello-world`.
- `--json` emits `{ "ok": true, "repo": "<owner/repo>", "status": "added" | "already-watched" | "reactivated" }`.

### `lore remove <owner/repo>`

Stop watching a repo. This deactivates it; it never deletes, so the repo's
issues and compacts are kept. Local only, no token required.

- Argument: `<owner/repo>`.
- `--json` emits `{ "ok": true, "repo": "<owner/repo>", "status": "removed" | "already-inactive" }`.

### `lore list`

List watched repos with their state and last sync time. Active repos first, then
inactive. Local only.

- `--json` emits an array of `{ "repo": "<owner/repo>", "active": boolean, "lastSyncedAt": string | null }`.

### `lore sync [repo]`

Fetch issue updates for watched repos and record what changed. With no argument
it syncs every active repo; with a `[repo]` argument it limits the sync to that
single watched repo. The fetch is incremental (see [How it works](#how-it-works)).
Requires `GITHUB_TOKEN`.

- Argument (optional): `[repo]` as `owner/repo`.
- `--json` emits `{ "repos": [ { "repo", "notModified", "opened", "closed", "reopened", "commented", "processed" } ] }`,
  one entry per synced repo. `notModified` is `true` when the repo returned a 304
  (nothing changed); the counts are then all zero.

### `lore digest`

Show an aggregated inbox of issue changes across all watched repos, grouped by
repo and then by change type (new issues, closed, new comments, closed with new
comment, reopened).

Three modes:

- **Default (inbox):** shows unseen events, then marks them seen so each change
  appears only once.
- `--since <when>`: a read-only time window showing events at or after `<when>`.
  Accepts an ISO-8601 date or a simple relative duration: `<n>d` (days) or
  `<n>h` (hours), e.g. `7d` or `24h`. Does not mark anything seen.
- `--all`: every event, seen and unseen. Does not mark anything seen.

Options:

- `--since <when>`: ISO date or `Nd` / `Nh` duration.
- `--all`: show all events without marking any seen.
- `--repo <owner/repo>`: narrow any mode to a single watched repo.
- `--json` emits `{ "mode": "inbox" | "since" | "all", "total": number, "repos": [ { "repo", "groups": [ { "type", "events": [...] } ] } ] }`.

Local only, no token required.

### `lore repo-digest <repo>`

Consume all issues of one watched repo as a project-wide, AI-optimized view. For
each issue it prefers a fresh compact and falls back to the raw body, flagging
which issues an AI may want to (re)compact. The header summarizes totals (open,
closed, compacted, stale or uncompacted). Local only.

- Argument: `<repo>` as `owner/repo`.
- `--headlines`: list every issue using only its cheap `tldr` headline (roughly
  20 tokens per issue), falling back to the issue title when there is no `tldr`.
- `--json` (full) emits `{ "repo", "summary": { "total", "open", "closed", "compacted", "staleOrUncompacted" }, "issues": [ { "number", "state", "stateReason", "title", "representation", "compacted", "stale", "refs" } ] }`.
- `--headlines --json` emits `{ "repo", "summary": {...}, "headlines": [ { "number", "state", "headline", "fromTldr" } ] }`.

### `lore show <target>`

Display a single issue from the local store. By default it shows the compact if a
fresh one exists, otherwise the raw body. Local only by default.

- Argument: `<target>` as `owner/repo#number`, e.g. `facebook/react#123`.
- `--raw`: include the full raw body and the comment thread. Comments are fetched
  on demand the first time and then cached, so `--raw` requires `GITHUB_TOKEN`.
- `--json` emits the issue's fields: `{ "repo", "number", "title", "state", "stateReason", "author", "labels", "commentCount", "createdAt", "updatedAt", "closedAt", "compact", "compactStale", "rawBody", "refs" }`, plus `"comments"` when `--raw` is set.

### `lore compact list`

List issues with their compaction status (`compacted`, `stale`, or
`uncompacted`), grouped by repo. Local only.

- `--pending`: narrow to the actionable set, only issues that are uncompacted or
  stale (the work an AI needs to do). Each pending item carries a `reason`.
- `--repo <owner/repo>`: restrict to a single watched repo.
- `--json` emits an array of `{ "repo", "number", "title", "state", "status", "reason", "rawBody", "commentsNeedFetch" }`.
  `reason` is `"uncompacted"` or `"stale"` for pending issues and `null` for
  fresh ones. `commentsNeedFetch` is `true` when the issue has comments that have
  not been pulled yet, a hint to run `lore show <repo>#<n> --raw` before
  compacting.

### `lore compact set <target> --from-file <file>`

Persist a compact for an issue from a file in the canonical format. The file is
parsed and validated; an invalid compact is rejected. Saving a compact clears the
issue's stale flag. Local only.

- Argument: `<target>` as `owner/repo#number`.
- `--from-file <file>` (required): path to the compact file to read.
- `--json` emits `{ "ok": true, "repo", "number", "tldr" }`.

### `lore protocol`

Print the AI compaction protocol, the contract AI consumers follow. This is the
self-describing usage that an agent can read to discover how compaction works.

- `--json` emits `{ "protocol": string, "compactFormat": { "doc", "frontmatterFields", "bodyFields", "persistCommand" } }`.

## For AI agents

`lore` does not call any LLM itself. It stores raw issue content, exposes which
issues need a summary, and accepts the summary back. The agent that consumes the
tool is the compaction CPU; `lore` only stores and serves.

Each issue carries two fields that drive the workflow:

- `compact`: the AI-written structured summary, or `null` if none exists.
- `compact_stale`: `true` when the compact no longer reflects the issue (set by
  `sync` when a new comment lands on an already-compacted issue).

The protocol:

1. **If `compact != null` and `compact_stale == false`, use the compact.** Do not
   read the raw, do not recompact. It is trusted and current.
2. **If `compact == null` or `compact_stale == true`, recompact.** Read the raw,
   write a fresh compact in the canonical format, and persist it.

A typical agent loop:

```sh
# 1. Find the work: issues that are uncompacted or stale.
lore compact list --pending --json

# 2. Read the raw body and comments for one of them
#    (comments are fetched on demand).
lore show owner/repo#123 --raw --json

# 3. Write a compact in the canonical format to a file, then persist it.
#    Persisting clears the stale flag.
lore compact set owner/repo#123 --from-file compact.md

# 4. Re-compact whenever an issue goes stale again after a future sync.
```

Run `lore protocol` to get the contract as text (or `lore protocol --json` for
the structured form). The full, authoritative, field-by-field compact format,
with rules and worked examples, is in
[docs/compact-format.md](./docs/compact-format.md).

To automate this loop, see the optional auto-compaction worker in
[examples/auto-compact/](./examples/auto-compact/): a small companion script that
batches the pending set (`compact list --pending --limit`), calls an LLM, and
writes the compacts back. It lives outside the CLI on purpose: `lore` itself
never calls an LLM, so the worker keeps that dependency in the example, not the
core.

## How it works

- **Local SQLite mirror.** State lives in a single SQLite database at
  `~/.lore/db.sqlite` (override the directory with `LORE_HOME`).
- **Incremental sync.** `sync` fetches issues with the GitHub `since` parameter
  and an `ETag`. When nothing changed the API returns `304 Not Modified`, which
  does not spend your rate limit and is reported as `unchanged`.
- **Comments on demand.** Comment threads are not pulled on every sync. They are
  fetched the first time you need them (via `show --raw`) and then cached.
- **Raw is never deleted.** Compacting adds a summary layer on top of the raw
  body and comments; it never removes them. You can always re-read the raw and
  re-compact. The win from compaction is context tokens for the consuming agent,
  not disk space.
- **Removal is deactivation.** `remove` deactivates a repo rather than deleting
  it, so its issues and compacts are preserved as history.

## Development

```sh
npm install
npm run check   # lint + format:check + typecheck + test
npm run build   # bundle to dist/cli.js
```

`npm run check` is the quality gate: ESLint, Prettier (`format:check`),
`tsc --noEmit`, and the Vitest suite. CI (`.github/workflows/ci.yml`) runs the
same gate plus the build across the Node 20, 22, and 24 matrix; a PR is only
mergeable with CI green.

## License

ISC, Lucas Merencia.
