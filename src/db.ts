import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SCHEMA_V1 = `
CREATE TABLE repos (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  target_branch TEXT NOT NULL,
  profile_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  spec          TEXT,
  state         TEXT NOT NULL,
  blocked_from  TEXT,
  blocked_reason TEXT,
  human_note    TEXT,
  branch        TEXT,
  worktree_path TEXT,
  base_sha      TEXT,
  head_sha      TEXT,
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX tickets_state ON tickets(state);
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  ticket_id     TEXT NOT NULL REFERENCES tickets(id),
  kind          TEXT NOT NULL,
  state         TEXT NOT NULL,
  sandbox       TEXT,
  pid           INTEGER,
  result_json   TEXT,
  log_path      TEXT,
  started_at    TEXT NOT NULL,
  heartbeat_at  TEXT,
  ended_at      TEXT
);
CREATE INDEX runs_ticket ON runs(ticket_id);
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  run_id     INTEGER REFERENCES runs(id),
  type       TEXT NOT NULL,
  from_state TEXT, to_state TEXT,
  actor      TEXT NOT NULL,
  data_json  TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX events_ticket ON events(ticket_id);
`;

export function now(): string { return new Date().toISOString(); }

export function sfHome(): string { return process.env.SF_HOME || join(homedir(), '.sf'); }

export function migrate(db: DatabaseSync): void {
  const v = db.prepare('PRAGMA user_version').get()!.user_version as number;
  if (v < 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // another process may have migrated between our read and the lock
      if ((db.prepare('PRAGMA user_version').get()!.user_version as number) < 1) {
        db.exec(SCHEMA_V1); db.exec('PRAGMA user_version = 1');
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* keep original error */ } throw e; }
  }
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* keep original error */ } throw e; }
}

/** snake_case row -> camelCase object (callers cast to Ticket/Run/...). */
export function rowTo<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]),
  ) as T;
}
