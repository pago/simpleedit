import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, useDbForTests } from '../db'
import { applyThreadOp, getThread } from '../agent-threads-store'
import {
  addMainReviewThread,
  applyReviewOp,
  claimCompanion,
  closeAskAuthor,
  createReview,
  getReview,
  getReviewThread,
  setReviewDelivery,
  setReviewHandBack,
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

  function writer(): { writes: Map<string, string[]> } {
    const writes = new Map<string, string[]>()
    initThreadDelivery({
      provider: () => 'codex',
      write: (id, data) => { writes.set(id, [...(writes.get(id) ?? []), data]) },
      push: () => null,
      broadcast: () => {},
      broadcastReview: () => {},
    })
    return { writes }
  }

  it('sends Ask author to the requester only, and its answer closes the request as the author', async () => {
    reviewWithQuestion()
    applyReviewOp('r_review01', { kind: 'ask-author', threadId: 'rt_review01', message: { id: 'rm_author01', body: 'Why 10?' } })
    expect(getReviewThread('rt_review01')?.askAuthorOpen).toBe(true)
    const { writes } = writer()
    noteThreadStatus(COMPANION, 'idle')
    noteThreadStatus(REQUESTER, 'idle')
    await vi.advanceTimersByTimeAsync(750)

    const toRequester = writes.get(REQUESTER) ?? []
    expect(toRequester).toHaveLength(1)
    expect(toRequester[0]).toContain('[Review thread rt_review01 · question for the author]\nWhy 10?')
    expect(toRequester[0]).not.toContain('Is this real?')
    expect(writes.get(COMPANION)?.[0]).not.toContain('Why 10?')

    noteThreadSignal(REQUESTER, { eventName: 'UserPromptSubmit', prompt: toRequester[0]! })
    endThreadStop(REQUESTER, { continued: false, lastAssistantMessage: 'Because the API caps at 10.' })
    const thread = getReviewThread('rt_review01')!
    expect(thread.messages.at(-1)).toMatchObject({ author: 'author', body: 'Because the API caps at 10.' })
    expect(thread.askAuthorOpen).toBe(false)
    expect(thread.messages.find((m) => m.id === 'rm_author01')).toMatchObject({ delivery: 'answered-implicitly', toAuthor: true })
  })

  it('stops waiting for the author when the requester ends, and records no answer to a closed request', async () => {
    reviewWithQuestion()
    applyReviewOp('r_review01', { kind: 'ask-author', threadId: 'rt_review01', message: { id: 'rm_author01', body: 'Why 10?' } })
    const { writes } = writer()
    noteThreadStatus(REQUESTER, 'idle')
    await vi.advanceTimersByTimeAsync(750)
    noteThreadSignal(REQUESTER, { eventName: 'UserPromptSubmit', prompt: writes.get(REQUESTER)![0]! })
    // The question is closed mid-turn (here: by an explicit answer of another path).
    closeAskAuthor('rt_review01')
    endThreadStop(REQUESTER, { continued: false, lastAssistantMessage: 'Late answer.' })
    expect(getReviewThread('rt_review01')?.messages.find((m) => m.id === 'rm_author01')).toMatchObject({ delivery: 'unanswered' })
    expect(getReviewThread('rt_review01')?.messages.some((m) => m.body === 'Late answer.')).toBe(false)

    applyReviewOp('r_review01', { kind: 'ask-author', threadId: 'rt_review01', message: { id: 'rm_author02', body: 'And now?' } })
    noteThreadStatus(REQUESTER, 'exited')
    expect(getReviewThread('rt_review01')).toMatchObject({ askAuthorOpen: false })
    expect(getReviewThread('rt_review01')?.messages.find((m) => m.id === 'rm_author02')).toMatchObject({
      delivery: 'unanswered',
      failedReason: 'The requesting session ended before it answered',
    })
  })

  it('refuses Ask author on a review no session requested', () => {
    createReview({
      id: 'r_review02',
      repo: 'github.com/acme/repo',
      layers: [{ url: 'https://github.com/acme/repo/pull/42', number: 42, headSha: 'abc' }],
      companionAgent: { provider: 'codex', model: 'gpt' },
    })
    addMainReviewThread({ id: 'rt_review02', reviewId: 'r_review02', anchor: { kind: 'pr', pr: 42 }, origin: { kind: 'user' }, author: 'user', body: 'q' })
    expect(() => applyReviewOp('r_review02', { kind: 'ask-author', threadId: 'rt_review02', message: { id: 'rm_author02', body: 'Why?' } }))
      .toThrow('no requesting session')
  })

  it('types the hand-back into the requester when it is idle and ends at delivered, never armed', async () => {
    reviewWithQuestion()
    const body = '[Review r_review01 submitted] #42 approve. It was not posted to GitHub. Call get_review("r_review01") for the comments.'
    setReviewHandBack('r_review01', { id: 'rh_handback01', sessionId: REQUESTER, body, at: new Date().toISOString(), delivery: 'held', heldReason: 'not-running' })
    const { writes } = writer()
    noteThreadStatus(REQUESTER, 'running')
    await vi.advanceTimersByTimeAsync(750)
    expect(writes.get(REQUESTER)).toBeUndefined()
    expect(getReview('r_review01')?.handBack).toMatchObject({ delivery: 'held', heldReason: 'busy' })

    noteThreadStatus(REQUESTER, 'idle')
    await vi.advanceTimersByTimeAsync(750)
    expect(writes.get(REQUESTER)).toHaveLength(1)
    expect(writes.get(REQUESTER)![0]).toContain(body)
    expect(getReview('r_review01')?.handBack?.delivery).toBe('sending')

    noteThreadSignal(REQUESTER, { eventName: 'UserPromptSubmit', prompt: writes.get(REQUESTER)![0]! })
    expect(getReview('r_review01')?.handBack?.delivery).toBe('delivered')
    endThreadStop(REQUESTER, { continued: false, lastAssistantMessage: 'Thanks, fixing.' })
    expect(getReview('r_review01')?.handBack?.delivery).toBe('delivered')
    expect(getReviewThread('rt_review01')?.messages.map((m) => m.author)).toEqual(['tool', 'user'])
  })

  it('fails a hand-back whose requester ends before receiving it, and keeps a delivered one across a restart', () => {
    reviewWithQuestion()
    setReviewHandBack('r_review01', { id: 'rh_handback02', sessionId: REQUESTER, body: '[Review r_review01 submitted] x', at: new Date().toISOString(), delivery: 'held' })
    writer()
    noteThreadStatus(REQUESTER, 'exited')
    expect(getReview('r_review01')?.handBack).toMatchObject({ delivery: 'failed', failedReason: expect.stringContaining('ended') })

    setReviewHandBack('r_review01', { id: 'rh_handback03', sessionId: REQUESTER, body: '[Review r_review01 submitted] x', at: new Date().toISOString(), delivery: 'delivered' })
    resetThreadDelivery()
    writer()
    expect(getReview('r_review01')?.handBack?.delivery).toBe('delivered')
  })
})
