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
  `
  CREATE TABLE backlog_items (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    position INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    label TEXT,
    target TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_by_session TEXT,
    last_start TEXT
  ) STRICT;
  CREATE INDEX backlog_items_by_project ON backlog_items(project, position);
  CREATE TABLE backlog_tombstones (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
  `,
  `
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    layers TEXT NOT NULL,
    status TEXT NOT NULL,
    requester_session_id TEXT,
    requester_window_id INTEGER,
    companion TEXT,
    companion_session_id TEXT,
    companion_agent TEXT NOT NULL,
    last_seen_head TEXT NOT NULL,
    read_steps TEXT NOT NULL,
    author_briefing TEXT,
    round INTEGER NOT NULL,
    previous_review_id TEXT,
    submissions TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX reviews_by_repo ON reviews(repo, created_at);
  CREATE INDEX reviews_by_status ON reviews(status);
  CREATE INDEX reviews_by_companion ON reviews(companion_session_id);
  CREATE INDEX reviews_by_requester ON reviews(requester_session_id);
  CREATE TABLE review_threads (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    anchor TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    outdated INTEGER NOT NULL,
    close_reason TEXT,
    carried_from TEXT,
    read_seq INTEGER NOT NULL,
    ask_author_open INTEGER NOT NULL,
    proposal TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX review_threads_by_review ON review_threads(review_id, created_at);
  CREATE TABLE review_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL,
    read_files TEXT,
    delivery TEXT,
    held_reason TEXT,
    failed_reason TEXT,
    UNIQUE(thread_id, seq)
  ) STRICT;
  CREATE INDEX review_messages_by_thread ON review_messages(thread_id, seq);
  CREATE INDEX review_messages_by_delivery ON review_messages(delivery, thread_id);
  CREATE TABLE review_tombstones (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL
  ) STRICT;
  `,
]

let db: Db | null = null

export function openDb(path: string): Db {
  const d = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    // A second instance (a dev build beside the installed app) shares the file.
    d.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    migrate(d)
    return d
  } catch (err) {
    d.close()
    throw err
  }
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

/** Runs `fn` in a transaction; called inside one, it joins it, so a throw rolls back the outer one. */
export function transaction<T>(d: Db, fn: () => T): T {
  if (d.isTransaction) return fn()
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
  if (db?.isOpen) db.close()
  db = d
}

export function closeDb(): void {
  if (db?.isOpen) db.close()
  db = null
}
