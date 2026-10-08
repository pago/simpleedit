/**
 * Agent threads: line-anchored conversations between the user and one agent
 * session. Main owns them (`main/agent-threads-store.ts`, SQLite) and every
 * client mirrors them; clients change them only through the ops below, and
 * only main sends a message to the agent (`main/thread-delivery.ts`), so a
 * desktop window and a phone share one queue per session.
 */

export type ThreadStatus = 'open' | 'resolved'

/**
 * Where a user message is on its way to the agent.
 * - `held`: waiting for a safe moment (see `heldReason`).
 * - `sending`: written to the agent, not yet confirmed by its prompt hook.
 * - `delivered`: the agent's turn started with it.
 * - `answered`: the agent called `reply_to_thread` in that turn.
 * - `answered-implicitly`: it didn't, so the turn's final text was attached.
 * - `unanswered`: that turn ended without a final text (interrupted, failed).
 * - `failed`: it never reached the agent (see `failedReason`).
 */
export type DeliveryState = 'held' | 'sending' | 'delivered' | 'answered' | 'answered-implicitly' | 'unanswered' | 'failed'

export type HeldReason = 'busy' | 'dialog' | 'draft' | 'not-running'

export interface ThreadAnchor {
  /** Relative to the thread's worktree. */
  path: string
  startLine: number
  endLine: number
  snippet: string
  /** A few lines above and below `snippet`, for re-anchoring after edits. */
  before: string
  after: string
  /**
   * `file`: the working copy, re-anchored as it changes. A diff anchor names the
   * commit (or `uncommitted`) whose new side it is on; a commit's content never
   * changes, so it is never re-anchored.
   */
  context: 'file' | { commit: string }
  orphaned?: true
}

export interface ThreadMessage {
  id: string
  author: 'user' | 'agent'
  body: string
  at: string
  /** User messages only. */
  delivery?: DeliveryState
  heldReason?: HeldReason
  failedReason?: string
}

export interface AgentThread {
  id: string
  /** The owning agent session (the renderer's session id, which is also its terminal id). */
  sessionId: string
  worktreePath: string
  anchor: ThreadAnchor
  status: ThreadStatus
  messages: ThreadMessage[]
  lastReadAt: string | null
  createdAt: string
  updatedAt: string
}

export type AgentThreadOp =
  | {
      kind: 'add-thread'
      thread: { id: string; sessionId: string; worktreePath: string; anchor: ThreadAnchor }
      message: { id: string; body: string }
    }
  | { kind: 'append'; threadId: string; message: { id: string; body: string } }
  | { kind: 'set-status'; threadId: string; status: ThreadStatus }
  | { kind: 'remove-thread'; threadId: string }
  | { kind: 'mark-read'; threadId: string; at: string }

export interface ThreadsSnapshot {
  threads: AgentThread[]
  rev: number
}

/** One thread after a change (null: removed), and the revision it stands at. */
export interface ThreadChange {
  threadId: string
  thread: AgentThread | null
  rev: number
}

const ID = /^[tm]_[A-Za-z0-9-]{6,64}$/
export const MAX_BODY = 32 * 1024
const MAX_PATH = 4096
const MAX_SNIPPET = 8 * 1024
const MAX_SESSION = 256

export function isThreadId(v: unknown): v is string {
  return typeof v === 'string' && ID.test(v) && v.startsWith('t_')
}

function isMessageId(v: unknown): v is string {
  return typeof v === 'string' && ID.test(v) && v.startsWith('m_')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max
}

function isLine(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1
}

export function newThreadId(): string {
  return `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function newMessageId(): string {
  return `m_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function parseAnchor(raw: unknown): ThreadAnchor | null {
  if (!isObject(raw)) return null
  const { path, startLine, endLine, snippet, before, after, context } = raw
  if (!isString(path, MAX_PATH) || !path || path.startsWith('/') || path.split('/').includes('..')) return null
  if (!isLine(startLine) || !isLine(endLine) || endLine < startLine) return null
  if (!isString(snippet, MAX_SNIPPET) || !isString(before, MAX_SNIPPET) || !isString(after, MAX_SNIPPET)) return null
  let ctx: ThreadAnchor['context']
  if (context === 'file') ctx = 'file'
  else if (isObject(context) && isString(context.commit, 64) && /^(uncommitted|[0-9a-f]{7,40})$/.test(context.commit)) {
    ctx = { commit: context.commit }
  } else return null
  return { path, startLine, endLine, snippet, before, after, context: ctx }
}

function parseNewMessage(raw: unknown): { id: string; body: string } | null {
  if (!isObject(raw) || !isMessageId(raw.id) || !isString(raw.body, MAX_BODY) || !raw.body.trim()) return null
  return { id: raw.id, body: raw.body }
}

/**
 * An op from a client, checked field by field and rebuilt from only the fields
 * it knows. The phone is a remote client and the result is written to disk.
 * Throws on anything malformed, so nothing is written.
 */
export function parseThreadOp(raw: unknown): AgentThreadOp {
  if (!isObject(raw)) throw new Error('Malformed thread op')
  switch (raw.kind) {
    case 'add-thread': {
      const t = raw.thread
      const message = parseNewMessage(raw.message)
      if (!isObject(t) || !isThreadId(t.id) || !isString(t.sessionId, MAX_SESSION) || !t.sessionId) break
      if (!isString(t.worktreePath, MAX_PATH) || !t.worktreePath.startsWith('/')) break
      const anchor = parseAnchor(t.anchor)
      if (!anchor || !message) break
      return { kind: 'add-thread', thread: { id: t.id, sessionId: t.sessionId, worktreePath: t.worktreePath, anchor }, message }
    }
    case 'append': {
      const message = parseNewMessage(raw.message)
      if (!isThreadId(raw.threadId) || !message) break
      return { kind: 'append', threadId: raw.threadId, message }
    }
    case 'set-status':
      if (!isThreadId(raw.threadId) || (raw.status !== 'open' && raw.status !== 'resolved')) break
      return { kind: 'set-status', threadId: raw.threadId, status: raw.status }
    case 'remove-thread':
      if (!isThreadId(raw.threadId)) break
      return { kind: 'remove-thread', threadId: raw.threadId }
    case 'mark-read':
      if (!isThreadId(raw.threadId) || !isString(raw.at, 64) || Number.isNaN(Date.parse(raw.at))) break
      return { kind: 'mark-read', threadId: raw.threadId, at: raw.at }
  }
  throw new Error('Malformed thread op')
}

export function parseMessageIdRequest(raw: unknown): string {
  if (!isMessageId(raw)) throw new Error('Malformed message id')
  return raw
}

/** Unread: an agent message newer than the user last looked. */
export function hasUnread(thread: AgentThread): boolean {
  const read = thread.lastReadAt ? Date.parse(thread.lastReadAt) : 0
  return thread.messages.some((m) => m.author === 'agent' && Date.parse(m.at) > read)
}

/** Agent tools whose call puts a dialog in front of the user. */
export const DIALOG_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const

// -- What the agent reads ------------------------------------------------

const HEADER = /\[Thread (t_[A-Za-z0-9-]{6,64}) · /g

/** Thread ids whose headers appear in a submitted prompt. */
export function threadIdsInPrompt(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(HEADER)].map((m) => m[1]!))]
}

const HISTORY_CHARS = 600
const FENCE = '```'

function lineRange(a: ThreadAnchor): string {
  return a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * One thread's part of a submitted prompt: its header (which is also how its
 * delivery is confirmed — see `threadIdsInPrompt`), the anchored code, the
 * earlier exchange clipped (so a follow-up still makes sense after a
 * `/compact` or a fork), and the new messages.
 *
 * The path is absolute: agents launch at the project root, not in the
 * worktree, so a relative path would resolve against the wrong directory.
 */
export function formatThreadForAgent(thread: AgentThread, newMessageIds: ReadonlySet<string>): string {
  const a = thread.anchor
  const file = `${thread.worktreePath.replace(/\/$/, '')}/${a.path}`
  const where = a.orphaned ? `${file} (the commented code has since moved or changed)` : `${file}:${lineRange(a)}`
  const lines = [`[Thread ${thread.id} · ${where}]`]
  if (a.snippet.trim()) lines.push(FENCE, a.snippet.replace(/```/g, '`​``'), FENCE)
  const earlier = thread.messages.filter((m) => !newMessageIds.has(m.id))
  if (earlier.length) {
    lines.push('Earlier in this thread:')
    for (const m of earlier) lines.push(`> ${m.author === 'user' ? 'User' : 'You'}: ${clip(m.body, HISTORY_CHARS).replace(/\n/g, '\n> ')}`)
  }
  for (const m of thread.messages) if (newMessageIds.has(m.id)) lines.push(m.body)
  return lines.join('\n')
}

/** Every held thread for one session, as one submitted prompt. */
export function formatThreadsPrompt(parts: Array<{ thread: AgentThread; newMessageIds: ReadonlySet<string> }>): string {
  const ids = parts.map((p) => `"${p.thread.id}"`).join(', ')
  const intro =
    parts.length === 1
      ? 'The user commented on your code in SimpleEdit.'
      : `The user left comments on your code in ${parts.length} SimpleEdit threads.`
  const outro =
    `Act on each comment first if it asks for a change. Then answer each thread with ` +
    `reply_to_thread (thread ${ids}), so the answer appears next to the code.`
  return [intro, ...parts.map((p) => formatThreadForAgent(p.thread, p.newMessageIds)), outro].join('\n\n')
}
