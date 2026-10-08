/**
 * The app's SQLite database, `userData/config/simpleedit.db`, through Node's
 * built-in `node:sqlite` (no native module to rebuild for Electron).
 *
 * Everything touching `node:sqlite` goes through this module: its API is not
 * yet marked stable, so an Electron (and so Node) upgrade may change it, and
 * that should be a one-file fix.
 *
 * Schema changes are append-only entries in MIGRATIONS, applied in order and
 * recorded in `PRAGMA user_version`. Never edit a shipped migration.
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { configDir } from './config-dir'

export type Db = DatabaseSync

const MIGRATIONS: string[] = [
  `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    anchor TEXT NOT NULL,
    status TEXT NOT NULL,
    last_read_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX threads_by_session ON threads(session_id);
  CREATE TABLE thread_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL,
    delivery TEXT,
    held_reason TEXT,
    failed_reason TEXT
  ) STRICT;
  CREATE INDEX thread_messages_by_thread ON thread_messages(thread_id, seq);
  CREATE INDEX thread_messages_by_delivery ON thread_messages(delivery);
  CREATE TABLE thread_tombstones (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL
  ) STRICT;
  `,
]

let db: Db | null = null

export function openDb(path: string): Db {
  const d = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  d.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  migrate(d)
  return d
}

function migrate(d: Db): void {
  const row = d.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(d, () => {
      d.exec(MIGRATIONS[v]!)
      d.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}

export function transaction<T>(d: Db, fn: () => T): T {
  d.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    d.exec('COMMIT')
    return out
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

export function getDb(): Db {
  db ??= openDb(join(configDir(), 'simpleedit.db'))
  return db
}

/** Test seam: an in-memory database, or a fresh one per test. */
export function useDbForTests(d: Db | null): void {
  db?.close()
  db = d
}

export function closeDb(): void {
  db?.close()
  db = null
}
