import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ThreadAnchor, ThreadChange } from '../../shared/agent-threads'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import { applyThreadOp, getThread } from '../agent-threads-store'
import {
  CONFIRM_MS,
  SEND_SETTLE_MS,
  beginThreadStop,
  endThreadStop,
  forceSend,
  initThreadDelivery,
  noteThreadSignal,
  noteThreadStatus,
  noteThreadUserInput,
  replyToThread,
  requestSend,
  resetThreadDelivery,
  retryMessage,
} from '../thread-delivery'

const anchor: ThreadAnchor = { path: 'src/a.ts', startLine: 3, endLine: 3, snippet: 'const x = 1', before: '', after: '', context: 'file' }

let writes: Array<{ id: string; data: string }>
let pushes: Array<{ id: string; text: string }>
let providers: Record<string, string>
let pushResult: boolean

function comment(threadId = 't_aaaaaa', sessionId = 's1', messageId = 'm_aaaaaa1', body = 'why?'): void {
  const { queued } = applyThreadOp({
    kind: 'add-thread',
    thread: { id: threadId, sessionId, worktreePath: '/repo/wt', anchor },
    message: { id: messageId, body },
  })
  if (queued) requestSend(queued.sessionId)
}

function delivery(threadId = 't_aaaaaa', index = 0): string | undefined {
  return getThread(threadId)?.messages.filter((m) => m.author === 'user')[index]?.delivery
}

function heldReason(threadId = 't_aaaaaa'): string | undefined {
  return getThread(threadId)?.messages[0]?.heldReason
}

/** A turn ends: its Stop hook is answered without continuing the turn. */
function stop(id = 's1', lastAssistantMessage: string | null = 'All done.'): void {
  beginThreadStop(id)
  endThreadStop(id, { continued: false, lastAssistantMessage })
  noteThreadStatus(id, 'idle')
}

/** The agent's prompt hook sees what we wrote. */
function submitted(id = 's1'): void {
  const last = writes.filter((w) => w.id === id).at(-1)
  noteThreadSignal(id, { eventName: 'UserPromptSubmit', prompt: last?.data ?? '' })
  noteThreadStatus(id, 'running')
}

beforeEach(() => {
  vi.useFakeTimers()
  useDbForTests(openDb(':memory:'))
  writes = []
  pushes = []
  pushResult = true
  providers = { s1: 'claude', s2: 'claude', o1: 'opencode' }
  initThreadDelivery({
    provider: (id) => providers[id] ?? null,
    write: (id, data) => writes.push({ id, data }),
    push: (id, text) => {
      if (providers[id] !== 'opencode') return null
      pushes.push({ id, text })
      return Promise.resolve(pushResult)
    },
    broadcast: (_changes: ThreadChange[]) => {},
  })
  noteThreadStatus('s1', 'running')
})

afterEach(() => {
  resetThreadDelivery()
  vi.useRealTimers()
})

describe('thread delivery', () => {
  it('holds a comment while the agent is busy and sends it once its turn ends', () => {
    comment()
    vi.advanceTimersByTime(SEND_SETTLE_MS * 2)
    expect(writes).toEqual([])
    expect(heldReason()).toBe('busy')

    stop()
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.data).toContain('[Thread t_aaaaaa · /repo/wt/src/a.ts:3]')
    expect(writes[0]!.data).toMatch(/\r$/)
    expect(delivery()).toBe('sending')
  })

  it('confirms delivery from the prompt hook and attaches the final text when the agent does not reply', () => {
    stop()
    comment()
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    submitted()
    expect(delivery()).toBe('delivered')

    stop('s1', 'It guards the retry loop.')
    expect(delivery()).toBe('answered-implicitly')
    expect(getThread('t_aaaaaa')!.messages.at(-1)).toEqual(expect.objectContaining({ author: 'agent', body: 'It guards the retry loop.' }))
  })

  it('takes an explicit reply instead of the final text', () => {
    stop()
    comment()
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    submitted()
    expect(replyToThread('s1', 't_aaaaaa', 'Renamed it.')).toEqual({ ok: true })
    stop('s1', 'Summary of everything')
    expect(delivery()).toBe('answered')
    expect(getThread('t_aaaaaa')!.messages.filter((m) => m.author === 'agent').map((m) => m.body)).toEqual(['Renamed it.'])
  })

  it('batches every held comment of a session into one submit', () => {
    comment('t_aaaaaa', 's1', 'm_aaaaaa1')
    comment('t_bbbbbb', 's1', 'm_bbbbbb1')
    stop()
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.data).toContain('[Thread t_aaaaaa')
    expect(writes[0]!.data).toContain('[Thread t_bbbbbb')
  })

  it('never writes while a dialog is up, and a key pressed in the dialog is no draft', () => {
    stop()
    noteThreadSignal('s1', { eventName: 'PermissionRequest', toolName: 'Bash', toolUseId: 'tu1' })
    comment()
    noteThreadUserInput('s1')
    noteThreadSignal('s1', { eventName: 'Notification', notificationType: 'idle_prompt' })
    vi.advanceTimersByTime(SEND_SETTLE_MS * 2)
    expect(writes).toEqual([])
    expect(heldReason()).toBe('dialog')

    noteThreadSignal('s1', { eventName: 'PostToolUse', toolName: 'Bash', toolUseId: 'tu1' })
    stop()
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('a dialog stays up while another tool call finishes', () => {
    stop()
    noteThreadSignal('s1', { eventName: 'PreToolUse', toolName: 'AskUserQuestion', toolUseId: 'q1' })
    noteThreadSignal('s1', { eventName: 'PostToolUse', toolName: 'Read', toolUseId: 'other' })
    noteThreadStatus('s1', 'running')
    comment()
    expect(heldReason()).toBe('dialog')
  })

  it('holds for a draft until the user submits, or vouches the prompt is empty', () => {
    stop()
    noteThreadUserInput('s1')
    comment()
    vi.advanceTimersByTime(SEND_SETTLE_MS * 2)
    expect(writes).toEqual([])
    expect(heldReason()).toBe('draft')

    forceSend('s1')
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    expect(writes).toHaveLength(1)
  })

  it('fails a write the agent never confirms, and retries only once the prompt is known empty', () => {
    stop()
    comment()
    vi.advanceTimersByTime(SEND_SETTLE_MS + CONFIRM_MS)
    expect(delivery()).toBe('failed')
    expect(retryMessage('s1', 'm_aaaaaa1')).toBe(true)
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    expect(writes).toHaveLength(1)
    expect(heldReason()).toBe('draft')

    forceSend('s1')
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    expect(writes).toHaveLength(2)
  })

  it('leaves a comment unanswered when its turn is interrupted, not attributed to the next one', () => {
    stop()
    comment()
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    submitted()
    // Esc: no Stop. The user's next prompt starts a new turn.
    noteThreadSignal('s1', { eventName: 'UserPromptSubmit', prompt: 'never mind, do X' })
    stop('s1', 'Did X.')
    expect(delivery()).toBe('unanswered')
    expect(getThread('t_aaaaaa')!.messages.some((m) => m.author === 'agent')).toBe(false)
  })

  it('keeps the arm across a Stop that continued the turn', () => {
    stop()
    comment()
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    submitted()
    beginThreadStop('s1')
    endThreadStop('s1', { continued: true, lastAssistantMessage: 'interim' })
    expect(delivery()).toBe('delivered')
    stop('s1', 'final')
    expect(getThread('t_aaaaaa')!.messages.at(-1)?.body).toBe('final')
  })

  it("rejects a reply from a session that doesn't own the thread", () => {
    comment()
    expect(replyToThread('s2', 't_aaaaaa', 'hi')).toEqual({ ok: false, error: expect.stringContaining('belongs to another session') })
  })

  it('fails what was in flight when the session exits, and holds new comments as not running', () => {
    stop()
    comment()
    vi.advanceTimersByTime(SEND_SETTLE_MS)
    noteThreadStatus('s1', 'exited')
    expect(delivery()).toBe('failed')
    comment('t_bbbbbb', 's1', 'm_bbbbbb1')
    expect(heldReason('t_bbbbbb')).toBe('not-running')
  })

  it("pushes to OpenCode over its own API, which a draft can't clobber", async () => {
    noteThreadStatus('o1', 'running')
    stop('o1')
    noteThreadUserInput('o1')
    comment('t_oooooo', 'o1', 'm_oooooo1')
    await vi.advanceTimersByTimeAsync(SEND_SETTLE_MS)
    expect(writes).toEqual([])
    expect(pushes).toHaveLength(1)
    expect(delivery('t_oooooo')).toBe('delivered')
  })
})
