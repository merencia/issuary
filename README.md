# issuary

CLI to monitor and AI-compact GitHub issues across multiple repositories.

`issuary` keeps a local, incremental mirror of the issues in the repos you watch,
tells you what changed since the last sync (new issues, closed issues, new
comments), and offers a compaction layer: structured summaries written and
consumed by AIs so an agent can understand a whole project's issues without
re-fetching from GitHub or blowing its context window.

The name is "issuary" (issue + -ary): an archive of a project's issues, distilled
into something an agent can read at a glance.

## Core idea

- **Local incremental mirror.** `issuary` mirrors issues from many repos into a
  local SQLite database and only fetches what changed since the last sync.
- **Change detection.** Each sync records events (opened, closed, reopened, new
  comments) so you can see what moved across every watched repo at a glance.
- **AI compaction layer.** `issuary` never calls an LLM. It stores raw issue
  content, exposes which issues need a summary, and accepts the summary back. The
  agent that consumes the tool is the one that writes the summaries. A compact
  saves context tokens for that agent, not disk space: the raw is never deleted.

The core (mirror, change detection, digests) works on its own. Compaction is an
optional layer on top.

## Install

```sh
npm install -g issuary
```

Requirements:

- **Node.js >= 20.**
- **A GitHub token.** Either export `GITHUB_TOKEN` (a personal access token with
  read access to the repos you watch, the `repo` scope or `public_repo` for
  public repos only) or run `issuary login` to authenticate via the browser. See
  [Authentication](#authentication). Commands that hit the GitHub API (`add`,
  `sync`, and `show --raw`) require a token; purely local commands do not.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `GITHUB_TOKEN` | GitHub personal access token used to reach the API. Takes precedence over a token stored by `issuary login`. | (required for API commands unless `issuary login` was run) |
| `GITHUB_API_URL` | REST API base URL. Set this for GitHub Enterprise, e.g. `https://github.example.com/api/v3`. Trailing slashes are trimmed. | `https://api.github.com` |
| `ISSUARY_HOME` | Directory holding local state (the SQLite database and `issuary login` credentials). | `~/.issuary` |
| `ISSUARY_GITHUB_CLIENT_ID` | OAuth App client id used by `issuary login` (device flow). Overrides the baked-in default. | (build default) |
| `ISSUARY_GITHUB_SCOPE` | OAuth scope requested by `issuary login`. | `repo` |

The database lives at `$ISSUARY_HOME/db.sqlite` (so `~/.issuary/db.sqlite` by default).

## Authentication

Commands that hit the GitHub API (`add`, `sync`, `show --raw`) need a token.
There are two ways to provide one:

1. **Export a token.** Set `GITHUB_TOKEN` to a GitHub personal access token with
   read access to the repos you watch (the `repo` scope, or `public_repo` for
   public repos only):

   ```sh
   export GITHUB_TOKEN=ghp_...
   ```

2. **`issuary login` (device flow).** Authenticate in the browser, no manual token
   handling:

   ```sh
   issuary login
   ```

   It prints a short code and a URL. Open the URL, enter the code, and approve.
   `issuary` then stores the resulting token and confirms with `Logged in as <you>.`
   The default scope requested is `repo` so private repos work; override it with
   `ISSUARY_GITHUB_SCOPE` if you only need public access. `issuary login --json` emits
   `{ "ok": true, "login": "<you>", "scopes": [...] }`. The token itself is never
   printed.

**Precedence.** When both are present, the `GITHUB_TOKEN` environment variable
wins over the stored token. So an explicitly exported token always takes effect,
and `issuary login` is the fallback when no env token is set.

**Where the token is stored.** `issuary login` writes the token to
`~/.issuary/credentials.json` (under `$ISSUARY_HOME`), created with file mode `0600`
(owner read/write only). The token is never logged.

**Log out.** `issuary logout` removes the stored token locally:

```sh
issuary logout
```

This only deletes the local credentials file; it does not revoke the token on
GitHub. `issuary logout --json` emits `{ "ok": true, "removed": boolean }`.

### Maintainer setup (device login)

`issuary login` uses the GitHub OAuth **device flow**, which requires a registered
GitHub OAuth App with "Device Flow" enabled. The app's **public** client id must
be available to the CLI: either baked into `DEFAULT_GITHUB_CLIENT_ID` in
`src/auth/client-id.ts` (a device-flow client id is not a secret, so it is safe
to commit) or supplied at runtime via the `ISSUARY_GITHUB_CLIENT_ID` environment
variable. Until a client id is configured, `issuary login` exits with a clear error;
the `GITHUB_TOKEN` path keeps working regardless.

## Quickstart

```sh
# 1. Watch a couple of repos (each is validated against the API).
issuary add octocat/hello-world
issuary add facebook/react

# 2. Mirror their issues locally (incremental: only what changed is fetched).
issuary sync

# 3. See what changed everywhere, as an aggregated inbox.
issuary digest

# 4. List what is open right now, across all repos (read-only, no API calls).
issuary issues

# 5. Get the full project-wide view of one repo's issues.
issuary repo-digest facebook/react

# 6. Read a single issue (compact if present, otherwise raw body).
issuary show facebook/react#123

# Read the same issue's full raw body and comments.
issuary show facebook/react#123 --raw
```

Every command also supports `--json` for machine and AI consumption.

## Command reference

All commands accept `--json`, which prints a single JSON document to stdout and
suppresses the human formatting. Expected, user-facing errors (a malformed
argument, an unwatched repo, a missing issue) print a message to stderr and exit
with a non-zero status.

Four commands answer four different questions, so it helps to keep them apart:

- `issuary list` lists the **repos** you watch.
- `issuary issues` is the **filterable issue list**: "what issues match these
  filters right now?" (state, repo, label, author, since, search, compaction).
- `issuary digest` is the **inbox**: "what changed since I last looked?"
- `issuary repo-digest` is **one project's full memory**: every issue of a single
  repo, compacted where possible.

### `issuary add <owner/repo>`

Start watching a repo. Validates that the repo exists and is accessible via the
GitHub API before recording it. Re-adding a previously removed repo reactivates
it. Requires `GITHUB_TOKEN`.

- Argument: `<owner/repo>`, e.g. `octocat/hello-world`.
- `--json` emits `{ "ok": true, "repo": "<owner/repo>", "status": "added" | "already-watched" | "reactivated" }`.

### `issuary remove <owner/repo>`

Stop watching a repo. This deactivates it; it never deletes, so the repo's
issues and compacts are kept. Local only, no token required.

- Argument: `<owner/repo>`.
- `--json` emits `{ "ok": true, "repo": "<owner/repo>", "status": "removed" | "already-inactive" }`.

### `issuary list`

List watched repos with their state and last sync time. Active repos first, then
inactive. Local only.

- `--json` emits an array of `{ "repo": "<owner/repo>", "active": boolean, "lastSyncedAt": string | null }`.

### `issuary sync [repo]`

Fetch issue updates for watched repos and record what changed. With no argument
it syncs every active repo; with a `[repo]` argument it limits the sync to that
single watched repo. The fetch is incremental (see [How it works](#how-it-works)).
Requires `GITHUB_TOKEN`.

- Argument (optional): `[repo]` as `owner/repo`.
- `--quiet`: print nothing when there was no activity across all repos (no
  events and no errors), so a scheduled/cron run stays silent on a no-op cycle.
  A concise summary is still printed when something changed, and failed repos
  are always printed. Has no effect on `--json`. See [Scheduling](#scheduling).
- `--json` emits `{ "repos": [ { "repo", "notModified", "opened", "closed", "reopened", "commented", "processed" } ] }`,
  one entry per synced repo. `notModified` is `true` when the repo returned a 304
  (nothing changed); the counts are then all zero.

The command exits `0` on success (even when nothing changed) and non-zero when
any repo failed to sync, so a scheduler or monitor can detect failures.

### `issuary digest`

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

### `issuary issues`

List issues across watched repos, with filters. Read-only: it never calls the
GitHub API and never changes local state (it does not mark anything seen). With
no flags it shows OPEN issues across all watched repos, sorted by most recently
updated, grouped by repo, with a count header. Local only, no token required.

Options:

- `--state <open|closed|all>`: which issues to include (default `open`).
- `--repo <owner/repo>`: scope to a watched repo. Repeatable to pass several.
- `--label <name>`: match issues carrying any of these labels. Repeatable; the
  labels are OR-ed (an issue matches if it has at least one).
- `--author <login>`: restrict to issues opened by this user.
- `--state-reason <completed|not_planned>`: restrict by GitHub's close reason.
- `--since <when>`: only issues with `updated_at >=` an ISO date or a relative
  duration (`Nd` / `Nh`, e.g. `7d`, `24h`).
- `--search <text>`: case-insensitive substring match on the issue title.
- `--uncompacted` | `--stale` | `--compacted`: filter by compaction state.
  Mutually exclusive (passing more than one is an error).
- `--sort <updated|created|number>` (default `updated`) and
  `--order <asc|desc>` (default `desc`).
- `--limit <n>`: cap the number of issues returned.
- `--json` (see shape below).

Examples:

```sh
# What is open right now, everywhere.
issuary issues

# Everything, including closed.
issuary issues --state all

# One project, only bugs.
issuary issues --repo facebook/react --label bug

# Issues touched in the last week.
issuary issues --since 7d

# Issues whose memory still needs writing.
issuary issues --uncompacted

# Find by title, as JSON for an agent.
issuary issues --search "timezone" --json
```

Sample human output:

```
3 open issues across 2 repos (filter: labels=bug)

facebook/react:
  #321  [open]  Hooks break with timezones {bug, timezone} (4c) (uncompacted)
  #204  [open]  Crash on hydrate {bug} (2c)

octocat/hello-world:
  #12   [open]  Typo in error message {bug}
```

The `{...}` are labels, `(Nc)` is the comment count, and a trailing `(stale)` or
`(uncompacted)` marks issues whose compact is missing or out of date (nothing is
shown when the compact is fresh).

`--json` emits:

```json
{
  "filters": {
    "state": "open", "repos": null, "labels": ["bug"], "author": null,
    "stateReason": null, "since": null, "search": null, "compaction": null,
    "sort": "updated", "order": "desc", "limit": null
  },
  "summary": { "total": 3, "open": 3, "closed": 0, "repos": 2 },
  "issues": [
    {
      "repo": "facebook/react", "number": 321, "title": "Hooks break with timezones",
      "state": "open", "stateReason": null, "author": "ann",
      "labels": ["bug", "timezone"], "commentCount": 4,
      "createdAt": "...", "updatedAt": "...",
      "compact": null, "compactTldr": null, "compacted": false, "stale": false,
      "refs": ["#204"]
    }
  ]
}
```

The `compact` field carries the full canonical compact when one exists,
`compactTldr` its one-line headline, and `compacted` / `stale` say whether it is
fresh. Raw bodies and comments are intentionally not included here; use
`issuary show <repo>#<n> --raw` for those.

### `issuary repo-digest <repo>`

Consume all issues of one watched repo as a project-wide, AI-optimized view. For
each issue it prefers a fresh compact and falls back to the raw body, flagging
which issues an AI may want to (re)compact. The header summarizes totals (open,
closed, compacted, stale or uncompacted). Local only.

- Argument: `<repo>` as `owner/repo`.
- `--headlines`: list every issue using only its cheap `tldr` headline (roughly
  20 tokens per issue), falling back to the issue title when there is no `tldr`.
- `--json` (full) emits `{ "repo", "summary": { "total", "open", "closed", "compacted", "staleOrUncompacted" }, "issues": [ { "number", "state", "stateReason", "title", "representation", "compacted", "stale", "refs" } ] }`.
- `--headlines --json` emits `{ "repo", "summary": {...}, "headlines": [ { "number", "state", "headline", "fromTldr" } ] }`.

### `issuary show <target>`

Display a single issue from the local store. By default it shows the compact if a
fresh one exists, otherwise the raw body. Local only by default.

- Argument: `<target>` as `owner/repo#number`, e.g. `facebook/react#123`.
- `--raw`: include the full raw body and the comment thread. Comments are fetched
  on demand the first time and then cached, so `--raw` requires `GITHUB_TOKEN`.
- `--json` emits the issue's fields: `{ "repo", "number", "title", "state", "stateReason", "author", "labels", "commentCount", "createdAt", "updatedAt", "closedAt", "compact", "compactStale", "rawBody", "refs" }`, plus `"comments"` when `--raw` is set.

### `issuary compact list`

List issues with their compaction status (`compacted`, `stale`, or
`uncompacted`), grouped by repo. Local only.

- `--pending`: narrow to the actionable set, only issues that are uncompacted or
  stale (the work an AI needs to do). Each pending item carries a `reason`.
- `--repo <owner/repo>`: restrict to a single watched repo.
- `--json` emits an array of `{ "repo", "number", "title", "state", "status", "reason", "rawBody", "commentsNeedFetch" }`.
  `reason` is `"uncompacted"` or `"stale"` for pending issues and `null` for
  fresh ones. `commentsNeedFetch` is `true` when the issue has comments that have
  not been pulled yet, a hint to run `issuary show <repo>#<n> --raw` before
  compacting.

### `issuary compact set <target> --from-file <file>`

Persist a compact for an issue from a file in the canonical format. The file is
parsed and validated; an invalid compact is rejected. Saving a compact clears the
issue's stale flag. Local only.

- Argument: `<target>` as `owner/repo#number`.
- `--from-file <file>` (required): path to the compact file to read.
- `--json` emits `{ "ok": true, "repo", "number", "tldr" }`.

### `issuary protocol`

Print the AI compaction protocol, the contract AI consumers follow. This is the
self-describing usage that an agent can read to discover how compaction works.

- `--json` emits `{ "protocol": string, "compactFormat": { "doc", "frontmatterFields", "bodyFields", "persistCommand" } }`.

### `issuary skill`

Emit issuary's neutral agent skill, or install it for an AI agent. The content is
vendor-neutral: it teaches an agent what issuary is, when to reach for it, and where
to find the exact contract (`issuary protocol`, `issuary --help`).

- No flags: print the skill to stdout. This is the universal path: paste it into
  any agent's system prompt or rules file.
- `--install --format claude` (the default format): write
  `~/.claude/skills/issuary/SKILL.md` (override the skills root with `--dir` or
  `CLAUDE_SKILLS_DIR`).
- `--install --format agents`: insert or replace a delimited, idempotent issuary
  section in an `AGENTS.md` at the project root (override the directory with
  `--dir`). Running it twice yields exactly one section; existing unrelated
  content is preserved.
- `--json` emits `{ "name", "description", "path", "content", "format" }`.

### `issuary login`

Authenticate with GitHub via the OAuth device flow and store the token at
`~/.issuary/credentials.json` (mode `0600`). Prints a user code and a verification
URL to open in the browser, polls until you authorize, then confirms with
`Logged in as <you>.` See [Authentication](#authentication).

- `--json` emits `{ "ok": true, "login": "<you>", "scopes": [...] }`.

### `issuary logout`

Remove the locally stored token. Local only; it does not revoke the token on
GitHub.

- `--json` emits `{ "ok": true, "removed": boolean }`.

## For AI agents

`issuary` does not call any LLM itself. It stores raw issue content, exposes which
issues need a summary, and accepts the summary back. The agent that consumes the
tool is the compaction CPU; `issuary` only stores and serves.

### issuary vs GitHub's MCP

They are complementary, not competing. GitHub's MCP server gives live, raw access
to issues, use it when you need the current, unfiltered state of an issue or its
comment thread. `issuary` is not another raw-issue reader: its value is the
persistent, compacted memory of issues plus the cross-repo digest of what changed
since you last looked. Use GitHub's MCP for live, raw access, and `issuary` for the
distilled memory and the "what changed" digest.

### Reading the memory with filters

`issuary issues --json` is the filtered entry point into the memory. Pass any of
the filters (`--state`, `--repo`, `--label`, `--author`, `--since`, `--search`,
`--uncompacted` / `--stale` / `--compacted`) and you get back the matching issues
with their `compact`, `compactTldr`, `refs`, and the `compacted` / `stale` flags,
without raw bodies. It complements the other two read paths:
`issuary repo-digest <repo> --json` for one project's full dump, and
`issuary show <repo>#<n> --json` for a single issue (add `--raw` for the body and
comments). Reach for `issues --json` when you want a slice of the memory ("open
bugs across all repos", "anything touched this week", "what still needs
compacting") rather than a whole project or a single issue.

### Teaching an agent to use issuary

`issuary skill` emits a neutral skill document that explains all of this. Print it
(`issuary skill`) and paste it into any agent's system prompt or rules file, or
install it: `issuary skill --install --format claude` writes
`~/.claude/skills/issuary/SKILL.md` for Claude Code, and
`issuary skill --install --format agents` inserts an idempotent issuary section into a
project `AGENTS.md`. See the [`issuary skill`](#issuary-skill) command reference.

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
issuary compact list --pending --json

# 2. Read the raw body and comments for one of them
#    (comments are fetched on demand).
issuary show owner/repo#123 --raw --json

# 3. Write a compact in the canonical format to a file, then persist it.
#    Persisting clears the stale flag.
issuary compact set owner/repo#123 --from-file compact.md

# 4. Re-compact whenever an issue goes stale again after a future sync.
```

Run `issuary protocol` to get the contract as text (or `issuary protocol --json` for
the structured form). The full, authoritative, field-by-field compact format,
with rules and worked examples, is in
[docs/compact-format.md](./docs/compact-format.md).

To automate this loop, see the optional auto-compaction worker in
[examples/auto-compact/](./examples/auto-compact/): a small companion script that
batches the pending set (`compact list --pending --limit`), calls an LLM, and
writes the compacts back. It lives outside the CLI on purpose: `issuary` itself
never calls an LLM, so the worker keeps that dependency in the example, not the
core.

## How it works

- **Local SQLite mirror.** State lives in a single SQLite database at
  `~/.issuary/db.sqlite` (override the directory with `ISSUARY_HOME`).
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

## Scheduling

`issuary` is not a daemon. To keep the mirror fresh, let your OS scheduler run
`issuary sync --quiet` on an interval. Quiet mode stays silent on a no-op cycle (no
events, no errors), prints a summary when something changed, always prints
failed repos, and exits non-zero when any repo failed so a monitor can react.

See [docs/scheduling.md](./docs/scheduling.md) for ready-to-use crontab and
macOS launchd recipes, plus notes on rate limits and how failures surface.

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
