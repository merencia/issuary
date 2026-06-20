# lore

CLI to monitor and AI-compact GitHub issues across multiple repositories.

`lore` keeps a local, incremental mirror of the issues in the repos you watch,
tells you what changed since the last sync (new issues, closed issues, new
comments), and offers a compaction layer: structured summaries written and
consumed by AIs so an agent can understand a whole project's issues without
re-fetching from GitHub or blowing its context window.

> Status: early development. See `.local/PLAN.md` for the design and
> `.local/TASKS.md` for the roadmap.

## Install

```sh
npm install -g @merencia/lore
```

Requires Node.js >= 20 and a `GITHUB_TOKEN` in the environment.

## Usage

```sh
lore add owner/repo            # start watching a repo
lore sync                      # incremental fetch of all watched repos
lore digest                    # aggregated inbox: what changed everywhere
lore repo-digest owner/repo    # full view of one project's issues
lore show owner/repo#123       # one issue (raw or compacted)
lore protocol                  # the AI compaction contract
```

Every command supports `--json` for machine/AI consumption.

## For AI agents

`lore` does not call any LLM itself. It stores raw issue content and exposes a
compaction protocol that an agent follows to write and reuse summaries. Run
`lore protocol` (or read [CLAUDE.md](./CLAUDE.md)) for the contract.

## Development

```sh
npm install
npm run check   # lint + format + typecheck + test
npm run build
```

## License

ISC © Lucas Merencia
