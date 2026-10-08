/**
 * Mirror of the agent threads main owns (`main/agent-threads-store.ts`). Shared
 * by the desktop renderer and the phone (`src/web`), the same way review drafts
 * are (`screenprs.svelte.ts`): load once, then apply `agent-threads:changed` by
 * revision. Every change goes to main as an op and comes back as a change; the
 * mirror is never edited locally. Sending a message to the agent is main's job
 * alone (`main/thread-delivery.ts`), so nothing here touches a PTY.
 */
import {
  hasUnread,
  newMessageId,
  newThreadId,
  type AgentThread,
  type AgentThreadOp,
  type ThreadAnchor,
  type ThreadChange,
  type ThreadStatus,
  type ThreadsSnapshot,
} from '../../shared/agent-threads'

let _threads = $state<Map<string, AgentThread>>(new Map())
/** The newest revision seen per thread id, removals included, so a stale change or load never resurrects one. */
const _revs = new Map<string, number>()
/** A thread a workspace should show expanded: set on create, taken by that session's panel. */
let _focus = $state<{ sessionId: string; threadId: string } | null>(null)

function receive(change: ThreadChange): void {
  if (change.rev < (_revs.get(change.threadId) ?? -Infinity)) return
  _revs.set(change.threadId, change.rev)
  const next = new Map(_threads)
  if (change.thread) next.set(change.threadId, change.thread)
  else next.delete(change.threadId)
  _threads = next
}

function receiveSnapshot({ threads, rev }: ThreadsSnapshot): void {
  const next = new Map<string, AgentThread>()
  // Changes newer than the snapshot already reached the mirror; keep them.
  for (const [id, t] of _threads) if ((_revs.get(id) ?? -Infinity) > rev) next.set(id, t)
  for (const t of threads) {
    if ((_revs.get(t.id) ?? -Infinity) > rev) continue
    _revs.set(t.id, rev)
    next.set(t.id, t)
  }
  _threads = next
}

async function sendOp(op: AgentThreadOp): Promise<void> {
  const change = await window.api.invoke('agent-threads:op', op)
  if (change) receive(change)
}

function byCreated(a: AgentThread, b: AgentThread): number {
  return a.createdAt.localeCompare(b.createdAt)
}

export const agentThreadsStore = {
  /** A session's threads, oldest first. */
  forSession(sessionId: string): AgentThread[] {
    return [..._threads.values()].filter((t) => t.sessionId === sessionId).sort(byCreated)
  },
  get(threadId: string): AgentThread | undefined {
    return _threads.get(threadId)
  },
  /** Threads of a session holding an agent message the user hasn't seen. */
  unreadCount(sessionId: string): number {
    let n = 0
    for (const t of _threads.values()) if (t.sessionId === sessionId && hasUnread(t)) n++
    return n
  },

  /** Replace the mirror with main's threads: at start, and after a reconnect. */
  async load(): Promise<void> {
    try {
      receiveSnapshot(await window.api.invoke('agent-threads:load'))
    } catch (err) {
      console.warn('[threads] loading threads failed:', err)
    }
  },

  /** Start a thread on `anchor` with its first message. Resolves to the new thread's id. Rejects if main refused it. */
  async create(input: { sessionId: string; worktreePath: string; anchor: ThreadAnchor; body: string }): Promise<string> {
    const id = newThreadId()
    await sendOp({
      kind: 'add-thread',
      thread: { id, sessionId: input.sessionId, worktreePath: input.worktreePath, anchor: input.anchor },
      message: { id: newMessageId(), body: input.body },
    })
    _focus = { sessionId: input.sessionId, threadId: id }
    return id
  },
  /** Rejects if main refused it, so a composer can keep the text. */
  append(threadId: string, body: string): Promise<void> {
    return sendOp({ kind: 'append', threadId, message: { id: newMessageId(), body } })
  },
  setStatus(threadId: string, status: ThreadStatus): Promise<void> {
    return sendOp({ kind: 'set-status', threadId, status })
  },
  remove(threadId: string): Promise<void> {
    return sendOp({ kind: 'remove-thread', threadId })
  },
  /** Mark everything in the thread as seen. A no-op while nothing is unread, so it can run on every render. */
  markRead(threadId: string): void {
    const t = _threads.get(threadId)
    if (!t || !hasUnread(t)) return
    const newest = t.messages.reduce((max, m) => (m.at > max ? m.at : max), t.lastReadAt ?? '')
    sendOp({ kind: 'mark-read', threadId, at: newest }).catch((err: unknown) => console.warn('[threads] mark-read failed:', err))
  },
  /** Send a failed or unanswered message again. */
  retry(sessionId: string, messageId: string): Promise<boolean> {
    return window.api.invoke('agent-threads:retry', sessionId, messageId)
  },
  /** The user vouches their prompt is empty: send what the draft check holds. */
  forceSend(sessionId: string): Promise<void> {
    return window.api.invoke('agent-threads:force-send', sessionId)
  },

  /** The thread a session's panel should open on, once. */
  focusFor(sessionId: string): string | null {
    return _focus?.sessionId === sessionId ? _focus.threadId : null
  },
  takeFocus(sessionId: string): void {
    if (_focus?.sessionId === sessionId) _focus = null
  },
}

/** Subscribe to `agent-threads:changed` and load the threads. Call once at app start; returns an unsub. */
export function initAgentThreadsListeners(): () => void {
  const unsub = window.api.on('agent-threads:changed', (change) => receive(change))
  void agentThreadsStore.load()
  return unsub
}

export function _resetAgentThreadsForTests(): void {
  _threads = new Map()
  _revs.clear()
  _focus = null
}
