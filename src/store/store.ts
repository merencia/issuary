import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { migrate } from "./migrations.js";
import type { Issue, NewRepo, Repo, UpsertIssue } from "./types.js";

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
   * Inserts or updates an issue keyed by `(repoId, number)`. On conflict every
   * provided column is overwritten; returns the resulting row.
   */
  upsertIssue(issue: UpsertIssue): Issue;
  /** Returns an issue by repo id and number, or undefined if not found. */
  getIssue(repoId: number, number: number): Issue | undefined;
  /** Lists issues for a repo, ordered by issue number ascending. */
  listIssues(repoId: number): Issue[];

  /** Closes the database connection. */
  close(): void;
}

/**
 * Resolves the default database path: `${LORE_HOME ?? ~/.lore}/db.sqlite`.
 * The only point where the store reads the environment.
 */
export function defaultDbPath(): string {
  const home = process.env.LORE_HOME ?? join(homedir(), ".lore");
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

    close(): void {
      db.close();
    },
  };
}
