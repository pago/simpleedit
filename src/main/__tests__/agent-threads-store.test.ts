import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentThreadOp, ThreadAnchor } from '../../shared/agent-threads'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import {
  appendAgentMessage,
  applyThreadOp,
  getThread,
  loadThreads,
  messagesInState,
  reassignSession,
  removeSessionThreads,
  sessionsWithMessagesIn,
  setDelivery,
} from '../agent-threads-store'

const anchor: ThreadAnchor = { path: 'src/a.ts', startLine: 3, endLine: 4, snippet: 'x\ny', before: '', after: '', context: 'file' }

function addThread(id = 't_aaaaaa', sessionId = 's1', messageId = 'm_aaaaaa1'): AgentThreadOp {
  return { kind: 'add-thread', thread: { id, sessionId, worktreePath: '/repo/wt', anchor }, message: { id: messageId, body: 'why?' } }
}

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
})

describe('agent threads store', () => {
  it('adds a thread with its first message held for delivery', () => {
    const { change, queued } = applyThreadOp(addThread())
    expect(queued).toEqual({ threadId: 't_aaaaaa', messageId: 'm_aaaaaa1', sessionId: 's1' })
    expect(change?.thread?.messages).toEqual([
      expect.objectContaining({ id: 'm_aaaaaa1', author: 'user', body: 'why?', delivery: 'held' }),
    ])
    expect(loadThreads().threads).toHaveLength(1)
  })

  it('ignores a replayed add, and an add or append for anything removed', () => {
    applyThreadOp(addThread())
    expect(applyThreadOp(addThread()).change).toBeNull()
    applyThreadOp({ kind: 'remove-thread', threadId: 't_aaaaaa' })
    expect(applyThreadOp(addThread()).change).toBeNull()
    expect(applyThreadOp(addThread('t_bbbbbb', 's1', 'm_aaaaaa1')).change?.thread?.messages).toHaveLength(1)
  })

  it('reopens a resolved thread when the user writes in it', () => {
    applyThreadOp(addThread())
    applyThreadOp({ kind: 'set-status', threadId: 't_aaaaaa', status: 'resolved' })
    const { change } = applyThreadOp({ kind: 'append', threadId: 't_aaaaaa', message: { id: 'm_bbbbbb1', body: 'one more' } })
    expect(change?.thread?.status).toBe('open')
    expect(change?.thread?.messages.map((m) => m.id)).toEqual(['m_aaaaaa1', 'm_bbbbbb1'])
  })

  it('reports no change for a no-op, so nothing is broadcast', () => {
    applyThreadOp(addThread())
    expect(applyThreadOp({ kind: 'set-status', threadId: 't_aaaaaa', status: 'open' }).change).toBeNull()
    expect(setDelivery(['m_aaaaaa1'], { delivery: 'held', heldReason: 'busy' })).toEqual([])
    expect(setDelivery(['m_aaaaaa1'], { delivery: 'sending' })).toHaveLength(1)
  })

  it('finds messages by session and state, and moves threads on hand-off', () => {
    applyThreadOp(addThread())
    applyThreadOp(addThread('t_cccccc', 's2', 'm_cccccc1'))
    expect(sessionsWithMessagesIn(['held']).sort()).toEqual(['s1', 's2'])
    expect(messagesInState('s1', ['held']).map((p) => p.message.id)).toEqual(['m_aaaaaa1'])
    expect(reassignSession('s1', 's3')).toHaveLength(1)
    expect(getThread('t_aaaaaa')?.sessionId).toBe('s3')
    expect(removeSessionThreads('s2')).toEqual([expect.objectContaining({ threadId: 't_cccccc', thread: null })])
  })

  it('appends agent messages without a delivery state', () => {
    applyThreadOp(addThread())
    const change = appendAgentMessage('t_aaaaaa', 'm_agent01', 'done')
    expect(change?.thread?.messages[1]).toEqual(expect.objectContaining({ author: 'agent', body: 'done' }))
    expect(change?.thread?.messages[1]).not.toHaveProperty('delivery')
    expect(appendAgentMessage('t_gone00', 'm_agent02', 'x')).toBeNull()
  })

  it('raises the revision on every change', () => {
    const a = applyThreadOp(addThread()).change!.rev
    const b = applyThreadOp({ kind: 'mark-read', threadId: 't_aaaaaa', at: new Date(Date.now() + 1000).toISOString() }).change!.rev
    expect(b).toBeGreaterThan(a)
  })
})
