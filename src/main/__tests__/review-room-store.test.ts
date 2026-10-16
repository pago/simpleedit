import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewOp, ReviewThreadAnchor } from '../../shared/review-room'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { getDb, openDb, useDbForTests } from '../db'
import {
  applyReviewOp,
  carryReviewThreads,
  claimCompanion,
  clearCompanion,
  createReview,
  getReview,
  getReviewThread,
  isReviewCompanionSession,
  loadReviews,
  reviewMessagesInState,
  reviewsForSession,
  setReviewDelivery,
  setReviewLayerHead,
  setReviewProposal,
  setReviewStatus,
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

  it('drops a done thread without a reason and keeps an unplaceable one outdated on its old anchor', () => {
    create()
    applyReviewOp('r_aaaaaa', addThread('rt_plain01', 'rm_plain01'))
    applyReviewOp('r_aaaaaa', { kind: 'set-status', threadId: 'rt_plain01', status: 'done' })
    applyReviewOp('r_aaaaaa', addThread('rt_lost01', 'rm_lost01'))
    create('r_bbbbbb', { previousReviewId: 'r_aaaaaa', round: 2, layers: [{ ...layers[0]!, headSha: 'head2' }] })

    const changes = carryReviewThreads('r_aaaaaa', 'r_bbbbbb', () => null)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.thread).toMatchObject({ carriedFrom: 'rt_lost01', outdated: true, anchor })
  })

  it('carries messages as history: in-flight questions become unanswered and Ask author closes', () => {
    create()
    for (const [thread, message] of [
      ['rt_held01', 'rm_held01'],
      ['rt_send01', 'rm_send01'],
      ['rt_deli01', 'rm_deli01'],
      ['rt_answ01', 'rm_answ01'],
    ] as const) applyReviewOp('r_aaaaaa', addThread(thread, message))
    setReviewDelivery(['rm_send01'], { delivery: 'sending' })
    setReviewDelivery(['rm_deli01'], { delivery: 'delivered' })
    setReviewDelivery(['rm_answ01'], { delivery: 'answered' })
    getDb().prepare('UPDATE review_threads SET ask_author_open = 1 WHERE id = ?').run('rt_answ01')
    create('r_bbbbbb', { previousReviewId: 'r_aaaaaa', round: 2 })

    const carried = new Map(
      carryReviewThreads('r_aaaaaa', 'r_bbbbbb', (old) => old).map((change) => [change.thread?.carriedFrom, change.thread]),
    )
    for (const id of ['rt_held01', 'rt_send01', 'rt_deli01']) {
      expect(carried.get(id)?.messages[0]).toMatchObject({
        delivery: 'unanswered',
        failedReason: 'Asked in round 1 and not answered there',
      })
      expect(carried.get(id)?.messages[0]).not.toHaveProperty('heldReason')
    }
    expect(carried.get('rt_answ01')?.messages[0]).toMatchObject({ delivery: 'answered' })
    expect(carried.get('rt_answ01')?.askAuthorOpen).toBe(false)
    expect(getReviewThread('rt_answ01')?.askAuthorOpen).toBe(true)
  })

  it('keeps the companion lookups in step with claim and clear', () => {
    create()
    create('r_bbbbbb', { requesterSessionId: 'requester' })
    applyReviewOp('r_aaaaaa', addThread())
    expect(isReviewCompanionSession('session-a')).toBe(false)
    expect(reviewMessagesInState('session-a', ['held'])).toEqual([])

    claimCompanion('r_aaaaaa', 1, 'req-a', 'session-a', agent)
    expect(isReviewCompanionSession('session-a')).toBe(true)
    expect(reviewMessagesInState('session-a', ['held']).map(({ message }) => message.id)).toEqual(['rm_aaaaaa'])
    expect(reviewMessagesInState('session-a', ['sending'])).toEqual([])
    expect(reviewsForSession('session-a').map((review) => review.id)).toEqual(['r_aaaaaa'])
    expect(reviewsForSession('requester').map((review) => review.id)).toEqual(['r_bbbbbb'])

    expect(clearCompanion('r_aaaaaa', 'someone-else')).toBeNull()
    expect(clearCompanion('r_aaaaaa', 'session-a')?.review?.companion).toBeUndefined()
    expect(isReviewCompanionSession('session-a')).toBe(false)
    expect(reviewMessagesInState('session-a', ['held'])).toEqual([])
    expect(reviewsForSession('session-a')).toEqual([])
  })

  it('refuses a companion claim on a review that is not open', () => {
    create()
    setReviewStatus('r_aaaaaa', 'submitted')
    expect(claimCompanion('r_aaaaaa', 1, 'req-a', 'session-a', agent)).toEqual({ won: false, change: null })
    expect(isReviewCompanionSession('session-a')).toBe(false)
  })

  it('records a pushed layer head and ignores the same head or an unknown layer', () => {
    create()
    expect(setReviewLayerHead('r_aaaaaa', 12, 'head1')).toBeNull()
    expect(setReviewLayerHead('r_aaaaaa', 99, 'head2')).toBeNull()
    expect(setReviewLayerHead('r_aaaaaa', 12, 'head2')?.review?.layers).toEqual([{ ...layers[0]!, headSha: 'head2' }])
    expect(getReview('r_aaaaaa')?.layers[0]?.headSha).toBe('head2')
    expect(() => setReviewLayerHead('r_aaaaaa', 12, '')).toThrow(/Malformed/)
  })
})
