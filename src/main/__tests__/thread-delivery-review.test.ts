import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, useDbForTests } from '../db'
import { applyThreadOp, getThread } from '../agent-threads-store'
import {
  addMainReviewThread,
  applyReviewOp,
  claimCompanion,
  createReview,
  getReviewThread,
  setReviewDelivery,
} from '../review-room-store'
import { REVIEW_MAX_BODY } from '../../shared/review-room'
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

  const COMPANION = 'companion-session'
  const REQUESTER = 'requester-session'

  /** A review whose companion has one open question waiting in rt_review01. */
  function reviewWithQuestion(): void {
    createReview({
      id: 'r_review01',
      repo: 'github.com/acme/repo',
      layers: [{ url: 'https://github.com/acme/repo/pull/42', number: 42, headSha: 'abc' }],
      companionAgent: { provider: 'codex', model: 'gpt' },
      requesterSessionId: REQUESTER,
    })
    claimCompanion('r_review01', 1, 'claim', COMPANION, { provider: 'codex', model: 'gpt' })
    addMainReviewThread({
      id: 'rt_review01',
      reviewId: 'r_review01',
      anchor: { kind: 'pr', pr: 42 },
      origin: { kind: 'finding', source: 'deep', key: 'finding', preExisting: false },
      author: 'tool',
      body: 'finding',
    })
    applyReviewOp('r_review01', { kind: 'append', threadId: 'rt_review01', message: { id: 'rm_question01', body: 'Is this real?' } })
  }

  async function deliverToCompanion(): Promise<string[]> {
    const writes: string[] = []
    initThreadDelivery({
      provider: () => 'codex',
      write: (_id, data) => { writes.push(data) },
      push: () => null,
      broadcast: () => {},
      broadcastReview: () => {},
    })
    noteThreadStatus(COMPANION, 'idle')
    await vi.advanceTimersByTimeAsync(750)
    expect(writes).toHaveLength(1)
    noteThreadSignal(COMPANION, { eventName: 'UserPromptSubmit', prompt: writes[0]! })
    return writes
  }

  const question = () => getReviewThread('rt_review01')?.messages.find((message) => message.id === 'rm_question01')

  it('marks a delivered question unanswered when the companion session ends', async () => {
    reviewWithQuestion()
    await deliverToCompanion()
    expect(question()?.delivery).toBe('delivered')
    noteThreadStatus(COMPANION, 'exited')
    expect(question()).toMatchObject({ delivery: 'unanswered', failedReason: 'The session ended before the companion answered' })
  })

  it("never attaches an unrelated or requester session's turn to a review thread", async () => {
    reviewWithQuestion()
    await deliverToCompanion()
    for (const session of ['unrelated-session', REQUESTER]) {
      noteThreadStatus(session, 'running')
      endThreadStop(session, { continued: false, lastAssistantMessage: `answer from ${session}` })
    }
    const thread = getReviewThread('rt_review01')
    expect(thread?.messages.map((message) => message.author)).toEqual(['tool', 'user'])
    expect(question()?.delivery).toBe('delivered')
  })

  it('cuts an oversized implicit answer to fit and still settles the turn\'s other threads', async () => {
    reviewWithQuestion()
    applyThreadOp({
      kind: 'add-thread',
      thread: {
        id: 't_agent01',
        sessionId: COMPANION,
        worktreePath: '/tmp/worktree',
        anchor: { path: 'src/b.ts', startLine: 2, endLine: 2, snippet: 'line', before: '', after: '', context: 'file' },
      },
      message: { id: 'm_agent01', body: 'Please update this.' },
    })
    await deliverToCompanion()
    const huge = 'a'.repeat(REVIEW_MAX_BODY + 5000)
    endThreadStop(COMPANION, { continued: false, lastAssistantMessage: huge })

    const answer = getReviewThread('rt_review01')?.messages.at(-1)
    expect(answer?.author).toBe('companion')
    expect(answer?.body.length).toBeLessThanOrEqual(REVIEW_MAX_BODY)
    expect(answer?.body).toMatch(/\[SimpleEdit cut this message at its size limit\.\]$/)
    expect(question()?.delivery).toBe('answered-implicitly')
    expect(getThread('t_agent01')?.messages.at(-1)).toMatchObject({ author: 'agent', body: huge })
    expect(getThread('t_agent01')?.messages.find((message) => message.id === 'm_agent01')?.delivery).toBe('answered-implicitly')
  })

  it('settles a question left delivered by a previous run as unanswered on start', () => {
    reviewWithQuestion()
    setReviewDelivery(['rm_question01'], { delivery: 'delivered' })
    initThreadDelivery({
      provider: () => 'codex',
      write: () => {},
      push: () => null,
      broadcast: () => {},
      broadcastReview: () => {},
    })
    expect(question()).toMatchObject({ delivery: 'unanswered', failedReason: 'SimpleEdit restarted before the agent answered' })
  })
})
