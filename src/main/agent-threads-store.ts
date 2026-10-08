/**
 * Agent threads, persisted in the app database. Main owns them; desktop
 * windows and phones mirror them through `agent-threads:changed`.
 *
 * Clients change threads only through `AgentThreadOp`s. What only main may do
 * (an agent's answer, delivery states, a session hand-off) has its own
 * functions here and never arrives as an op.
 *
 * Ids are minted by the client and never reused, and a removed thread's or
 * message's id is tombstoned: a phone replays unacknowledged ops on reconnect,
 * and a replayed add must not bring back what was removed.
 */
import { getDb, transaction } from './db'
import type {
  AgentThread,
  AgentThreadOp,
  DeliveryState,
  HeldReason,
  ThreadAnchor,
  ThreadChange,
  ThreadMessage,
  ThreadsSnapshot,
  ThreadStatus,
} from '../shared/agent-threads'

/**
 * Bumped on every change and sent with everything that leaves main, so a
 * client can order its own op's answer against another client's broadcast.
 * Seeded from the clock so it keeps rising across a restart, which a phone
 * page outlives.
 */
let rev = Date.now()

interface ThreadRow {
  id: string
  session_id: string
  worktree_path: string
  anchor: string
  status: string
  last_read_at: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  thread_id: string
  author: string
  body: string
  at: string
  delivery: string | null
  held_reason: string | null
  failed_reason: string | null
}

function toMessage(r: MessageRow): ThreadMessage {
  const m: ThreadMessage = { id: r.id, author: r.author === 'agent' ? 'agent' : 'user', body: r.body, at: r.at }
  if (r.delivery) m.delivery = r.delivery as DeliveryState
  if (r.held_reason) m.heldReason = r.held_reason as HeldReason
  if (r.failed_reason) m.failedReason = r.failed_reason
  return m
}

function toThread(r: ThreadRow, messages: ThreadMessage[]): AgentThread {
  return {
    id: r.id,
    sessionId: r.session_id,
    worktreePath: r.worktree_path,
    anchor: JSON.parse(r.anchor) as ThreadAnchor,
    status: r.status === 'resolved' ? 'resolved' : 'open',
    messages,
    lastReadAt: r.last_read_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function messagesOf(threadId: string): ThreadMessage[] {
  const rows = getDb().prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY seq').all(threadId) as unknown as MessageRow[]
  return rows.map(toMessage)
}

export function getThread(id: string): AgentThread | null {
  const row = getDb().prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined
  return row ? toThread(row, messagesOf(id)) : null
}

export function loadThreads(): ThreadsSnapshot {
  const d = getDb()
  const rows = d.prepare('SELECT * FROM threads ORDER BY created_at').all() as unknown as ThreadRow[]
  const msgs = d.prepare('SELECT * FROM thread_messages ORDER BY thread_id, seq').all() as unknown as MessageRow[]
  const byThread = new Map<string, ThreadMessage[]>()
  for (const m of msgs) {
    const list = byThread.get(m.thread_id) ?? []
    list.push(toMessage(m))
    byThread.set(m.thread_id, list)
  }
  return { threads: rows.map((r) => toThread(r, byThread.get(r.id) ?? [])), rev }
}

export function threadsForSession(sessionId: string): AgentThread[] {
  const rows = getDb().prepare('SELECT id FROM threads WHERE session_id = ? ORDER BY created_at').all(sessionId) as Array<{ id: string }>
  return rows.map((r) => getThread(r.id)).filter((t): t is AgentThread => t !== null)
}

function tombstoned(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM thread_tombstones WHERE id = ?').get(id) !== undefined
}

function exists(table: 'threads' | 'thread_messages', id: string): boolean {
  return getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined
}

function touch(threadId: string, at: string): void {
  getDb().prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(at, threadId)
}

function insertMessage(threadId: string, m: ThreadMessage): void {
  const d = getDb()
  const { seq } = d.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM thread_messages WHERE thread_id = ?').get(threadId) as { seq: number }
  d.prepare(
    'INSERT INTO thread_messages (id, thread_id, seq, author, body, at, delivery, held_reason, failed_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(m.id, threadId, seq, m.author, m.body, m.at, m.delivery ?? null, m.heldReason ?? null, m.failedReason ?? null)
}

function changed(threadId: string): ThreadChange {
  rev++
  return { threadId, thread: getThread(threadId), rev }
}

export interface OpResult {
  /** Null when the op changed nothing (a replay, or a thread that's gone). */
  change: ThreadChange | null
  /** A user message that now needs delivering. */
  queued?: { threadId: string; messageId: string; sessionId: string }
}

export function applyThreadOp(op: AgentThreadOp, now = new Date()): OpResult {
  const at = now.toISOString()
  const d = getDb()
  return transaction(d, (): OpResult => {
    switch (op.kind) {
      case 'add-thread': {
        const { thread, message } = op
        if (tombstoned(thread.id) || exists('threads', thread.id)) return { change: null }
        d.prepare(
          'INSERT INTO threads (id, session_id, worktree_path, anchor, status, last_read_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(thread.id, thread.sessionId, thread.worktreePath, JSON.stringify(thread.anchor), 'open', at, at, at)
        insertMessage(thread.id, { id: message.id, author: 'user', body: message.body, at, delivery: 'held', heldReason: 'busy' })
        return { change: changed(thread.id), queued: { threadId: thread.id, messageId: message.id, sessionId: thread.sessionId } }
      }
      case 'append': {
        const row = d.prepare('SELECT session_id FROM threads WHERE id = ?').get(op.threadId) as { session_id: string } | undefined
        if (!row || tombstoned(op.message.id) || exists('thread_messages', op.message.id)) return { change: null }
        insertMessage(op.threadId, { id: op.message.id, author: 'user', body: op.message.body, at, delivery: 'held', heldReason: 'busy' })
        // Writing in a resolved thread reopens it, as in a review tool.
        d.prepare("UPDATE threads SET status = 'open', last_read_at = ?, updated_at = ? WHERE id = ?").run(at, at, op.threadId)
        return { change: changed(op.threadId), queued: { threadId: op.threadId, messageId: op.message.id, sessionId: row.session_id } }
      }
      case 'set-status': {
        const r = d.prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ? AND status != ?').run(op.status, at, op.threadId, op.status)
        return { change: r.changes ? changed(op.threadId) : null }
      }
      case 'mark-read': {
        const r = d
          .prepare('UPDATE threads SET last_read_at = ? WHERE id = ? AND (last_read_at IS NULL OR last_read_at < ?)')
          .run(op.at, op.threadId, op.at)
        return { change: r.changes ? changed(op.threadId) : null }
      }
      case 'remove-thread':
        return { change: removeThreads([op.threadId], at)[0] ?? null }
    }
  })
}

function removeThreads(ids: string[], at: string): ThreadChange[] {
  const d = getDb()
  const out: ThreadChange[] = []
  for (const id of ids) {
    const msgIds = d.prepare('SELECT id FROM thread_messages WHERE thread_id = ?').all(id) as Array<{ id: string }>
    const r = d.prepare('DELETE FROM threads WHERE id = ?').run(id)
    if (!r.changes) continue
    const stone = d.prepare('INSERT OR IGNORE INTO thread_tombstones (id, at) VALUES (?, ?)')
    stone.run(id, at)
    for (const m of msgIds) stone.run(m.id, at)
    rev++
    out.push({ threadId: id, thread: null, rev })
  }
  return out
}

/** The session is gone for good: its threads go with it. */
export function removeSessionThreads(sessionId: string, now = new Date()): ThreadChange[] {
  const d = getDb()
  return transaction(d, () => {
    const ids = (d.prepare('SELECT id FROM threads WHERE session_id = ?').all(sessionId) as Array<{ id: string }>).map((r) => r.id)
    return removeThreads(ids, now.toISOString())
  })
}

/** A hand-off replaced the session: its threads follow the conversation's successor. */
export function reassignSession(from: string, to: string): ThreadChange[] {
  const d = getDb()
  return transaction(d, () => {
    const ids = (d.prepare('SELECT id FROM threads WHERE session_id = ?').all(from) as Array<{ id: string }>).map((r) => r.id)
    d.prepare('UPDATE threads SET session_id = ? WHERE session_id = ?').run(to, from)
    return ids.map(changed)
  })
}

export function appendAgentMessage(threadId: string, id: string, body: string, now = new Date()): ThreadChange | null {
  const d = getDb()
  const at = now.toISOString()
  return transaction(d, () => {
    if (!exists('threads', threadId)) return null
    insertMessage(threadId, { id, author: 'agent', body, at })
    touch(threadId, at)
    return changed(threadId)
  })
}

export function setThreadStatus(threadId: string, status: ThreadStatus, now = new Date()): ThreadChange | null {
  return applyThreadOp({ kind: 'set-status', threadId, status }, now).change
}

export interface DeliveryPatch {
  delivery: DeliveryState
  heldReason?: HeldReason
  failedReason?: string
}

/**
 * Move user messages to a delivery state. Returns one change per affected
 * thread; a message already in that state is left alone, so repeated calls
 * broadcast nothing.
 */
export function setDelivery(messageIds: Iterable<string>, patch: DeliveryPatch): ThreadChange[] {
  const d = getDb()
  return transaction(d, () => {
    const threads = new Set<string>()
    const stmt = d.prepare(
      `UPDATE thread_messages SET delivery = ?, held_reason = ?, failed_reason = ?
       WHERE id = ? AND author = 'user'
         AND (delivery IS NOT ? OR held_reason IS NOT ? OR failed_reason IS NOT ?)
       RETURNING thread_id`,
    )
    for (const id of messageIds) {
      const held = patch.heldReason ?? null
      const failed = patch.failedReason ?? null
      const row = stmt.get(patch.delivery, held, failed, id, patch.delivery, held, failed) as { thread_id: string } | undefined
      if (row) threads.add(row.thread_id)
    }
    return [...threads].map(changed)
  })
}

export interface PendingMessage {
  thread: AgentThread
  message: ThreadMessage
}

/** User messages of one session in the given delivery states, oldest first. */
export function messagesInState(sessionId: string, states: readonly DeliveryState[]): PendingMessage[] {
  const out: PendingMessage[] = []
  for (const thread of threadsForSession(sessionId)) {
    for (const message of thread.messages) {
      if (message.author === 'user' && message.delivery && states.includes(message.delivery)) out.push({ thread, message })
    }
  }
  return out.sort((a, b) => a.message.at.localeCompare(b.message.at))
}

/** Sessions that have user messages in the given states. */
export function sessionsWithMessagesIn(states: readonly DeliveryState[]): string[] {
  const marks = states.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT t.session_id FROM thread_messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.author = 'user' AND m.delivery IN (${marks})`,
    )
    .all(...states) as Array<{ session_id: string }>
  return rows.map((r) => r.session_id)
}

/** Test seam. */
export function resetThreadsRev(value = 1): void {
  rev = value
}
