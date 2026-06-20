import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { bold, dim, stateBadge } from "../render/index.js";
import { openStore, type Issue, type Store } from "../store/index.js";

/**
 * Error thrown by the `repo-digest` action for expected, user-facing failures
 * (an unwatched repo). The CLI prints the message and exits non-zero.
 */
export class RepoDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoDigestError";
  }
}

/** Options for {@link runRepoDigest}. */
export interface RepoDigestOptions {
  /** List the whole project using only the cheap `tldr` headline per issue. */
  headlines?: boolean;
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/** Per-issue summary counts for a repo digest. */
export interface RepoDigestSummary {
  /** Total number of issues. */
  total: number;
  /** Number of open issues. */
  open: number;
  /** Number of closed issues. */
  closed: number;
  /** Number of issues represented by a valid (fresh) compact. */
  compacted: number;
  /** Number of issues with no compact or a stale compact (need recompacting). */
  staleOrUncompacted: number;
}

/**
 * A single issue in the full digest, carrying the chosen representation and the
 * flags an AI consumer needs to decide whether it should recompact.
 */
export interface RepoDigestIssue {
  number: number;
  /** `open` or `closed`. */
  state: string;
  /** `completed`, `not_planned`, or null (from the GitHub API). */
  stateReason: string | null;
  title: string;
  /**
   * The chosen representation: the fresh compact when available, otherwise the
   * raw body (or null when there is no raw content either).
   */
  representation: string | null;
  /** Whether {@link representation} is a fresh, trustworthy compact. */
  compacted: boolean;
  /** Whether a compact exists but is stale (and therefore not used). */
  stale: boolean;
  /** Explicit references parsed out of the issue (e.g. `#812`, `owner/repo#45`). */
  refs: string[];
}

/** A single lean headline line: just enough to scan a whole project. */
export interface RepoDigestHeadline {
  number: number;
  /** `open` or `closed`. */
  state: string;
  /** The compact `tldr` when present, otherwise the issue title as fallback. */
  headline: string;
  /** Whether {@link headline} came from a `tldr` rather than the title. */
  fromTldr: boolean;
}

/** The full digest result, mirrored in `--json` output. */
export interface RepoDigestResult {
  repo: string;
  summary: RepoDigestSummary;
  issues: RepoDigestIssue[];
}

/** The lean headline digest result, mirrored in `--headlines --json` output. */
export interface RepoDigestHeadlinesResult {
  repo: string;
  summary: RepoDigestSummary;
  headlines: RepoDigestHeadline[];
}

/**
 * Whether an issue has a fresh, trustworthy compact: it must exist and not be
 * stale. This is the protocol rule (see docs/compact-format.md section 5).
 */
function hasFreshCompact(issue: Issue): boolean {
  return issue.compact != null && !issue.compactStale;
}

/**
 * Orders issues for a project-wide view: open issues first, then closed, each
 * group ordered by issue number ascending (the order `listIssues` returns).
 */
function orderIssues(issues: Issue[]): Issue[] {
  const open = issues.filter((issue) => issue.state === "open");
  const closed = issues.filter((issue) => issue.state !== "open");
  return [...open, ...closed];
}

/** Computes the summary counts over all of a repo's issues. */
function summarize(issues: Issue[]): RepoDigestSummary {
  let open = 0;
  let compacted = 0;
  for (const issue of issues) {
    if (issue.state === "open") {
      open += 1;
    }
    if (hasFreshCompact(issue)) {
      compacted += 1;
    }
  }
  return {
    total: issues.length,
    open,
    closed: issues.length - open,
    compacted,
    staleOrUncompacted: issues.length - compacted,
  };
}

/**
 * Looks up the repo and returns its ordered issues plus the summary counts.
 *
 * @throws {RepoDigestError} When the repo is not watched.
 */
function loadDigest(store: Store, fullName: string): { repo: string; ordered: Issue[]; summary: RepoDigestSummary } {
  const repo = store.getRepoByFullName(fullName);
  if (!repo) {
    throw new RepoDigestError(`Repo "${fullName}" is not watched. Add it with \`issuary add ${fullName}\` first.`);
  }
  const issues = store.listIssues(repo.id);
  return { repo: repo.fullName, ordered: orderIssues(issues), summary: summarize(issues) };
}

/**
 * Core action for `issuary repo-digest`: builds the full project-wide view of one
 * watched repo. For each issue it prefers a fresh compact and falls back to the
 * raw body, flagging which issues an AI may want to (re)compact.
 *
 * Separated from the Commander wiring so it can be tested without spawning a
 * process. The caller is responsible for opening/closing the {@link Store}.
 *
 * @throws {RepoDigestError} When the repo is not watched.
 */
export function runRepoDigest(store: Store, fullName: string): RepoDigestResult {
  const { repo, ordered, summary } = loadDigest(store, fullName);
  const issues: RepoDigestIssue[] = ordered.map((issue) => {
    const fresh = hasFreshCompact(issue);
    return {
      number: issue.number,
      state: issue.state,
      stateReason: issue.stateReason,
      title: issue.title,
      representation: fresh ? issue.compact : issue.rawBody,
      compacted: fresh,
      stale: issue.compact != null && issue.compactStale,
      refs: store.listIssueRefs(issue.id).map((ref) => ref.target),
    };
  });
  return { repo, summary, issues };
}

/**
 * Core action for `issuary repo-digest --headlines`: lists the whole project using
 * only the cheap `tldr` headline (roughly 20 tokens per issue), falling back to
 * the title for issues without a tldr.
 *
 * @throws {RepoDigestError} When the repo is not watched.
 */
export function runRepoDigestHeadlines(store: Store, fullName: string): RepoDigestHeadlinesResult {
  const { repo, ordered, summary } = loadDigest(store, fullName);
  const headlines: RepoDigestHeadline[] = ordered.map((issue) => {
    const tldr = issue.compactTldr?.trim();
    const fromTldr = tldr != null && tldr !== "";
    return {
      number: issue.number,
      state: issue.state,
      headline: fromTldr ? tldr : issue.title,
      fromTldr,
    };
  });
  return { repo, summary, headlines };
}

/** Formats the summary header line shared by both human renderings. */
function formatSummary(repo: string, summary: RepoDigestSummary): string {
  return (
    `${bold(`${repo}:`)} ${summary.total} issues ` +
    dim(
      `(${summary.open} open, ${summary.closed} closed; ` +
        `${summary.compacted} compacted, ${summary.staleOrUncompacted} stale/uncompacted)`,
    )
  );
}

/** Renders the lean headline digest as human-readable text. */
function renderHeadlines(result: RepoDigestHeadlinesResult): string {
  const lines = [formatSummary(result.repo, result.summary), ""];
  for (const h of result.headlines) {
    lines.push(`${dim(`#${h.number}`)} [${stateBadge(h.state)}] ${h.headline}`);
  }
  return lines.join("\n");
}

/** Renders the full digest as human-readable text. */
function renderFull(result: RepoDigestResult): string {
  const lines = [formatSummary(result.repo, result.summary), ""];
  for (const issue of result.issues) {
    const reason = issue.stateReason ? dim(`/${issue.stateReason}`) : "";
    const flag = issue.compacted ? "compact" : issue.stale ? "stale, raw" : "uncompacted, raw";
    const refs = issue.refs.length ? dim(` refs: ${issue.refs.length}`) : "";
    lines.push(
      `${dim(`#${issue.number}`)} [${stateBadge(issue.state)}${reason}] ${dim(`(${flag})`)}${refs} ${issue.title}`,
    );
    if (issue.representation) {
      lines.push(issue.representation);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Builds the `repo-digest` command: a project-wide, AI-optimized view of all
 * issues in one watched repo.
 *
 * @see file://../../docs/compact-format.md
 */
export function repoDigestCommand(): Command {
  return new Command("repo-digest")
    .description("Consume all issues of one watched repo as a project-wide, AI-optimized view")
    .argument("<repo>", "watched repo, as owner/name")
    .option("--headlines", "list every issue using only its cheap tldr headline")
    .option("--json", "emit machine-readable JSON")
    .action((repo: string, options: RepoDigestOptions) => {
      const config = loadConfig({ requireToken: false });
      const store = openStore(config.dbPath);
      try {
        if (options.headlines) {
          const result = runRepoDigestHeadlines(store, repo);
          console.log(options.json ? JSON.stringify(result) : renderHeadlines(result));
        } else {
          const result = runRepoDigest(store, repo);
          console.log(options.json ? JSON.stringify(result) : renderFull(result));
        }
      } catch (error) {
        if (error instanceof RepoDigestError) {
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
