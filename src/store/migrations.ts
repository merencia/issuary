import type { Database } from "better-sqlite3";

/**
 * An ordered, idempotent schema migration. Migrations are applied in array
 * order and tracked via the `user_version` pragma, so each runs exactly once.
 */
interface Migration {
  /** 1-based version this migration brings the database up to. */
  version: number;
  /** Applies the migration. Runs inside a transaction. */
  up: (db: Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE repos (
          id INTEGER PRIMARY KEY,
          owner TEXT NOT NULL,
          name TEXT NOT NULL,
          full_name TEXT NOT NULL UNIQUE,
          added_at TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          last_synced_at TEXT,
          etag TEXT
        );

        CREATE TABLE issues (
          id INTEGER PRIMARY KEY,
          repo_id INTEGER NOT NULL REFERENCES repos(id),
          number INTEGER NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          state_reason TEXT,
          author TEXT,
          labels TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT,
          comment_count INTEGER NOT NULL DEFAULT 0,
          raw_body TEXT,
          raw_comments TEXT,
          raw_fetched_at TEXT,
          compact TEXT,
          compact_tldr TEXT,
          compact_stale INTEGER NOT NULL DEFAULT 0,
          compacted_at TEXT,
          UNIQUE(repo_id, number)
        );

        CREATE TABLE events (
          id INTEGER PRIMARY KEY,
          issue_id INTEGER NOT NULL REFERENCES issues(id),
          type TEXT NOT NULL,
          detected_at TEXT NOT NULL,
          seen INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE refs (
          id INTEGER PRIMARY KEY,
          issue_id INTEGER NOT NULL REFERENCES issues(id),
          target TEXT NOT NULL,
          UNIQUE(issue_id, target)
        );

        CREATE INDEX idx_issues_repo ON issues(repo_id);
        CREATE INDEX idx_events_issue ON events(issue_id);
        CREATE INDEX idx_refs_issue ON refs(issue_id);
      `);
    },
  },
];

/**
 * The schema version the code expects. Equals the highest defined migration.
 */
export const SCHEMA_VERSION = migrations[migrations.length - 1].version;

/**
 * Runs any pending migrations against the database, in order. Idempotent: the
 * current schema version is read from the `user_version` pragma, and only
 * migrations newer than it are applied. Each migration runs in its own
 * transaction.
 */
export function migrate(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;

  for (const migration of migrations) {
    if (migration.version <= current) {
      continue;
    }
    const run = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    run();
  }
}
