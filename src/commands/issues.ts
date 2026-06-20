import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { compactMark, countHeader, dim, labelChips, repoHeader, stateBadge } from "../render/index.js";
import { openStore, type IssueWithRepo, type QueryIssuesFilter, type Store } from "../store/index.js";
import { DigestError, resolveSince } from "./digest.js";

/**
 * Error thrown by the `issues` action for expected, user-facing failures (an
 * unwatched `--repo`, a malformed `--since`, mutually exclusive compaction
 * flags). The CLI prints the message and exits non-zero.
 */
export class IssuesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuesError";
  }
}

/** Which compaction state to filter on; mutually exclusive at the CLI. */
export type CompactionFilter = "uncompacted" | "stale" | "compacted";

/** Options for {@link runIssues}, mirroring the CLI flags. */
export interface IssuesOptions {
  /** Issue state to include. Default `open`. */
  state?: "open" | "closed" | "all";
  /** Scope to one or more watched repos, as `owner/name`. */
  repo?: string[];
  /** Match issues carrying ANY of these labels (OR semantics). */
  label?: string[];
  /** Restrict to this author login. */
  author?: string;
  /** Restrict to this GitHub `state_reason`. */
  stateReason?: string;
  /** Only issues with `updated_at >= since` (ISO-8601 or duration like `7d`, `24h`). */
  since?: string;
  /** Case-insensitive substring match on the issue title. */
  search?: string;
  /** Only uncompacted issues (mutually exclusive with `stale`/`compacted`). */
  uncompacted?: boolean;
  /** Only stale-compact issues (mutually exclusive with `uncompacted`/`compacted`). */
  stale?: boolean;
  /** Only fresh-compacted issues (mutually exclusive with `uncompacted`/`stale`). */
  compacted?: boolean;
  /** Sort key. Default `updated`. */
  sort?: "updated" | "created" | "number";
  /** Sort direction. Default `desc`. */
  order?: "asc" | "desc";
  /** Cap the number of issues returned. */
  limit?: number;
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/** The normalized filter, echoed back in the `--json` envelope. */
export interface IssuesFilters {
  state: "open" | "closed" | "all";
  repos: string[] | null;
  labels: string[] | null;
  author: string | null;
  stateReason: string | null;
  since: string | null;
  search: string | null;
  compaction: CompactionFilter | null;
  sort: "updated" | "created" | "number";
  order: "asc" | "desc";
  limit: number | null;
}

/** Aggregate counts over the matched issues. */
export interface IssuesSummary {
  /** Total issues matched. */
  total: number;
  /** Number of matched issues that are open. */
  open: number;
  /** Number of matched issues that are closed. */
  closed: number;
  /** Number of distinct repos represented in the result. */
  repos: number;
}

/**
 * A single issue in the listing. Reuses the field shape of `repo-digest`
 * (plus the owning repo and the cheap compaction signals) so AI consumers see a
 * consistent issue object. Raw body and comments are intentionally omitted;
 * those belong to `issuary show --raw`.
 */
export interface IssuesItem {
  /** The owning repo's `owner/name`. */
  repo: string;
  number: number;
  title: string;
  /** `open` or `closed`. */
  state: string;
  /** `completed`, `not_planned`, or null (from the GitHub API). */
  stateReason: string | null;
  author: string | null;
  /** Label names parsed from the stored JSON array (empty when none). */
  labels: string[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  /** The full compact in the canonical format, or null when uncompacted. */
  compact: string | null;
  /** The compact `tldr` headline, or null. */
  compactTldr: string | null;
  /** Whether a fresh, trustworthy compact exists. */
  compacted: boolean;
  /** Whether a compact exists but is stale. */
  stale: boolean;
  /** Explicit references parsed out of the issue (e.g. `#812`, `owner/repo#45`). */
  refs: string[];
}

/** The `issues` result, mirrored in `--json` output. */
export interface IssuesResult {
  filters: IssuesFilters;
  summary: IssuesSummary;
  issues: IssuesItem[];
}

/**
 * Resolves the mutually exclusive `--uncompacted` / `--stale` / `--compacted`
 * flags into a single compaction filter.
 *
 * @throws {IssuesError} When more than one of the three is passed.
 */
export function resolveCompaction(options: IssuesOptions): CompactionFilter | null {
  const selected: CompactionFilter[] = [];
  if (options.uncompacted) {
    selected.push("uncompacted");
  }
  if (options.stale) {
    selected.push("stale");
  }
  if (options.compacted) {
    selected.push("compacted");
  }
  if (selected.length > 1) {
    throw new IssuesError("Use at most one of --uncompacted, --stale, or --compacted; they are mutually exclusive.");
  }
  return selected[0] ?? null;
}

/** Parses an issue's stored labels JSON into a string array, tolerating null/garbage. */
function parseLabels(labels: string | null): string[] {
  if (!labels) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(labels);
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

/** Whether an issue carries a fresh, trustworthy compact (protocol rule). */
function isFresh(issue: IssueWithRepo): boolean {
  return issue.compact != null && !issue.compactStale;
}

/**
 * Core action for `issuary issues`: the filterable, cross-repo, state-based
 * listing of issues. STRICTLY READ-ONLY: no API calls, no state mutation.
 *
 * Resolves `--repo` full names to ids (erroring on an unwatched repo), resolves
 * `--since`, validates the mutually exclusive compaction flags, queries the
 * store, and builds the result with per-issue compaction flags and refs.
 *
 * Separated from the Commander wiring so it can be tested without spawning a
 * process. The caller is responsible for opening/closing the {@link Store}.
 *
 * @throws {IssuesError} For expected, user-facing failures.
 */
export function runIssues(store: Store, options: IssuesOptions = {}): IssuesResult {
  const state = options.state ?? "open";
  const sort = options.sort ?? "updated";
  const order = options.order ?? "desc";
  const compaction = resolveCompaction(options);

  let repoIds: number[] | undefined;
  if (options.repo && options.repo.length > 0) {
    repoIds = options.repo.map((fullName) => {
      const repo = store.getRepoByFullName(fullName);
      if (!repo) {
        throw new IssuesError(`Repo "${fullName}" is not watched. Add it with \`issuary add ${fullName}\` first.`);
      }
      return repo.id;
    });
  }

  let since: string | undefined;
  if (options.since) {
    try {
      since = resolveSince(options.since);
    } catch (error) {
      if (error instanceof DigestError) {
        throw new IssuesError(error.message);
      }
      throw error;
    }
  }

  const filter: QueryIssuesFilter = {
    state,
    repoIds,
    labels: options.label && options.label.length > 0 ? options.label : undefined,
    author: options.author,
    stateReason: options.stateReason,
    since,
    search: options.search,
    compaction: compaction ?? undefined,
    sort,
    order,
    limit: options.limit,
  };

  const rows = store.queryIssues(filter);

  let open = 0;
  const repoSet = new Set<string>();
  const issues: IssuesItem[] = rows.map((issue) => {
    if (issue.state === "open") {
      open += 1;
    }
    repoSet.add(issue.repoFullName);
    const fresh = isFresh(issue);
    return {
      repo: issue.repoFullName,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      stateReason: issue.stateReason,
      author: issue.author,
      labels: parseLabels(issue.labels),
      commentCount: issue.commentCount,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      compact: issue.compact,
      compactTldr: issue.compactTldr,
      compacted: fresh,
      stale: issue.compact != null && issue.compactStale,
      refs: store.listIssueRefs(issue.id).map((ref) => ref.target),
    };
  });

  const filters: IssuesFilters = {
    state,
    repos: repoIds ? (options.repo as string[]) : null,
    labels: filter.labels ?? null,
    author: options.author ?? null,
    stateReason: options.stateReason ?? null,
    since: since ?? null,
    search: options.search ?? null,
    compaction,
    sort,
    order,
    limit: options.limit ?? null,
  };

  const summary: IssuesSummary = {
    total: issues.length,
    open,
    closed: issues.length - open,
    repos: repoSet.size,
  };

  return { filters, summary, issues };
}

/** Builds the short `(filter: ...)` suffix describing non-default filters. */
function describeFilters(filters: IssuesFilters): string {
  const parts: string[] = [];
  if (filters.repos) {
    parts.push(`repos=${filters.repos.join(",")}`);
  }
  if (filters.labels) {
    parts.push(`labels=${filters.labels.join("|")}`);
  }
  if (filters.author) {
    parts.push(`author=${filters.author}`);
  }
  if (filters.stateReason) {
    parts.push(`state_reason=${filters.stateReason}`);
  }
  if (filters.since) {
    parts.push(`since=${filters.since}`);
  }
  if (filters.search) {
    parts.push(`search="${filters.search}"`);
  }
  if (filters.compaction) {
    parts.push(filters.compaction);
  }
  if (filters.sort !== "updated" || filters.order !== "desc") {
    parts.push(`sort=${filters.sort} ${filters.order}`);
  }
  if (filters.limit) {
    parts.push(`limit=${filters.limit}`);
  }
  return parts.length > 0 ? ` (filter: ${parts.join(", ")})` : "";
}

/** Pure formatter: renders an {@link IssuesResult} as human-readable text. */
export function formatIssues(result: IssuesResult): string {
  const { summary, filters } = result;
  if (summary.total === 0) {
    return `No issues match${describeFilters(filters)}.`;
  }

  const stateWord = filters.state === "all" ? "issues" : `${filters.state} issues`;
  const repoWord = summary.repos === 1 ? "repo" : "repos";
  const header = countHeader(
    summary.total,
    `${stateWord} across ${summary.repos} ${repoWord}${describeFilters(filters)}`,
  );

  const byRepo = new Map<string, IssuesItem[]>();
  for (const issue of result.issues) {
    const bucket = byRepo.get(issue.repo);
    if (bucket) {
      bucket.push(issue);
    } else {
      byRepo.set(issue.repo, [issue]);
    }
  }

  const lines: string[] = [header];
  for (const [repo, repoIssues] of byRepo) {
    lines.push("");
    lines.push(repoHeader(repo));
    const numWidth = Math.max(...repoIssues.map((i) => `#${i.number}`.length));
    const stateWidth = Math.max(...repoIssues.map((i) => i.state.length));
    for (const issue of repoIssues) {
      const num = dim(`#${issue.number}`.padEnd(numWidth));
      const stateTag = `[${stateBadge(issue.state, issue.state.padEnd(stateWidth))}]`;
      const labels = labelChips(issue.labels);
      const comments = issue.commentCount > 0 ? ` ${dim(`(${issue.commentCount}c)`)}` : "";
      lines.push(`  ${num}  ${stateTag}  ${issue.title}${labels}${comments}${compactMark(issue)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Builds the `issues` command: a read-only, state-based, filterable listing of
 * issues across watched repos. Distinct from `digest` (what changed) and
 * `repo-digest` (one repo's full dump). Defaults to open issues across all
 * watched repos, newest-updated first, grouped by repo.
 */
export function issuesCommand(): Command {
  const collect = (value: string, previous: string[] = []): string[] => [...previous, value];
  return new Command("issues")
    .description("List issues across watched repos with filters (read-only); defaults to open issues everywhere")
    .option("--state <state>", "issue state: open, closed, or all", "open")
    .option("--repo <owner/repo>", "scope to a watched repo (repeatable)", collect)
    .option("--label <name>", "match issues with any of these labels (repeatable, OR)", collect)
    .option("--author <login>", "restrict to issues by this author")
    .option("--state-reason <reason>", "restrict to this state_reason (completed, not_planned)")
    .option("--since <when>", "only issues updated at or after an ISO date or duration (7d, 24h)")
    .option("--search <text>", "case-insensitive substring match on the issue title")
    .option("--uncompacted", "only issues without a compact (exclusive with --stale/--compacted)")
    .option("--stale", "only issues whose compact is stale (exclusive with --uncompacted/--compacted)")
    .option("--compacted", "only issues with a fresh compact (exclusive with --uncompacted/--stale)")
    .option("--sort <key>", "sort by updated, created, or number", "updated")
    .option("--order <dir>", "sort direction: asc or desc", "desc")
    .option("--limit <n>", "cap the number of issues returned", (v) => Number.parseInt(v, 10))
    .option("--json", "emit machine-readable JSON")
    .action((options: IssuesOptions) => {
      const config = loadConfig({ requireToken: false });
      const store = openStore(config.dbPath);
      try {
        const result = runIssues(store, options);
        console.log(options.json ? JSON.stringify(result) : formatIssues(result));
      } catch (error) {
        if (error instanceof IssuesError) {
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      } finally {
        store.close();
      }
    });
}
