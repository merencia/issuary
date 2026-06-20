import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { openStore, type EventWithContext, type Store } from "../store/index.js";

/**
 * Error thrown by the `digest` action for expected, user-facing failures (an
 * unwatched `--repo` filter, a malformed `--since` value). The CLI prints the
 * message and exits non-zero.
 */
export class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestError";
  }
}

/** Options for {@link runDigest}. */
export interface DigestOptions {
  /**
   * Time-window view: show events with `detected_at >= since` and do NOT mark
   * them seen. Accepts an ISO-8601 timestamp or a simple relative duration like
   * `7d` or `24h`.
   */
  since?: string;
  /** Show all events (seen and unseen) without marking any seen. */
  all?: boolean;
  /** Limit to a single watched repo, as `owner/name`. */
  repo?: string;
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/** A single change surfaced in the digest, scoped to one issue. */
export interface DigestEvent {
  /** The event's id. */
  id: number;
  /** One of `opened`, `closed`, `reopened`, `commented`, `closed_commented`. */
  type: string;
  /** ISO-8601 timestamp of when the change was detected. */
  detectedAt: string;
  /** The issue's number within its repo. */
  issueNumber: number;
  /** The issue's title. */
  issueTitle: string;
  /** The issue's current state: `open` or `closed`. */
  issueState: string;
}

/** A group of events of one type within a repo. */
export interface DigestTypeGroup {
  /** The event type shared by every event in this group. */
  type: string;
  /** The events, newest first. */
  events: DigestEvent[];
}

/** All changes for one repo, grouped by event type. */
export interface DigestRepoGroup {
  /** The repo's `owner/name`. */
  repo: string;
  /** Groups of events, one per present event type, in canonical type order. */
  groups: DigestTypeGroup[];
}

/** The digest result, mirrored in `--json` output. */
export interface DigestResult {
  /**
   * The mode that produced this result:
   * - `inbox`: unseen events, marked seen as a side effect.
   * - `since`: time-window view, nothing marked.
   * - `all`: every event, nothing marked.
   */
  mode: "inbox" | "since" | "all";
  /** Total number of events surfaced across all repos. */
  total: number;
  /** Per-repo groups, ordered by repo full name. */
  repos: DigestRepoGroup[];
}

/** Canonical order and human labels for event types. */
const TYPE_ORDER: { type: string; label: string }[] = [
  { type: "opened", label: "new issues" },
  { type: "closed", label: "closed" },
  { type: "commented", label: "new comments" },
  { type: "closed_commented", label: "closed with new comment" },
  { type: "reopened", label: "reopened" },
];

const TYPE_LABELS = new Map(TYPE_ORDER.map((t) => [t.type, t.label]));

/** Returns the index of a type in {@link TYPE_ORDER}, or a high value if unknown. */
function typeRank(type: string): number {
  const index = TYPE_ORDER.findIndex((t) => t.type === type);
  return index === -1 ? TYPE_ORDER.length : index;
}

/**
 * Resolves a `--since` value to an ISO-8601 timestamp. Accepts a full ISO date
 * or a simple relative duration: `<n>d` (days) or `<n>h` (hours) before `now`.
 *
 * @throws {DigestError} When the value is neither a valid ISO date nor a
 *   supported relative duration.
 */
export function resolveSince(value: string, now: Date = new Date()): string {
  const trimmed = value.trim();
  const relative = /^(\d+)([dh])$/.exec(trimmed);
  if (relative) {
    const amount = Number.parseInt(relative[1], 10);
    const unitMs = relative[2] === "d" ? 86_400_000 : 3_600_000;
    return new Date(now.getTime() - amount * unitMs).toISOString();
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new DigestError(`Invalid --since value "${value}". Expected an ISO date or a duration like 7d or 24h.`);
  }
  return parsed.toISOString();
}

/** Groups context events by repo (ordered by full name), then by canonical type. */
function groupEvents(events: EventWithContext[]): DigestRepoGroup[] {
  const byRepo = new Map<string, EventWithContext[]>();
  for (const event of events) {
    const bucket = byRepo.get(event.repoFullName);
    if (bucket) {
      bucket.push(event);
    } else {
      byRepo.set(event.repoFullName, [event]);
    }
  }

  const repos = [...byRepo.keys()].sort();
  return repos.map((repo) => {
    const repoEvents = byRepo.get(repo) ?? [];
    const byType = new Map<string, DigestEvent[]>();
    for (const event of repoEvents) {
      const digestEvent: DigestEvent = {
        id: event.id,
        type: event.type,
        detectedAt: event.detectedAt,
        issueNumber: event.issueNumber,
        issueTitle: event.issueTitle,
        issueState: event.issueState,
      };
      const bucket = byType.get(event.type);
      if (bucket) {
        bucket.push(digestEvent);
      } else {
        byType.set(event.type, [digestEvent]);
      }
    }
    const groups = [...byType.entries()]
      .sort(([a], [b]) => typeRank(a) - typeRank(b))
      .map(([type, typeEvents]) => ({ type, events: typeEvents }));
    return { repo, groups };
  });
}

/**
 * Core action for `issuary digest`: the aggregated inbox across all watched repos.
 *
 * - Default (inbox): surfaces unseen events, then marks them seen so each change
 *   appears once.
 * - `--since`: a read-only time window (`detected_at >= since`); nothing marked.
 * - `--all`: every event (seen and unseen); nothing marked.
 * - `--repo`: narrows any of the above to a single watched repo.
 *
 * Separated from the Commander wiring so it can be tested without spawning a
 * process. The caller is responsible for opening/closing the {@link Store}.
 *
 * @throws {DigestError} When `--repo` names an unwatched repo or `--since` is
 *   malformed.
 */
export function runDigest(store: Store, options: DigestOptions = {}): DigestResult {
  let repoId: number | undefined;
  if (options.repo) {
    const repo = store.getRepoByFullName(options.repo);
    if (!repo) {
      throw new DigestError(
        `Repo "${options.repo}" is not watched. Add it with \`issuary add ${options.repo}\` first.`,
      );
    }
    repoId = repo.id;
  }

  let mode: DigestResult["mode"];
  let events: EventWithContext[];
  if (options.since) {
    mode = "since";
    events = store.listEvents({ since: resolveSince(options.since), repoId });
  } else if (options.all) {
    mode = "all";
    events = store.listEvents({ repoId });
  } else {
    mode = "inbox";
    events = store.listEvents({ seen: false, repoId });
    store.markEventsSeen(events.map((event) => event.id));
  }

  return { mode, total: events.length, repos: groupEvents(events) };
}

/** Renders a single digest event line. */
function formatEvent(event: DigestEvent): string {
  return `    #${event.issueNumber} [${event.issueState}] ${event.issueTitle}`;
}

/** Pure formatter: renders a {@link DigestResult} as human-readable text. */
export function formatDigest(result: DigestResult): string {
  if (result.total === 0) {
    if (result.mode === "inbox") {
      return "Inbox empty: no new changes.";
    }
    return "No matching events.";
  }

  const lines: string[] = [];
  for (const repo of result.repos) {
    lines.push(repo.repo);
    for (const group of repo.groups) {
      const label = TYPE_LABELS.get(group.type) ?? group.type;
      lines.push(`  ${label} (${group.events.length})`);
      for (const event of group.events) {
        lines.push(formatEvent(event));
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Builds the `digest` command: an aggregated inbox of detected changes across
 * every watched repo. By default it shows unseen changes and marks them seen so
 * each appears once; `--since` and `--all` are read-only views that never mark.
 */
export function digestCommand(): Command {
  return new Command("digest")
    .description("Show an aggregated inbox of issue changes across all watched repos")
    .option("--since <when>", "show events at or after an ISO date or duration (7d, 24h); does not mark them seen")
    .option("--all", "show all events, seen and unseen, without marking any seen")
    .option("--repo <owner/repo>", "limit to a single watched repo")
    .option("--json", "emit machine-readable JSON")
    .action((options: DigestOptions) => {
      const config = loadConfig({ requireToken: false });
      const store = openStore(config.dbPath);
      try {
        const result = runDigest(store, options);
        console.log(options.json ? JSON.stringify(result) : formatDigest(result));
      } catch (error) {
        if (error instanceof DigestError) {
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
