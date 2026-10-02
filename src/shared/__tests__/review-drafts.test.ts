import { describe, it, expect } from 'vitest'
import { applyDraftOp, clearPostedOp, isEmptyDraft } from '../review-drafts'
import { emptyReviewDraft, type PrReviewComment, type PrReviewDraft } from '../screenprs'

const comment = (over: Partial<PrReviewComment> = {}): PrReviewComment => ({
  id: 'c1', source: 'you', file: 'a.ts', line: '5', text: 'why?', ...over,
})
const draftOf = (...comments: PrReviewComment[]): PrReviewDraft => ({ ...emptyReviewDraft(), comments })

describe('applyDraftOp', () => {
  it('adds a comment, starting a draft from nothing', () => {
    expect(applyDraftOp(null, { kind: 'add-comment', comment: comment() })).toEqual(draftOf(comment()))
  })

  it('dedupes a comment with the same text, file, line and side', () => {
    const d = draftOf(comment())
    expect(applyDraftOp(d, { kind: 'add-comment', comment: comment({ id: 'c2' }) })).toBe(d)
    // An absent side is RIGHT, so spelling it out is still the same comment.
    expect(applyDraftOp(d, { kind: 'add-comment', comment: comment({ id: 'c2', side: 'RIGHT' }) })).toBe(d)
  })

  it('keeps the same line on the other side as a different comment', () => {
    const d = applyDraftOp(draftOf(comment()), { kind: 'add-comment', comment: comment({ id: 'c2', side: 'LEFT' }) })
    expect(d?.comments.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('ignores a re-sent add for an id it already holds', () => {
    const d = draftOf(comment())
    expect(applyDraftOp(d, { kind: 'add-comment', comment: comment({ text: 'edited elsewhere' }) })).toBe(d)
  })

  it('updates and removes by id, whatever the position', () => {
    const d = draftOf(comment(), comment({ id: 'c2', line: '9' }), comment({ id: 'c3', line: '12' }))
    const updated = applyDraftOp(d, { kind: 'update-comment', id: 'c2', patch: { text: 'better' } })
    expect(updated?.comments.map((c) => c.text)).toEqual(['why?', 'better', 'why?'])
    const removed = applyDraftOp(updated, { kind: 'remove-comment', id: 'c2' })
    expect(removed?.comments.map((c) => c.id)).toEqual(['c1', 'c3'])
  })

  it('never lets a patch change a comment’s id', () => {
    const patch = { text: 'x', id: 'hijack' } as unknown as Partial<Omit<PrReviewComment, 'id'>>
    const d = applyDraftOp(draftOf(comment()), { kind: 'update-comment', id: 'c1', patch })
    expect(d?.comments[0].id).toBe('c1')
  })

  it('refuses an update that would duplicate another comment', () => {
    const d = draftOf(comment(), comment({ id: 'c2', text: 'other' }))
    expect(applyDraftOp(d, { kind: 'update-comment', id: 'c2', patch: { text: 'why?' } })).toBe(d)
  })

  it('returns the same draft for an op that changes nothing', () => {
    const d = draftOf(comment())
    expect(applyDraftOp(d, { kind: 'update-comment', id: 'missing', patch: { text: 'x' } })).toBe(d)
    expect(applyDraftOp(d, { kind: 'remove-comment', id: 'missing' })).toBe(d)
    expect(applyDraftOp(d, { kind: 'set-summary', summary: '' })).toBe(d)
    expect(applyDraftOp(d, { kind: 'set-verdict', verdict: 'approve' })).toBe(d)
    expect(applyDraftOp(null, { kind: 'clear' })).toBeNull()
  })

  it('sets the summary and the verdict', () => {
    const d = applyDraftOp(applyDraftOp(null, { kind: 'set-summary', summary: 'LGTM' }), { kind: 'set-verdict', verdict: 'comment' })
    expect(d).toEqual({ comments: [], summary: 'LGTM', verdict: 'comment' })
  })

  it('returns null once a draft is empty again, and on clear', () => {
    expect(applyDraftOp(draftOf(comment()), { kind: 'remove-comment', id: 'c1' })).toBeNull()
    expect(applyDraftOp({ ...emptyReviewDraft(), summary: 'x' }, { kind: 'set-summary', summary: '' })).toBeNull()
    expect(applyDraftOp(draftOf(comment()), { kind: 'clear' })).toBeNull()
  })

  it('keeps a draft whose only content is a chosen verdict', () => {
    expect(applyDraftOp(null, { kind: 'set-verdict', verdict: 'request_changes' })).toEqual({
      comments: [], summary: '', verdict: 'request_changes',
    })
  })
})

describe('isEmptyDraft', () => {
  it('is true only for a draft nobody started', () => {
    expect(isEmptyDraft(emptyReviewDraft())).toBe(true)
    expect(isEmptyDraft({ ...emptyReviewDraft(), summary: ' ' })).toBe(false)
    expect(isEmptyDraft({ ...emptyReviewDraft(), verdict: 'comment' })).toBe(false)
    expect(isEmptyDraft(draftOf(comment()))).toBe(false)
  })
})

describe('clear-posted', () => {
  const posted: PrReviewDraft = { comments: [comment()], summary: 'LGTM', verdict: 'request_changes' }

  it('deletes the draft when it is still exactly what was posted', () => {
    expect(applyDraftOp(posted, clearPostedOp(posted))).toBeNull()
  })

  it('keeps a comment added while the post was in flight', () => {
    const late = comment({ id: 'c2', text: 'one more' })
    const stored = { ...posted, comments: [...posted.comments, late] }
    expect(applyDraftOp(stored, clearPostedOp(posted))).toEqual({ ...emptyReviewDraft(), comments: [late] })
  })

  it('keeps a summary or verdict changed while the post was in flight', () => {
    const stored = { ...posted, summary: 'LGTM, one nit', verdict: 'comment' as const }
    expect(applyDraftOp(stored, clearPostedOp(posted))).toEqual({ comments: [], summary: 'LGTM, one nit', verdict: 'comment' })
  })

  it('is a no-op on a draft already cleared elsewhere', () => {
    expect(applyDraftOp(null, clearPostedOp(posted))).toBeNull()
  })
})
