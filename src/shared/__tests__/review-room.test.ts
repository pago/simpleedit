import { describe, expect, it } from 'vitest'
import { fitReviewBody, parseReviewOp, parseReviewOpRequest, REVIEW_MAX_BODY, type ReviewThreadAnchor } from '../review-room'

const anchor: ReviewThreadAnchor = {
  kind: 'line',
  pr: 12,
  headSha: 'abc123',
  path: 'src/a.ts',
  side: 'RIGHT',
  startLine: 4,
  endLine: 5,
  snippet: 'a\nb',
  before: '',
  after: '',
}

describe('review room validation', () => {
  it('rebuilds a valid op without unknown fields', () => {
    expect(
      parseReviewOp({
        kind: 'add-thread',
        thread: { id: 'rt_aaaaaa', anchor, ignored: true },
        message: { id: 'rm_aaaaaa', body: 'look here', ignored: true },
      })
    ).toEqual({ kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor }, message: { id: 'rm_aaaaaa', body: 'look here' } })
  })

  it.each([
    null,
    { kind: 'add-thread', thread: { id: 't_aaaaaa', anchor }, message: { id: 'rm_aaaaaa', body: 'x' } },
    { kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { ...anchor, path: '../secret' } }, message: { id: 'rm_aaaaaa', body: 'x' } },
    { kind: 'append', threadId: 'rt_aaaaaa', message: { id: 'rm_aaaaaa', body: '' } },
    { kind: 'append', threadId: 'rt_aaaaaa', message: { id: 'rm_aaaaaa', body: 'x'.repeat(64 * 1024 + 1) } },
    { kind: 'set-status', threadId: 'rt_aaaaaa', status: 'open', closeReason: 'fixed' },
    { kind: 'set-status', threadId: 'rt_aaaaaa', status: 'done', closeReason: 'maybe' },
    { kind: 'mark-read', threadId: 'rt_aaaaaa', seq: -1 },
    { kind: 'mark-read', threadId: 'rt_aaaaaa', seq: 1.5 },
    { kind: 'mark-read', threadId: 'rt_aaaaaa', seq: '3' },
    { kind: 'rename-thread', threadId: 'rt_aaaaaa' },
    { kind: 'remove-thread', threadId: `rt_${'a'.repeat(65)}` },
    { kind: 'append', threadId: 'rt_aaaaaa', message: { id: `rm_${'a'.repeat(65)}`, body: 'x' } },
    ...(['snippet', 'before', 'after'] as const).map((field) => ({
      kind: 'add-thread',
      thread: { id: 'rt_aaaaaa', anchor: { ...anchor, [field]: 'x'.repeat(8 * 1024 + 1) } },
      message: { id: 'rm_aaaaaa', body: 'x' },
    })),
    { kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { ...anchor, path: 'a/'.repeat(2049) } }, message: { id: 'rm_aaaaaa', body: 'x' } },
    { kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { ...anchor, path: '/etc/passwd' } }, message: { id: 'rm_aaaaaa', body: 'x' } },
    { kind: 'add-thread', thread: { id: 'rt_aaaaaa', anchor: { ...anchor, kind: 'file' } }, message: { id: 'rm_aaaaaa', body: 'x' } },
  ])('rejects malformed or oversized ops', (raw) => {
    expect(() => parseReviewOp(raw)).toThrow('Malformed review op')
  })

  it('validates the review id around an op request', () => {
    expect(parseReviewOpRequest({ reviewId: 'r_aaaaaa', op: { kind: 'remove-thread', threadId: 'rt_aaaaaa' } })).toEqual({
      reviewId: 'r_aaaaaa',
      op: { kind: 'remove-thread', threadId: 'rt_aaaaaa' },
    })
    expect(() => parseReviewOpRequest({ reviewId: '../r', op: { kind: 'remove-thread', threadId: 'rt_aaaaaa' } })).toThrow()
  })
})

describe('fitReviewBody', () => {
  it('leaves text within the limit alone', () => {
    expect(fitReviewBody('short')).toBe('short')
    const exact = 'x'.repeat(REVIEW_MAX_BODY)
    expect(fitReviewBody(exact)).toBe(exact)
  })

  it('cuts oversized text to the limit and says so', () => {
    const fitted = fitReviewBody('x'.repeat(REVIEW_MAX_BODY + 10))
    expect(fitted).toHaveLength(REVIEW_MAX_BODY)
    expect(fitted.endsWith('[SimpleEdit cut this message at its size limit.]')).toBe(true)
  })
})
