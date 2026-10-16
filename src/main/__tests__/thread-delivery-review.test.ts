import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, useDbForTests } from '../db'
import { applyThreadOp, getThread } from '../agent-threads-store'
import {
  addMainReviewThread,
  applyReviewOp,
  claimCompanion,
  createReview,
  getReviewThread,
} from '../review-room-store'
import {
  endThreadStop,
  initThreadDelivery,
  noteThreadSignal,
  noteThreadStatus,
  resetThreadDelivery,
} from '../thread-delivery'

describe('review thread delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDbForTests(openDb(':memory:'))
  })

  afterEach(() => {
    resetThreadDelivery()
    useDbForTests(null)
    vi.useRealTimers()
  })

  it('batches agent and review messages through one per-session delivery state', async () => {
    const sessionId = 'companion-session'
    const review = createReview({
      id: 'r_review01',
      repo: 'github.com/acme/repo',
      layers: [{ url: 'https://github.com/acme/repo/pull/42', number: 42, headSha: 'abc' }],
      companionAgent: { provider: 'codex', model: 'gpt' },
    }).review!
    claimCompanion(review.id, 1, 'claim', sessionId, { provider: 'codex', model: 'gpt' })
    addMainReviewThread({
      id: 'rt_review01',
      reviewId: review.id,
      anchor: { kind: 'line', pr: 42, headSha: 'abc', path: 'src/a.ts', side: 'RIGHT', startLine: 4, endLine: 4, snippet: 'code', before: '', after: '' },
      origin: { kind: 'finding', source: 'deep', key: 'finding', preExisting: false },
      author: 'tool',
      body: 'private finding detail',
    })
    applyReviewOp(review.id, {
      kind: 'append',
      threadId: 'rt_review01',
      message: { id: 'rm_question01', body: 'Could you verify this?' },
    })
    applyThreadOp({
      kind: 'add-thread',
      thread: {
        id: 't_agent01',
        sessionId,
        worktreePath: '/tmp/worktree',
        anchor: { path: 'src/b.ts', startLine: 2, endLine: 2, snippet: 'line', before: '', after: '', context: 'file' },
      },
      message: { id: 'm_agent01', body: 'Please update this.' },
    })

    const writes: string[] = []
    initThreadDelivery({
      provider: () => 'codex',
      write: (_id, data) => { writes.push(data) },
      push: () => null,
      broadcast: () => {},
      broadcastReview: () => {},
    })
    noteThreadStatus(sessionId, 'idle')
    await vi.advanceTimersByTimeAsync(750)

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('[Thread t_agent01')
    expect(writes[0]).toContain('[Review thread rt_review01')
    expect(writes[0]).toContain('Could you verify this?')
    expect(writes[0]).not.toContain('private finding detail')

    noteThreadSignal(sessionId, { eventName: 'UserPromptSubmit', prompt: writes[0] })
    endThreadStop(sessionId, { continued: false, lastAssistantMessage: 'Handled both.' })
    expect(getThread('t_agent01')?.messages.at(-1)).toMatchObject({ author: 'agent', body: 'Handled both.' })
    expect(getReviewThread('rt_review01')?.messages.at(-1)).toMatchObject({ author: 'companion', body: 'Handled both.' })
  })
})
