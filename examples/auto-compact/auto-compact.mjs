#!/usr/bin/env node
// @ts-nocheck
/**
 * lore auto-compaction worker (example, NOT part of @merencia/lore).
 *
 * The lore CORE never calls an LLM (see ../../CLAUDE.md, principle 2: "a tool e
 * burra, a IA e a CPU"). lore only stores raw issue content, exposes what needs
 * compacting, and accepts the summary back. This worker is the "CPU": it reads
 * the pending set from lore, asks Claude for a compact in the canonical format,
 * and writes it back. It lives here under examples/ so the published CLI keeps
 * no LLM dependency.
 *
 * Pipeline per run:
 *   1. lore compact list --pending --json --limit <BATCH>
 *   2. for each pending issue:
 *        - if commentsNeedFetch, lore show <repo>#<n> --raw --json (full thread)
 *        - otherwise use the rawBody already present
 *   3. ask Claude for the compact (canonical format, see ../../docs/compact-format.md)
 *   4. write the model output to a temp file
 *   5. lore compact set <repo>#<n> --from-file <tmp>
 *
 * Errors are handled per-issue: one bad issue is logged and skipped, the run
 * continues. A budget cap (--max) bounds how many issues a single run touches.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY    required, the Claude API key.
 *   LORE_COMPACT_MODEL   optional, overrides the default model id.
 *   LORE_BIN             optional, path to the lore binary (default: "lore").
 *
 * Run `lore sync` first (separately) so the local mirror is fresh; this worker
 * only reads what lore already has.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Default model: a small, fast, current Claude model for cheap bulk
 * summarization. Override with LORE_COMPACT_MODEL when you want a different tier.
 */
const DEFAULT_MODEL = "claude-haiku-4-5";

/** The lore binary to shell out to. Override via LORE_BIN. */
const LORE_BIN = process.env.LORE_BIN || "lore";

/** Parse `--flag value` / `--flag=value` pairs from argv. */
function parseArgs(argv) {
  const out = { batch: 50, max: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [flag, inlineValue] = eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const next = () => (inlineValue !== undefined ? inlineValue : argv[(i += 1)]);
    const intValue = (f) => {
      const n = Number.parseInt(next(), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${f} expects a positive integer`);
      }
      return n;
    };
    if (flag === "--batch") {
      out.batch = intValue("--batch");
    } else if (flag === "--max") {
      out.max = intValue("--max");
    } else if (flag === "--repo") {
      out.repo = next();
    } else if (flag === "--help" || flag === "-h") {
      out.help = true;
    }
  }
  return out;
}

const HELP = `lore auto-compaction worker (example)

Usage: node auto-compact.mjs [options]

Options:
  --batch <n>   issues to pull from lore per run (passed to compact list --limit; default 50)
  --max <n>     hard budget cap on issues compacted this run (default 20)
  --repo <r>    restrict to a single watched repo (owner/repo)
  -h, --help    show this help

Env: ANTHROPIC_API_KEY (required), LORE_COMPACT_MODEL, LORE_BIN`;

/**
 * Run the lore CLI and return parsed JSON stdout. Throws on a non-zero exit or
 * unparseable output so the caller can decide whether to skip or abort.
 */
function runLoreJson(args) {
  const result = spawnSync(LORE_BIN, args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Failed to run "${LORE_BIN} ${args.join(" ")}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`"${LORE_BIN} ${args.join(" ")}" exited ${result.status}: ${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse JSON from "${LORE_BIN} ${args.join(" ")}": ${error.message}`);
  }
}

/** Run the lore CLI for its side effect, throwing on a non-zero exit. */
function runLore(args) {
  const result = spawnSync(LORE_BIN, args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Failed to run "${LORE_BIN} ${args.join(" ")}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`"${LORE_BIN} ${args.join(" ")}" exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Build the full text we hand to the model for one issue: the title, the raw
 * body, the API-derived frontmatter facts (status, state_reason, labels), and
 * the comment thread when present.
 */
function buildIssueText(item, full) {
  const lines = [`Repo: ${item.repo}`, `Issue: #${item.number}`, `Title: ${item.title}`, `State: ${item.state}`];
  if (full) {
    if (full.stateReason != null) {
      lines.push(`state_reason (from API): ${full.stateReason}`);
    }
    if (Array.isArray(full.labels) && full.labels.length > 0) {
      lines.push(`Labels (from API): ${full.labels.join(", ")}`);
    }
    if (Array.isArray(full.refs) && full.refs.length > 0) {
      lines.push(`Refs found in issue: ${full.refs.join(", ")}`);
    }
  }
  lines.push("", "Body:", (full?.rawBody ?? item.rawBody) || "(no body)");

  const comments = full?.comments ?? [];
  if (comments.length > 0) {
    lines.push("", "Comments:");
    for (const c of comments) {
      lines.push(`- @${c.author ?? "unknown"} (${c.created_at}): ${c.body ?? ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * The system prompt that pins the model to the canonical compact format. Kept
 * in sync with ../../docs/compact-format.md; the model must output ONLY the
 * compact document (frontmatter + body), no prose around it.
 */
const SYSTEM_PROMPT = `You compact a single GitHub issue into the canonical "lore compact" format.

Output ONLY the compact document, nothing else: no preamble, no code fences, no commentary.

Format (exact field order, frontmatter then body):
---
status: open | closed
state_reason: completed | not_planned | null
refs: ["#812", "owner/repo#45", "PR #820"]
versions: { affected: "...", fixed: "..." }
labels: [bug, timezone]
---
tldr: <one sentence, <= ~20 words, stands alone>

problem: <what is wrong or being requested>
status_detail: <where it stands: blocked on X / awaiting repro / fixed in vN>
decisions: <what was decided and why | null>
open_questions: <what remains open | null>

Rules:
- status, state_reason, and labels come from the API facts given to you. NEVER invent state_reason; an open issue has state_reason: null.
- refs are preserved literally, exactly as written (e.g. "#812", "PR #820"); omit the field or use [] if none.
- include versions only if versions are actually mentioned; do not invent a fixed version for an open issue.
- only keep labels that carry signal for an AI consumer; drop process noise.
- body fields keep the fixed order tldr, problem, status_detail, decisions, open_questions.
- an empty textual field is the literal null. Do not repeat the title. Soft cap ~8 lines in the body.`;

/** Ask Claude for the compact document for one issue. Returns the raw text. */
async function compactOne(client, model, item, full) {
  const userText = buildIssueText(item, full);
  // Anthropic Messages API shape: model + max_tokens + messages, content blocks
  // narrowed by type. Default max_tokens is comfortable for a
  // small structured document; this is a non-streaming request.
  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText }],
  });

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) {
    throw new Error("model returned no text content");
  }
  return text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Export your Claude API key first.");
    process.exitCode = 1;
    return;
  }

  const model = process.env.LORE_COMPACT_MODEL || DEFAULT_MODEL;
  // Imported lazily so --help and the env checks above work before
  // `npm install` has pulled the SDK into this example.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const listArgs = ["compact", "list", "--pending", "--json", "--limit", String(args.batch)];
  if (args.repo) {
    listArgs.push("--repo", args.repo);
  }

  let pending;
  try {
    pending = runLoreJson(listArgs);
  } catch (error) {
    console.error(`Could not list pending issues: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (pending.length === 0) {
    console.log("Nothing to compact. Every watched issue has a fresh compact.");
    return;
  }

  const budget = Math.max(0, args.max);
  const work = pending.slice(0, budget);
  console.log(`Pending: ${pending.length}. Compacting up to ${work.length} this run with model ${model}.`);

  const tmpDir = mkdtempSync(join(tmpdir(), "lore-auto-compact-"));
  let compacted = 0;
  let failed = 0;
  try {
    for (const item of work) {
      const target = `${item.repo}#${item.number}`;
      try {
        let full = null;
        if (item.commentsNeedFetch) {
          full = runLoreJson(["show", target, "--raw", "--json"]);
        }

        const compact = await compactOne(client, model, item, full);

        const tmpFile = join(tmpDir, `${item.repo.replace(/\//g, "_")}-${item.number}.md`);
        writeFileSync(tmpFile, compact.endsWith("\n") ? compact : `${compact}\n`, "utf8");

        // lore validates the compact on `set`; an invalid one throws here and
        // is treated as a per-issue failure rather than aborting the run.
        runLore(["compact", "set", target, "--from-file", tmpFile]);
        compacted += 1;
        console.log(`  compacted ${target} (${item.reason})`);
      } catch (error) {
        failed += 1;
        console.error(`  skipped ${target}: ${error.message}`);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`Done. Compacted ${compacted}, failed ${failed}, ${pending.length - work.length} left for the next run.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
