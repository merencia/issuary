import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { createGitHubClient, type GitHubClient, type NormalizedComment } from "../github/index.js";
import { openStore, type Issue, type Store } from "../store/index.js";
import { parseTarget } from "./compact.js";

/**
 * Error thrown by the `show` action for expected, user-facing failures
 * (malformed target, unwatched repo, missing issue). The CLI prints the message
 * and exits non-zero.
 */
export class ShowCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShowCommandError";
  }
}

/** Options for {@link runShow}. */
export interface ShowOptions {
  /** Include the full raw body and comments; fetches comments on demand. */
  raw?: boolean;
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/**
 * The structured result of {@link runShow}, mirrored in `--json` output and
 * used to render the human view.
 */
export interface ShowResult {
  repo: string;
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  author: string | null;
  labels: string[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  compact: string | null;
  compactStale: boolean;
  rawBody: string | null;
  /** Explicit references parsed out of the issue (e.g. `#812`, `owner/repo#45`). */
  refs: string[];
  /** Present only when `--raw` was requested. */
  comments?: NormalizedComment[];
}

/** Parses an issue's JSON-encoded labels column into an array. */
function parseLabels(labels: string | null): string[] {
  if (!labels) {
    return [];
  }
  try {
    const parsed = JSON.parse(labels) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Parses an issue's cached `raw_comments` column into an array. */
function parseComments(rawComments: string | null): NormalizedComment[] {
  if (!rawComments) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawComments) as unknown;
    return Array.isArray(parsed) ? (parsed as NormalizedComment[]) : [];
  } catch {
    return [];
  }
}

/**
 * Resolves the comments for `--raw`: returns the cached `raw_comments` when
 * present, otherwise fetches them via the client and caches them on the store.
 */
async function resolveComments(
  store: Store,
  client: GitHubClient,
  fullName: string,
  issue: Issue,
): Promise<NormalizedComment[]> {
  if (issue.rawComments !== null) {
    return parseComments(issue.rawComments);
  }
  const comments = await client.getComments(fullName, issue.number);
  store.setIssueRawComments(issue.repoId, issue.number, JSON.stringify(comments), new Date().toISOString());
  return comments;
}

/**
 * Core action for `lore show`: validates the target, looks up the repo and
 * issue, and assembles a {@link ShowResult}. With `--raw`, the full body and
 * comments are included, fetching and caching comments on demand.
 *
 * Separated from the Commander wiring so it can be tested without spawning a
 * process. The caller owns the {@link Store}; `client` is only used (and so only
 * required) when `--raw` needs to fetch uncached comments.
 *
 * @throws {ShowCommandError} For expected, user-facing failures.
 */
export async function runShow(
  store: Store,
  target: string,
  options: ShowOptions,
  client?: GitHubClient,
): Promise<ShowResult> {
  const { fullName, number } = parseTarget(target);

  const repo = store.getRepoByFullName(fullName);
  if (!repo) {
    throw new ShowCommandError(`Repo "${fullName}" is not watched. Add it with \`lore add ${fullName}\` first.`);
  }

  const issue = store.getIssue(repo.id, number);
  if (!issue) {
    throw new ShowCommandError(`Issue ${fullName}#${number} is not in the local store. Run \`lore sync\` first.`);
  }

  const result: ShowResult = {
    repo: fullName,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    stateReason: issue.stateReason,
    author: issue.author,
    labels: parseLabels(issue.labels),
    commentCount: issue.commentCount,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    compact: issue.compact,
    compactStale: issue.compactStale,
    rawBody: issue.rawBody,
    refs: store.listIssueRefs(issue.id).map((ref) => ref.target),
  };

  if (options.raw) {
    if (!client) {
      throw new ShowCommandError("A GitHub client is required to fetch comments for --raw.");
    }
    result.comments = await resolveComments(store, client, fullName, issue);
  }

  return result;
}

/** Renders a {@link ShowResult} as human-readable text. */
export function formatShow(result: ShowResult, options: ShowOptions): string {
  const lines: string[] = [];
  const reason = result.stateReason ? ` (${result.stateReason})` : "";
  lines.push(`${result.repo}#${result.number} ${result.title}`);
  lines.push(`state: ${result.state}${reason}`);
  lines.push(`author: ${result.author ?? "unknown"}`);
  lines.push(`labels: ${result.labels.length ? result.labels.join(", ") : "(none)"}`);
  lines.push(`comments: ${result.commentCount}`);
  lines.push(`references: ${result.refs.length ? result.refs.join(", ") : "(none)"}`);
  lines.push(`created: ${result.createdAt}`);
  lines.push(`updated: ${result.updatedAt}`);
  if (result.closedAt) {
    lines.push(`closed: ${result.closedAt}`);
  }
  lines.push("");

  if (options.raw) {
    lines.push("--- body ---");
    lines.push(result.rawBody ?? "(no body)");
    lines.push("");
    lines.push("--- comments ---");
    const comments = result.comments ?? [];
    if (comments.length === 0) {
      lines.push("(no comments)");
    } else {
      for (const comment of comments) {
        lines.push(`@${comment.author ?? "unknown"} (${comment.created_at}):`);
        lines.push(comment.body ?? "(empty)");
        lines.push("");
      }
    }
  } else if (result.compact) {
    if (result.compactStale) {
      lines.push("(compact is stale)");
    }
    lines.push(result.compact);
  } else {
    lines.push(result.rawBody ?? "(no body)");
  }

  return lines.join("\n");
}

/**
 * Builds the `show` command.
 *
 * The default view is local-only and needs no token; `--raw` may fetch comments
 * on demand and therefore requires a token.
 */
export function showCommand(): Command {
  return new Command("show")
    .description("Display a single issue from the local store")
    .argument("<target>", "issue to show, as owner/repo#number")
    .option("--raw", "show the full raw body and comments (fetches comments on demand)")
    .option("--json", "emit machine-readable JSON")
    .action(async (target: string, options: ShowOptions) => {
      const config = loadConfig({ requireToken: Boolean(options.raw) });
      const store = openStore(config.dbPath);
      try {
        const client = options.raw ? createGitHubClient({ token: config.token, apiUrl: config.apiUrl }) : undefined;
        const result = await runShow(store, target, options, client);
        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(formatShow(result, options));
        }
      } catch (error) {
        if (error instanceof ShowCommandError) {
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
