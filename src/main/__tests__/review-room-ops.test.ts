import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import { parseReviewOp } from '../../shared/review-room'
import {
  applyReviewOp,
  createReview,
  getReview,
  getReviewThread,
  MAX_READ_STEPS,
  setReviewLastSeenHead,
  setReviewProposal,
  setReviewStepRead,
} from '../review-room-store'

const URL = 'https://github.com/acme/app/pull/12'

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
  createReview({
    id: 'r_aaaaaa',
    repo: 'github.com/acme/app',
    layers: [{ url: URL, number: 12, headSha: 'head1' }],
    companionAgent: { provider: 'claude', model: 'sonnet' },
  })
})

describe('add-thread without a message', () => {
  it('parses, keeping the message optional but never malformed', () => {
    expect(parseReviewOp({ kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { kind: 'pr', pr: 12 } } })).toEqual({
      kind: 'add-thread',
      thread: { id: 'rt_aaaaaa', anchor: { kind: 'pr', pr: 12 } },
    })
    expect(() =>
      parseReviewOp({ kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { kind: 'pr', pr: 12 } }, message: { id: 'rm_aaaaaa', body: '' } }),
    ).toThrow()
    expect(() => parseReviewOp({ kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { kind: 'pr', pr: 12 } }, message: null })).toThrow()
  })

  it('adds a draft-only thread and queues nothing for the companion', () => {
    const result = applyReviewOp('r_aaaaaa', { kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { kind: 'pr', pr: 12 } } })
    expect(result.queued).toBeUndefined()
    expect(result.change?.thread).toMatchObject({ id: 'rt_aaaaaa', messages: [], origin: { kind: 'user' }, status: 'open' })
    // A replay is a no-op, like any add.
    expect(applyReviewOp('r_aaaaaa', { kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { kind: 'pr', pr: 12 } } }).change).toBeNull()
  })
})

describe('clear-proposal', () => {
  it('parses and rejects a bad thread id', () => {
    expect(parseReviewOp({ kind: 'clear-proposal', threadId: 'rt_aaaaaa', extra: 1 })).toEqual({ kind: 'clear-proposal', threadId: 'rt_aaaaaa' })
    expect(() => parseReviewOp({ kind: 'clear-proposal', threadId: 'nope' })).toThrow()
  })

  it('clears the proposal once, and is a no-op after', () => {
    applyReviewOp('r_aaaaaa', { kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { kind: 'pr', pr: 12 } } })
    setReviewProposal('rt_aaaaaa', 'Suggested wording', 'nit')
    expect(getReviewThread('rt_aaaaaa')?.proposal).toEqual({ text: 'Suggested wording', severity: 'nit' })
    expect(applyReviewOp('r_aaaaaa', { kind: 'clear-proposal', threadId: 'rt_aaaaaa' }).change?.thread?.proposal).toBeUndefined()
    expect(applyReviewOp('r_aaaaaa', { kind: 'clear-proposal', threadId: 'rt_aaaaaa' }).change).toBeNull()
  })
})

describe('main-only review setters', () => {
  it('records the last seen head of a layer of the review only', () => {
    expect(setReviewLastSeenHead('r_aaaaaa', URL, 'head1')?.review?.lastSeenHead).toEqual({ [URL]: 'head1' })
    expect(setReviewLastSeenHead('r_aaaaaa', URL, 'head1')).toBeNull()
    expect(setReviewLastSeenHead('r_aaaaaa', 'https://github.com/acme/app/pull/99', 'x')).toBeNull()
  })

  it('marks steps read and unread, keeping the newest past the cap', () => {
    expect(setReviewStepRead('r_aaaaaa', 'step-1', true)?.review?.readSteps).toEqual(['step-1'])
    expect(setReviewStepRead('r_aaaaaa', 'step-1', true)).toBeNull()
    expect(setReviewStepRead('r_aaaaaa', 'step-1', false)?.review?.readSteps).toEqual([])
    for (let i = 0; i < MAX_READ_STEPS + 5; i++) setReviewStepRead('r_aaaaaa', `s${i}`, true)
    const steps = getReview('r_aaaaaa')!.readSteps
    expect(steps).toHaveLength(MAX_READ_STEPS)
    expect(steps[0]).toBe('s5')
    expect(() => setReviewStepRead('r_aaaaaa', 'x'.repeat(257), true)).toThrow()
  })
})
