# issuary auto-compaction worker (example)

A small, self-contained worker that auto-compacts the issues `issuary` says are
pending. It pulls the pending set from `issuary`, asks Claude for a compact in the
canonical format, and writes the result back with `issuary compact set`.

**This is an example, not part of the `issuary` package.** It has its own
`package.json` and its own dependency on the Anthropic SDK. Installing or running
it does not add an LLM dependency to the `issuary` CLI.

## Why the LLM lives here, not in issuary

The issuary core never calls an LLM. From the project's principles
([../../CLAUDE.md](../../CLAUDE.md)): *"a tool e burra, a IA e a CPU da
compactacao."* The tool stores raw issue content, exposes what needs compacting,
and accepts the summary back; the agent that consumes the tool is the
compaction CPU. Keeping the LLM out of the core means:

- the local mirror, change detection, and digest all work with no API key and no
  network round-trip to a model;
- compaction stays an optional layer on top, swappable for any model or any
  human, driven entirely through the documented `compact list` / `compact set`
  contract.

This worker is one concrete implementation of that contract. It is deliberately
outside `src/` so the published binary carries no `@anthropic-ai/sdk` dependency.

## How it works

Per run:

1. `issuary compact list --pending --json --limit <batch>` to get the work.
2. For each pending issue: if `commentsNeedFetch` is `true`, run
   `issuary show <repo>#<n> --raw --json` to pull the full thread; otherwise use the
   `rawBody` already present in the list output.
3. Call the Claude API for a compact in the canonical format (see
   [../../docs/compact-format.md](../../docs/compact-format.md)). The model is
   instructed to output only the compact document.
4. Write the model output to a temp file.
5. `issuary compact set <repo>#<n> --from-file <tmp>` to persist it (this clears the
   stale flag and validates the format).

Errors are handled per issue: a single bad issue is logged and skipped, and the
run continues. A budget cap (`--max`) bounds how many issues one run touches.

## Environment variables

| Var | Required | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API key. |
| `ISSUARY_COMPACT_MODEL` | no | Override the model id. Defaults to a small, fast current Claude model (`claude-haiku-4-5`) for cheap bulk summarization. |
| `ISSUARY_BIN` | no | Path to the `issuary` binary. Defaults to `issuary` on `PATH`. |

## Running it

```sh
cd examples/auto-compact
npm install                 # installs the Anthropic SDK for this example only
export ANTHROPIC_API_KEY=sk-ant-...

# Sync first so the local mirror is fresh (this does NOT call an LLM):
issuary sync

# Then compact what is pending (defaults: --batch 50, --max 20):
node auto-compact.mjs

# Cap the work, or scope to one repo:
node auto-compact.mjs --max 5 --repo octocat/hello

# Pick a different model:
ISSUARY_COMPACT_MODEL=claude-sonnet-4-6 node auto-compact.mjs
```

Options: `--batch <n>` (issues pulled per run, passed to `compact list --limit`),
`--max <n>` (hard cap on issues compacted this run), `--repo <owner/repo>`,
`-h` / `--help`.

## Running it on a schedule (cron)

Run `issuary sync` first (separately) so the worker sees fresh state, then run the
worker. For example, every 15 minutes:

```cron
# m  h  dom mon dow  command
  */15 * * * *  ANTHROPIC_API_KEY=sk-ant-... issuary sync && node /path/to/issuary/examples/auto-compact/auto-compact.mjs --max 20 >> /var/log/issuary-auto-compact.log 2>&1
```

Notes:

- `issuary sync` requires `GITHUB_TOKEN`; export it in the cron environment too.
- Keep `--max` modest so a single run stays within your API budget; whatever is
  left over is picked up on the next run.
- The two steps are intentionally separate: `issuary sync` is the LLM-free core
  doing its job, and the worker is the optional compaction layer on top.
