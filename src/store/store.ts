import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { migrate } from "./migrations.js";
import type {
  EventWithContext,
  Issue,
  IssueEvent,
  IssueRef,
  IssueWithRepo,
  NewRepo,
  Repo,
  UpsertIssue,
} from "./types.js";

/** Raw column shape of a `repos` row as returned by better-sqlite3. */
interface RepoRow {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  added_at: string;
  active: number;
  last_synced_at: string | null;
  etag: string | null;
}

/** Raw column shape of an `issues` row as returned by better-sqlite3. */
interface IssueRow {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  state: string;
  state_reason: string | null;
  author: string | null;
  labels: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comment_count: number;
  raw_body: string | null;
  raw_comments: string | null;
  raw_fetched_at: string | null;
  compact: string | null;
  compact_tldr: string | null;
  compact_stale: number;
  compacted_at: string | null;
}

/** Raw column shape of an `events` row as returned by better-sqlite3. */
interface EventRow {
  id: number;
  issue_id: number;
  type: string;
  detected_at: string;
  seen: number;
}

/** Raw column shape of an event joined with its issue and repo. */
interface EventWithContextRow {
  id: number;
  issue_id: number;
  type: string;
  detected_at: string;
  seen: number;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
  issue_title: string;
  issue_state: string;
}

function rowToEventWithContext(row: EventWithContextRow): EventWithContext {
  return {
    id: row.id,
    issueId: row.issue_id,
    type: row.type,
    detectedAt: row.detected_at,
    seen: row.seen !== 0,
    repoId: row.repo_id,
    repoFullName: row.repo_full_name,
    issueNumber: row.issue_number,
    issueTitle: row.issue_title,
    issueState: row.issue_state,
  };
}

/** Raw column shape of a `refs` row as returned by better-sqlite3. */
interface RefRow {
  id: number;
  issue_id: number;
  target: string;
}

function rowToRef(row: RefRow): IssueRef {
  return {
    id: row.id,
    issueId: row.issue_id,
    target: row.target,
  };
}

function rowToEvent(row: EventRow): IssueEvent {
  return {
    id: row.id,
    issueId: row.issue_id,
    type: row.type,
    detectedAt: row.detected_at,
    seen: row.seen !== 0,
  };
}

function rowToRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    addedAt: row.added_at,
    active: row.active !== 0,
    lastSyncedAt: row.last_synced_at,
    etag: row.etag,
  };
}

function rowToIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    title: row.title,
    state: row.state,
    stateReason: row.state_reason,
    author: row.author,
    labels: row.labels,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    commentCount: row.comment_count,
    rawBody: row.raw_body,
    rawComments: row.raw_comments,
    rawFetchedAt: row.raw_fetched_at,
    compact: row.compact,
    compactTldr: row.compact_tldr,
    compactStale: row.compact_stale !== 0,
    compactedAt: row.compacted_at,
  };
}

/** An {@link IssueRow} joined with the owning repo's `full_name`. */
interface IssueWithRepoRow extends IssueRow {
  repo_full_name: string;
}

function rowToIssueWithRepo(row: IssueWithRepoRow): IssueWithRepo {
  return { ...rowToIssue(row), repoFullName: row.repo_full_name };
}

/**
 * Filter for {@link Store.queryIssues}. Every field is optional; omitted fields
 * do not constrain the result. Values are bound as parameters, never
 * interpolated.
 */
export interface QueryIssuesFilter {
  /** Issue state: `open`, `closed`, or `all` (no state constraint). Default `all`. */
  state?: "open" | "closed" | "all";
  /** Restrict to these repo ids (already resolved from full names). */
  repoIds?: number[];
  /** Match issues whose labels JSON array contains ANY of these (OR semantics). */
  labels?: string[];
  /** Restrict to this author login. */
  author?: string;
  /** Restrict to this `state_reason` (e.g. `completed`, `not_planned`). */
  stateReason?: string;
  /** Only issues with `updated_at >= since` (ISO-8601). */
  since?: string;
  /** Case-insensitive substring match on the issue title. */
  search?: string;
  /**
   * Compaction status:
   * - `uncompacted`: `compact IS NULL`.
   * - `stale`: a compact exists but is stale.
   * - `compacted`: a fresh compact exists.
   */
  compaction?: "uncompacted" | "stale" | "compacted";
  /** Sort key. Default `updated`. */
  sort?: "updated" | "created" | "number";
  /** Sort direction. Default `desc`. */
  order?: "asc" | "desc";
  /** Cap the number of rows returned. A non-positive or absent value means no cap. */
  limit?: number;
}

/**
 * A typed handle over the SQLite database. All access goes through these
 * methods; the underlying `db` is exposed for migrations and advanced use but
 * should be treated as an escape hatch.
 */
export interface Store {
  /** The underlying better-sqlite3 connection. */
  readonly db: Database.Database;

  /** Registers a new repo and returns the persisted row. */
  insertRepo(repo: NewRepo): Repo;
  /** Returns a repo by id, or undefined if not found. */
  getRepo(id: number): Repo | undefined;
  /** Returns a repo by `owner/name`, or undefined if not found. */
  getRepoByFullName(fullName: string): Repo | undefined;
  /** Lists repos. Pass `activeOnly` to exclude deactivated repos. */
  listRepos(options?: { activeOnly?: boolean }): Repo[];
  /**
   * Sets a repo's `active` flag by `owner/name`. Returns the updated row, or
   * undefined when no repo matches. Never deletes: deactivation preserves the
   * repo's issues and compacts.
   */
  setRepoActive(fullName: string, active: boolean): Repo | undefined;

  /**
   * Inserts or updates an issue keyed by `(repoId, number)`. On conflict every
   * provided column is overwritten; returns the resulting row.
   */
  upsertIssue(issue: UpsertIssue): Issue;
  /** Returns an issue by repo id and number, or undefined if not found. */
  getIssue(repoId: number, number: number): Issue | undefined;
  /** Lists issues for a repo, ordered by issue number ascending. */
  listIssues(repoId: number): Issue[];

  /**
   * Queries issues across repos with a parametrized {@link QueryIssuesFilter},
   * each row joined with its repo's `full_name`. Powers the cross-repo `issuary
   * issues` listing. Read-only: never mutates state. Label filtering uses SQLite
   * `json_each` over the stored labels JSON array (OR semantics).
   */
  queryIssues(filter?: QueryIssuesFilter): IssueWithRepo[];

  /**
   * Persists a compact for an issue keyed by `(repoId, number)`: sets `compact`
   * and `compact_tldr`, clears `compact_stale`, and stamps `compacted_at` with
   * the current time. Returns the updated row, or undefined if the issue does
   * not exist.
   */
  setCompact(repoId: number, number: number, compact: { compact: string; tldr: string }): Issue | undefined;

  /** Closes the database connection. */
  close(): void;

  /**
   * Caches on-demand fetched raw comments for an issue keyed by
   * `(repoId, number)`: sets `raw_comments` to the JSON-encoded comments and
   * stamps `raw_fetched_at`. Used by `issuary show --raw` so comments are fetched
   * once and reused. Returns the updated row, or undefined if the issue does
   * not exist.
   */
  setIssueRawComments(repoId: number, number: number, commentsJson: string, fetchedAt: string): Issue | undefined;

  /**
   * Records a change detected on an issue. Returns the persisted event row.
   *
   * @param issueId - The issue the event belongs to.
   * @param type - One of `opened`, `closed`, `reopened`, `commented`, `closed_commented`.
   * @param detectedAt - ISO-8601 timestamp of when the change was detected.
   */
  insertEvent(issueId: number, type: string, detectedAt: string): IssueEvent;

  /**
   * Sets the `compact_stale` flag on an issue by its id. A no-op when the issue
   * does not exist.
   */
  setCompactStale(issueId: number, stale: boolean): void;

  /**
   * Updates a repo's sync bookkeeping (`last_synced_at` and `etag`) by id. A
   * `null` etag is written as-is so callers can clear it.
   */
  updateRepoSync(repoId: number, sync: { lastSyncedAt: string; etag: string | null }): void;

  /**
   * Lists events joined with their issue and repo context, newest first
   * (`detected_at` descending, then `id` descending as a tiebreaker). Powers the
   * aggregated `issuary digest` inbox across all watched repos.
   *
   * @param filter - Optional narrowing:
   *   - `seen`: only events with this seen state (`false` => unseen inbox).
   *   - `since`: only events with `detected_at >= since` (ISO-8601).
   *   - `repoId`: only events for this repo.
   */
  listEvents(filter?: { seen?: boolean; since?: string; repoId?: number }): EventWithContext[];

  /**
   * Marks the given event ids as seen. Ignores ids that do not exist and is a
   * no-op for an empty list.
   */
  markEventsSeen(eventIds: number[]): void;

  /**
   * Replaces the set of explicit references for an issue: clears the issue's
   * existing refs, then inserts the given normalized targets. Idempotent for a
   * fixed input (re-running with the same targets yields the same rows) and uses
   * `INSERT OR IGNORE` so duplicate targets within the input collapse via the
   * `UNIQUE(issue_id, target)` constraint. Runs in a single transaction.
   *
   * @param issueId - The issue whose references are being set.
   * @param targets - Normalized literal targets (e.g. `"#123"`, `"owner/repo#45"`).
   */
  replaceIssueRefs(issueId: number, targets: string[]): void;

  /** Lists an issue's explicit references, ordered by insertion. */
  listIssueRefs(issueId: number): IssueRef[];
}

/**
 * Resolves the default database path: `${ISSUARY_HOME ?? ~/.issuary}/db.sqlite`.
 * The only point where the store reads the environment.
 */
export function defaultDbPath(): string {
  const home = process.env.ISSUARY_HOME ?? join(homedir(), ".issuary");
  return join(home, "db.sqlite");
}

/**
 * Opens (creating its parent directory if needed) a SQLite database at
 * `dbPath`, enables foreign keys and WAL journaling, runs pending migrations,
 * and returns a typed {@link Store}. Pass `:memory:` for an ephemeral database.
 *
 * The path is an explicit argument (dependency injection) so callers and tests
 * control where state lives; use {@link defaultDbPath} for the production path.
 */
export function openStore(dbPath: string): Store {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  migrate(db);

  const insertRepoStmt = db.prepare<[string, string, string, string]>(
    `INSERT INTO repos (owner, name, full_name, added_at)
     VALUES (?, ?, ?, ?)
     RETURNING *`,
  );
  const getRepoStmt = db.prepare<[number]>(`SELECT * FROM repos WHERE id = ?`);
  const getRepoByFullNameStmt = db.prepare<[string]>(`SELECT * FROM repos WHERE full_name = ?`);
  const listReposStmt = db.prepare(`SELECT * FROM repos ORDER BY full_name`);
  const listActiveReposStmt = db.prepare(`SELECT * FROM repos WHERE active = 1 ORDER BY full_name`);
  const setRepoActiveStmt = db.prepare<[number, string]>(`UPDATE repos SET active = ? WHERE full_name = ? RETURNING *`);

  const upsertIssueStmt = db.prepare(
    `INSERT INTO issues (
       repo_id, number, title, state, state_reason, author, labels,
       created_at, updated_at, closed_at, comment_count,
       raw_body, raw_comments, raw_fetched_at,
       compact, compact_tldr, compact_stale, compacted_at
     ) VALUES (
       @repoId, @number, @title, @state, @stateReason, @author, @labels,
       @createdAt, @updatedAt, @closedAt, @commentCount,
       @rawBody, @rawComments, @rawFetchedAt,
       @compact, @compactTldr, @compactStale, @compactedAt
     )
     ON CONFLICT(repo_id, number) DO UPDATE SET
       title = excluded.title,
       state = excluded.state,
       state_reason = excluded.state_reason,
       author = excluded.author,
       labels = excluded.labels,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       closed_at = excluded.closed_at,
       comment_count = excluded.comment_count,
       raw_body = excluded.raw_body,
       raw_comments = excluded.raw_comments,
       raw_fetched_at = excluded.raw_fetched_at,
       compact = excluded.compact,
       compact_tldr = excluded.compact_tldr,
       compact_stale = excluded.compact_stale,
       compacted_at = excluded.compacted_at
     RETURNING *`,
  );
  const getIssueStmt = db.prepare<[number, number]>(`SELECT * FROM issues WHERE repo_id = ? AND number = ?`);
  const listIssuesStmt = db.prepare<[number]>(`SELECT * FROM issues WHERE repo_id = ? ORDER BY number`);
  const setCompactStmt = db.prepare<[string, string, string, number, number]>(
    `UPDATE issues
        SET compact = ?, compact_tldr = ?, compact_stale = 0, compacted_at = ?
      WHERE repo_id = ? AND number = ?
     RETURNING *`,
  );
  const setIssueRawCommentsStmt = db.prepare<[string, string, number, number]>(
    `UPDATE issues
        SET raw_comments = ?, raw_fetched_at = ?
      WHERE repo_id = ? AND number = ?
     RETURNING *`,
  );
  const insertEventStmt = db.prepare<[number, string, string]>(
    `INSERT INTO events (issue_id, type, detected_at) VALUES (?, ?, ?) RETURNING *`,
  );
  const setCompactStaleStmt = db.prepare<[number, number]>(`UPDATE issues SET compact_stale = ? WHERE id = ?`);
  const updateRepoSyncStmt = db.prepare<[string, string | null, number]>(
    `UPDATE repos SET last_synced_at = ?, etag = ? WHERE id = ?`,
  );
  const deleteIssueRefsStmt = db.prepare<[number]>(`DELETE FROM refs WHERE issue_id = ?`);
  const insertIssueRefStmt = db.prepare<[number, string]>(
    `INSERT OR IGNORE INTO refs (issue_id, target) VALUES (?, ?)`,
  );
  const listIssueRefsStmt = db.prepare<[number]>(`SELECT * FROM refs WHERE issue_id = ? ORDER BY id`);

  return {
    db,

    insertRepo(repo: NewRepo): Repo {
      const addedAt = new Date().toISOString();
      const row = insertRepoStmt.get(repo.owner, repo.name, repo.fullName, addedAt) as RepoRow;
      return rowToRepo(row);
    },

    getRepo(id: number): Repo | undefined {
      const row = getRepoStmt.get(id) as RepoRow | undefined;
      return row ? rowToRepo(row) : undefined;
    },

    getRepoByFullName(fullName: string): Repo | undefined {
      const row = getRepoByFullNameStmt.get(fullName) as RepoRow | undefined;
      return row ? rowToRepo(row) : undefined;
    },

    listRepos(options?: { activeOnly?: boolean }): Repo[] {
      const stmt = options?.activeOnly ? listActiveReposStmt : listReposStmt;
      const rows = stmt.all() as RepoRow[];
      return rows.map(rowToRepo);
    },

    setRepoActive(fullName: string, active: boolean): Repo | undefined {
      const row = setRepoActiveStmt.get(active ? 1 : 0, fullName) as RepoRow | undefined;
      return row ? rowToRepo(row) : undefined;
    },

    upsertIssue(issue: UpsertIssue): Issue {
      const row = upsertIssueStmt.get({
        repoId: issue.repoId,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        stateReason: issue.stateReason ?? null,
        author: issue.author ?? null,
        labels: issue.labels ?? null,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        closedAt: issue.closedAt ?? null,
        commentCount: issue.commentCount ?? 0,
        rawBody: issue.rawBody ?? null,
        rawComments: issue.rawComments ?? null,
        rawFetchedAt: issue.rawFetchedAt ?? null,
        compact: issue.compact ?? null,
        compactTldr: issue.compactTldr ?? null,
        compactStale: (issue.compactStale ?? false) ? 1 : 0,
        compactedAt: issue.compactedAt ?? null,
      }) as IssueRow;
      return rowToIssue(row);
    },

    getIssue(repoId: number, number: number): Issue | undefined {
      const row = getIssueStmt.get(repoId, number) as IssueRow | undefined;
      return row ? rowToIssue(row) : undefined;
    },

    listIssues(repoId: number): Issue[] {
      const rows = listIssuesStmt.all(repoId) as IssueRow[];
      return rows.map(rowToIssue);
    },

    queryIssues(filter: QueryIssuesFilter = {}): IssueWithRepo[] {
      // Only issues from active repos: a repo removed via `remove` keeps its
      // history but must not surface in listings, consistent with every other
      // command.
      const conditions: string[] = ["r.active = 1"];
      const params: (string | number)[] = [];

      if (filter.state && filter.state !== "all") {
        conditions.push("i.state = ?");
        params.push(filter.state);
      }
      if (filter.repoIds && filter.repoIds.length > 0) {
        const placeholders = filter.repoIds.map(() => "?").join(", ");
        conditions.push(`i.repo_id IN (${placeholders})`);
        params.push(...filter.repoIds);
      }
      if (filter.author) {
        conditions.push("i.author = ?");
        params.push(filter.author);
      }
      if (filter.stateReason) {
        conditions.push("i.state_reason = ?");
        params.push(filter.stateReason);
      }
      if (filter.since) {
        conditions.push("i.updated_at >= ?");
        params.push(filter.since);
      }
      if (filter.search) {
        // Case-insensitive substring match. LIKE is case-insensitive for ASCII
        // in SQLite by default; lower() on both sides covers the rest.
        conditions.push("lower(i.title) LIKE '%' || lower(?) || '%'");
        params.push(filter.search);
      }
      if (filter.compaction === "uncompacted") {
        conditions.push("i.compact IS NULL");
      } else if (filter.compaction === "stale") {
        conditions.push("i.compact IS NOT NULL AND i.compact_stale = 1");
      } else if (filter.compaction === "compacted") {
        conditions.push("i.compact IS NOT NULL AND i.compact_stale = 0");
      }
      if (filter.labels && filter.labels.length > 0) {
        const placeholders = filter.labels.map(() => "?").join(", ");
        conditions.push(`EXISTS (SELECT 1 FROM json_each(i.labels) WHERE json_each.value IN (${placeholders}))`);
        params.push(...filter.labels);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const sortColumn = { updated: "i.updated_at", created: "i.created_at", number: "i.number" }[
        filter.sort ?? "updated"
      ];
      const direction = filter.order === "asc" ? "ASC" : "DESC";
      // Stable tiebreaker so equal sort keys have a deterministic order.
      const orderBy = `ORDER BY ${sortColumn} ${direction}, i.number ${direction}`;

      const limit = filter.limit !== undefined && filter.limit > 0 ? "LIMIT ?" : "";
      if (limit) {
        params.push(filter.limit as number);
      }

      const sql = `
        SELECT i.*, r.full_name AS repo_full_name
        FROM issues i
        JOIN repos r ON r.id = i.repo_id
        ${where}
        ${orderBy}
        ${limit}`;
      const rows = db.prepare(sql).all(...params) as IssueWithRepoRow[];
      return rows.map(rowToIssueWithRepo);
    },

    setCompact(repoId: number, number: number, compact: { compact: string; tldr: string }): Issue | undefined {
      const compactedAt = new Date().toISOString();
      const row = setCompactStmt.get(compact.compact, compact.tldr, compactedAt, repoId, number) as
        | IssueRow
        | undefined;
      return row ? rowToIssue(row) : undefined;
    },

    close(): void {
      db.close();
    },

    setIssueRawComments(repoId: number, number: number, commentsJson: string, fetchedAt: string): Issue | undefined {
      const row = setIssueRawCommentsStmt.get(commentsJson, fetchedAt, repoId, number) as IssueRow | undefined;
      return row ? rowToIssue(row) : undefined;
    },

    insertEvent(issueId: number, type: string, detectedAt: string): IssueEvent {
      const row = insertEventStmt.get(issueId, type, detectedAt) as EventRow;
      return rowToEvent(row);
    },

    setCompactStale(issueId: number, stale: boolean): void {
      setCompactStaleStmt.run(stale ? 1 : 0, issueId);
    },

    updateRepoSync(repoId: number, sync: { lastSyncedAt: string; etag: string | null }): void {
      updateRepoSyncStmt.run(sync.lastSyncedAt, sync.etag, repoId);
    },

    listEvents(filter?: { seen?: boolean; since?: string; repoId?: number }): EventWithContext[] {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (filter?.seen !== undefined) {
        conditions.push("e.seen = ?");
        params.push(filter.seen ? 1 : 0);
      }
      if (filter?.since !== undefined) {
        conditions.push("e.detected_at >= ?");
        params.push(filter.since);
      }
      if (filter?.repoId !== undefined) {
        conditions.push("r.id = ?");
        params.push(filter.repoId);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `
        SELECT
          e.id AS id,
          e.issue_id AS issue_id,
          e.type AS type,
          e.detected_at AS detected_at,
          e.seen AS seen,
          r.id AS repo_id,
          r.full_name AS repo_full_name,
          i.number AS issue_number,
          i.title AS issue_title,
          i.state AS issue_state
        FROM events e
        JOIN issues i ON i.id = e.issue_id
        JOIN repos r ON r.id = i.repo_id
        ${where}
        ORDER BY e.detected_at DESC, e.id DESC`;
      const rows = db.prepare(sql).all(...params) as EventWithContextRow[];
      return rows.map(rowToEventWithContext);
    },

    markEventsSeen(eventIds: number[]): void {
      if (eventIds.length === 0) {
        return;
      }
      const placeholders = eventIds.map(() => "?").join(", ");
      db.prepare(`UPDATE events SET seen = 1 WHERE id IN (${placeholders})`).run(...eventIds);
    },

    replaceIssueRefs(issueId: number, targets: string[]): void {
      const apply = db.transaction(() => {
        deleteIssueRefsStmt.run(issueId);
        for (const target of targets) {
          insertIssueRefStmt.run(issueId, target);
        }
      });
      apply();
    },

    listIssueRefs(issueId: number): IssueRef[] {
      const rows = listIssueRefsStmt.all(issueId) as RefRow[];
      return rows.map(rowToRef);
    },
  };
}
