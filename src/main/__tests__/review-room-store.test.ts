import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewOp, ReviewThreadAnchor } from '../../shared/review-room'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import {
  applyReviewOp,
  carryReviewThreads,
  claimCompanion,
  createReview,
  getReview,
  getReviewThread,
  loadReviews,
  setReviewDelivery,
  setReviewProposal,
} from '../review-room-store'

const agent = { provider: 'claude', model: 'sonnet' }
const layers = [{ url: 'https://github.com/acme/app/pull/12', number: 12, headSha: 'head1' }]
const anchor: ReviewThreadAnchor = {
  kind: 'line',
  pr: 12,
  headSha: 'head1',
  path: 'src/a.ts',
  side: 'RIGHT',
  startLine: 4,
  endLine: 4,
  snippet: 'x',
  before: '',
  after: '',
}

function create(id = 'r_aaaaaa', extra: Partial<Parameters<typeof createReview>[0]> = {}): void {
  createReview({ id, repo: 'github.com/acme/app', layers, companionAgent: agent, ...extra }, new Date('2026-10-16T10:00:00Z'))
}

function addThread(id = 'rt_aaaaaa', messageId = 'rm_aaaaaa'): ReviewOp {
  return { kind: 'add-thread', thread: { id, anchor }, message: { id: messageId, body: 'question' } }
}

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
})

describe('review room store', () => {
  it('persists reviews and replay-safe client operations', () => {
    create()
    const first = applyReviewOp('r_aaaaaa', addThread())
    expect(first.change?.thread?.messages[0]).toMatchObject({ id: 'rm_aaaaaa', author: 'user', delivery: 'held' })
    expect(applyReviewOp('r_aaaaaa', addThread()).change).toBeNull()
    expect(loadReviews()).toMatchObject({ reviews: [{ id: 'r_aaaaaa', round: 1 }], threads: [{ id: 'rt_aaaaaa' }] })

    applyReviewOp('r_aaaaaa', { kind: 'remove-thread', threadId: 'rt_aaaaaa' })
    expect(applyReviewOp('r_aaaaaa', addThread()).change).toBeNull()
  })

  it('clamps reads, stores close reasons and reopens on a new user question', () => {
    create()
    applyReviewOp('r_aaaaaa', addThread())
    applyReviewOp('r_aaaaaa', { kind: 'mark-read', threadId: 'rt_aaaaaa', seq: 99 })
    expect(getReviewThread('rt_aaaaaa')?.readSeq).toBe(1)
    applyReviewOp('r_aaaaaa', { kind: 'set-status', threadId: 'rt_aaaaaa', status: 'done', closeReason: 'fixed' })
    expect(getReviewThread('rt_aaaaaa')).toMatchObject({ status: 'done', closeReason: 'fixed' })
    applyReviewOp('r_aaaaaa', { kind: 'append', threadId: 'rt_aaaaaa', message: { id: 'rm_bbbbbb', body: 'again' } })
    expect(getReviewThread('rt_aaaaaa')).toMatchObject({ status: 'open' })
    expect(getReviewThread('rt_aaaaaa')).not.toHaveProperty('closeReason')
  })

  it('claims one companion with compare-and-set semantics', () => {
    create()
    const first = claimCompanion('r_aaaaaa', 1, 'req-a', 'session-a', agent)
    const replay = claimCompanion('r_aaaaaa', 1, 'req-a', 'session-a', agent)
    const loser = claimCompanion('r_aaaaaa', 2, 'req-b', 'session-b', agent)
    expect(first).toMatchObject({ won: true, companion: { sessionId: 'session-a', windowId: 1 } })
    expect(replay).toMatchObject({ won: true, change: null })
    expect(loser).toMatchObject({ won: false, companion: { sessionId: 'session-a' }, change: null })
    expect(getReview('r_aaaaaa')?.companion?.claimRequestId).toBe('req-a')
  })

  it('reserves a companion session id from the review defaults', () => {
    create()
    const claimed = claimCompanion('r_aaaaaa', 3, 'req-main')
    expect(claimed).toMatchObject({
      won: true,
      companion: {
        windowId: 3,
        agent,
        claimRequestId: 'req-main',
      },
    })
    expect(claimed.companion?.sessionId).toMatch(/^agent-claude-/)
  })

  it('keeps proposals main-only and updates delivery by stable message id', () => {
    create()
    applyReviewOp('r_aaaaaa', addThread())
    expect(setReviewProposal('rt_aaaaaa', 'rewrite this', 'blocking')?.thread?.proposal).toEqual({
      text: 'rewrite this',
      severity: 'blocking',
    })
    expect(setReviewDelivery(['rm_aaaaaa'], { delivery: 'sending' })[0]?.thread?.messages[0].delivery).toBe('sending')
  })

  it('carries open and reasoned-done threads into the next round and reanchors them', () => {
    create()
    applyReviewOp('r_aaaaaa', addThread())
    applyReviewOp('r_aaaaaa', { kind: 'set-status', threadId: 'rt_aaaaaa', status: 'done', closeReason: 'intentional' })
    create('r_bbbbbb', { previousReviewId: 'r_aaaaaa', round: 2, layers: [{ ...layers[0]!, headSha: 'head2' }] })
    const changes = carryReviewThreads('r_aaaaaa', 'r_bbbbbb', (old) =>
      old.kind === 'line' ? { ...old, headSha: 'head2', startLine: 8, endLine: 8 } : old
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]?.thread).toMatchObject({
      reviewId: 'r_bbbbbb',
      status: 'done',
      closeReason: 'intentional',
      carriedFrom: 'rt_aaaaaa',
      anchor: { headSha: 'head2', startLine: 8 },
      outdated: false,
    })
  })
})
