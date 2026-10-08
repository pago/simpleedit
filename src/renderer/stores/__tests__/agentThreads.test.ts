import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { agentThreadsStore, initAgentThreadsListeners, _resetAgentThreadsForTests } from '../agentThreads.svelte'
import type { AgentThread, AgentThreadOp, ThreadChange, ThreadsSnapshot } from '../../../shared/agent-threads'

let changed: ((d: ThreadChange) => void) | undefined
let snapshot: ThreadsSnapshot
let opResult: ThreadChange | null
let invoke: ReturnType<typeof vi.fn>
let dispose: () => void

function thread(id: string, over: Partial<AgentThread> = {}): AgentThread {
  return {
    id,
    sessionId: 's1',
    worktreePath: '/wt',
    anchor: { path: 'a.ts', startLine: 3, endLine: 3, snippet: 'x', before: '', after: '', context: 'file' },
    status: 'open',
    messages: [{ id: 'm_user00001', author: 'user', body: 'why?', at: '2026-10-08T10:00:00.000Z', delivery: 'delivered' }],
    lastReadAt: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    ...over,
  }
}

const agentAt = (at: string) => ({ id: `m_agent-${at.slice(11, 19).replace(/:/g, '')}`, author: 'agent' as const, body: 'because', at })

beforeEach(async () => {
  changed = undefined
  snapshot = { threads: [], rev: 1 }
  opResult = null
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'agent-threads:load') return snapshot
    if (channel === 'agent-threads:op') return opResult
    return undefined
  })
  vi.stubGlobal('api', {
    on: (channel: string, cb: (d: ThreadChange) => void) => {
      if (channel === 'agent-threads:changed') changed = cb
      return () => (changed = undefined)
    },
    once: vi.fn(),
    invoke,
  })
  dispose = initAgentThreadsListeners()
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('agent-threads:load'))
})

afterEach(() => {
  dispose()
  _resetAgentThreadsForTests()
  vi.unstubAllGlobals()
})

describe('agentThreadsStore', () => {
  it('loads threads and lists them per session, oldest first', async () => {
    snapshot = {
      threads: [
        thread('t_bbbbbbbb', { createdAt: '2026-10-08T11:00:00.000Z' }),
        thread('t_aaaaaaaa'),
        thread('t_cccccccc', { sessionId: 's2' }),
      ],
      rev: 5,
    }
    await agentThreadsStore.load()
    expect(agentThreadsStore.forSession('s1').map((t) => t.id)).toEqual(['t_aaaaaaaa', 't_bbbbbbbb'])
    expect(agentThreadsStore.forSession('s2').map((t) => t.id)).toEqual(['t_cccccccc'])
  })

  it('applies changes by revision and ignores stale ones', () => {
    changed!({ threadId: 't_aaaaaaaa', thread: thread('t_aaaaaaaa', { status: 'resolved' }), rev: 10 })
    changed!({ threadId: 't_aaaaaaaa', thread: thread('t_aaaaaaaa', { status: 'open' }), rev: 9 })
    expect(agentThreadsStore.get('t_aaaaaaaa')?.status).toBe('resolved')

    changed!({ threadId: 't_aaaaaaaa', thread: null, rev: 11 })
    expect(agentThreadsStore.get('t_aaaaaaaa')).toBeUndefined()
    changed!({ threadId: 't_aaaaaaaa', thread: thread('t_aaaaaaaa'), rev: 10 })
    expect(agentThreadsStore.get('t_aaaaaaaa')).toBeUndefined()
  })

  it('keeps a change newer than a snapshot that arrives after it', async () => {
    changed!({ threadId: 't_aaaaaaaa', thread: thread('t_aaaaaaaa', { status: 'resolved' }), rev: 20 })
    changed!({ threadId: 't_bbbbbbbb', thread: null, rev: 21 })
    snapshot = { threads: [thread('t_aaaaaaaa'), thread('t_bbbbbbbb')], rev: 15 }
    await agentThreadsStore.load()
    expect(agentThreadsStore.get('t_aaaaaaaa')?.status).toBe('resolved')
    expect(agentThreadsStore.get('t_bbbbbbbb')).toBeUndefined()
  })

  it('drops threads a newer snapshot no longer has', async () => {
    changed!({ threadId: 't_aaaaaaaa', thread: thread('t_aaaaaaaa'), rev: 3 })
    snapshot = { threads: [], rev: 4 }
    await agentThreadsStore.load()
    expect(agentThreadsStore.forSession('s1')).toEqual([])
  })

  it('counts unread threads per session from lastReadAt', () => {
    const at = '2026-10-08T10:05:00.000Z'
    changed!({ threadId: 't_aaaaaaaa', thread: thread('t_aaaaaaaa', { messages: [agentAt(at)] }), rev: 2 })
    changed!({ threadId: 't_bbbbbbbb', thread: thread('t_bbbbbbbb', { messages: [agentAt(at)], lastReadAt: at }), rev: 3 })
    changed!({ threadId: 't_cccccccc', thread: thread('t_cccccccc', { sessionId: 's2', messages: [agentAt(at)] }), rev: 4 })
    expect(agentThreadsStore.unreadCount('s1')).toBe(1)
    expect(agentThreadsStore.unreadCount('s2')).toBe(1)
    expect(agentThreadsStore.unreadCount('s3')).toBe(0)
  })

  it('creates a thread through an add-thread op and focuses it for its session', async () => {
    const anchor = thread('t_x').anchor
    invoke.mockImplementation(async (channel: string, op: AgentThreadOp) => {
      if (channel !== 'agent-threads:op' || op.kind !== 'add-thread') return undefined
      return { threadId: op.thread.id, thread: thread(op.thread.id), rev: 30 }
    })
    const id = await agentThreadsStore.create({ sessionId: 's1', worktreePath: '/wt', anchor, body: 'why?' })
    const op = invoke.mock.calls.find((c) => c[0] === 'agent-threads:op')![1] as AgentThreadOp
    expect(op).toMatchObject({ kind: 'add-thread', thread: { id, sessionId: 's1', worktreePath: '/wt', anchor }, message: { body: 'why?' } })
    expect(agentThreadsStore.get(id)).toBeDefined()
    expect(agentThreadsStore.focusFor('s1')).toBe(id)
    expect(agentThreadsStore.focusFor('s2')).toBeNull()
    agentThreadsStore.takeFocus('s1')
    expect(agentThreadsStore.focusFor('s1')).toBeNull()
  })

  it('marks read at the newest message, and only when something is unread', async () => {
    const at = '2026-10-08T10:05:00.000Z'
    changed!({ threadId: 't_aaaaaaaa', thread: thread('t_aaaaaaaa', { messages: [agentAt(at)] }), rev: 2 })
    agentThreadsStore.markRead('t_aaaaaaaa')
    expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'mark-read', threadId: 't_aaaaaaaa', at })

    invoke.mockClear()
    changed!({ threadId: 't_aaaaaaaa', thread: thread('t_aaaaaaaa', { messages: [agentAt(at)], lastReadAt: at }), rev: 3 })
    agentThreadsStore.markRead('t_aaaaaaaa')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects an append main refuses, so the composer keeps the text', async () => {
    invoke.mockRejectedValueOnce(new Error('Malformed thread op'))
    await expect(agentThreadsStore.append('t_aaaaaaaa', 'more')).rejects.toThrow('Malformed')
  })
})
