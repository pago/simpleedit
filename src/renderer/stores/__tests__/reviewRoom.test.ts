import { describe, it, expect, beforeEach } from 'vitest'
import { _receiveReviewChange, _resetReviewRoomForTests, reviewRoom } from '../reviewRoom.svelte'
import { REVIEW_ID, review, stubApi, thread } from '../../components/review/__tests__/fixtures'

let api: ReturnType<typeof stubApi>
let snapshot: unknown

beforeEach(() => {
  _resetReviewRoomForTests()
  snapshot = { reviews: [], threads: [], rev: 0 }
  api = stubApi((channel) => (channel === 'review:load' ? snapshot : undefined))
})

describe('reviewRoom mirror', () => {
  it('applies changes by revision and never resurrects a removed thread', () => {
    const t = thread()
    _receiveReviewChange({ reviewId: REVIEW_ID, threadId: t.id, thread: t, rev: 5 })
    _receiveReviewChange({ reviewId: REVIEW_ID, threadId: t.id, thread: null, rev: 6 })
    _receiveReviewChange({ reviewId: REVIEW_ID, threadId: t.id, thread: t, rev: 4 })
    expect(reviewRoom.thread(t.id)).toBeUndefined()
  })

  it('takes a load, but keeps changes newer than it', async () => {
    const t = thread()
    _receiveReviewChange({ reviewId: REVIEW_ID, threadId: t.id, thread: { ...t, status: 'done' }, rev: 9 })
    snapshot = { reviews: [review()], threads: [t], rev: 8 }
    await reviewRoom.load()
    expect(reviewRoom.thread(t.id)?.status).toBe('done')
    expect(reviewRoom.review(REVIEW_ID)?.id).toBe(REVIEW_ID)
  })

  it('a deleted review goes', () => {
    _receiveReviewChange({ reviewId: REVIEW_ID, review: review(), rev: 1 })
    _receiveReviewChange({ reviewId: REVIEW_ID, review: null, rev: 2 })
    expect(reviewRoom.review(REVIEW_ID)).toBeUndefined()
  })

  it('sends ops and applies main’s answer, not its own guess', async () => {
    await reviewRoom.setStatus(REVIEW_ID, 'rt_thread01', 'done', 'fixed')
    expect(api.ops).toEqual([{ reviewId: REVIEW_ID, op: { kind: 'set-status', threadId: 'rt_thread01', status: 'done', closeReason: 'fixed' } }])
    expect(reviewRoom.thread('rt_thread01')).toBeUndefined()
  })

  it('a draft-only thread is added without a message', async () => {
    const id = await reviewRoom.addThread(REVIEW_ID, { kind: 'pr', pr: 7 })
    expect(api.ops.at(-1)).toEqual({ reviewId: REVIEW_ID, op: { kind: 'add-thread', thread: { id, anchor: { kind: 'pr', pr: 7 } } } })
  })
})
