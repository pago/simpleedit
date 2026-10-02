import { describe, it, expect } from 'vitest'
import { applyDraftOp, clearPostedOp, isEmptyDraft, parseDraftOpRequest, parseReviewDraft, truncateSnippet, type PrReviewDraftOp } from '../review-drafts'
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

describe('parseDraftOpRequest', () => {
  const URL = 'https://github.com/acme/app/pull/7'
  const req = (op: unknown, url: unknown = URL): unknown => ({ url, op })

  it('passes every well-formed op through', () => {
    const ops = [
      { kind: 'add-comment', comment: comment({ side: 'LEFT', snippet: 'x', sha: 'abc' }) },
      { kind: 'update-comment', id: 'c1', patch: { text: 'better', line: '6' } },
      { kind: 'remove-comment', id: 'c1' },
      { kind: 'set-summary', summary: 'LGTM' },
      { kind: 'set-verdict', verdict: 'request_changes' },
      { kind: 'clear' },
      { kind: 'clear-posted', ids: ['c1'], summary: '', verdict: 'approve' },
    ]
    for (const op of ops) expect(parseDraftOpRequest(req(op))).toEqual({ url: URL, op })
  })

  it('rejects a url that is not a pull request, or too long', () => {
    const op = { kind: 'clear' }
    for (const url of ['u1', '__proto__', 'https://github.com/acme/app/issues/7', 42, `${URL}?${'x'.repeat(600)}`]) {
      expect(() => parseDraftOpRequest(req(op, url))).toThrow(/pull-request URL/)
    }
  })

  it('rejects an unknown kind or a mistyped field', () => {
    const bad = [
      null,
      { kind: 'drop-table' },
      { kind: 'add-comment', comment: { ...comment(), text: 5 } },
      { kind: 'add-comment', comment: { ...comment(), source: 'admin' } },
      { kind: 'add-comment', comment: { ...comment(), side: 'MIDDLE' } },
      { kind: 'add-comment', comment: { ...comment(), id: '' } },
      { kind: 'add-comment', comment: { id: 'c1', source: 'you', file: 'a.ts' } },
      { kind: 'update-comment', id: 'c1', patch: { line: 6 } },
      { kind: 'update-comment', id: 'c1' },
      { kind: 'remove-comment', id: ['c1'] },
      { kind: 'set-summary', summary: 'x'.repeat(64 * 1024 + 1) },
      { kind: 'add-comment', comment: comment({ snippet: 'x'.repeat(64 * 1024 + 1) }) },
      { kind: 'set-verdict', verdict: 'merge' },
      { kind: 'clear-posted', ids: [1], summary: '', verdict: 'approve' },
    ]
    for (const op of bad) expect(() => parseDraftOpRequest(req(op)), JSON.stringify(op)?.slice(0, 80)).toThrow(/Malformed/)
    expect(() => parseDraftOpRequest(null)).toThrow(/Malformed/)
  })

  // Each shape a client sends, as structured clone delivers it: a key whose
  // value is `undefined` survives the clone and must read as absent.
  it('takes every producer’s op with its optional fields left undefined', () => {
    const finding = { file: 'a.ts', line: undefined, text: 'finding', sha: undefined }
    const ops: PrReviewDraftOp[] = [
      { kind: 'add-comment', comment: { id: 't', source: 'triage', ...finding } },
      { kind: 'add-comment', comment: { id: 'd', source: 'deep', ...finding } },
      { kind: 'add-comment', comment: { id: 'o', source: 'overview', ...finding, file: '' } },
      { kind: 'add-comment', comment: { id: 'r', source: 'you', file: 'a.ts', line: '3-5', side: 'LEFT', snippet: '-x', text: 'n', sha: 'abc' } },
      { kind: 'add-comment', comment: { id: 'p', source: 'you', file: 'a.ts', line: '3', side: 'RIGHT', snippet: '+x', text: 'n', sha: undefined } },
      { kind: 'update-comment', id: 'r', patch: { text: 'edited', line: undefined, side: undefined, snippet: undefined, sha: undefined } },
      { kind: 'set-summary', summary: 'LGTM' },
      { kind: 'set-verdict', verdict: 'comment' },
      clearPostedOp(draftOf(comment(), comment({ id: 'c2', line: undefined }))),
    ]
    for (const op of ops) {
      const cloned = structuredClone(op)
      const parsed = parseDraftOpRequest(req(cloned)).op
      expect(parsed, op.kind).toEqual(op)
      if (parsed.kind === 'add-comment') expect(Object.values(parsed.comment)).not.toContain(undefined)
      if (parsed.kind === 'update-comment') expect(parsed.patch).toStrictEqual({ text: 'edited' })
    }
  })

  it('stores only the fields it knows, and no empty head stamp', () => {
    const op = { kind: 'add-comment', comment: { ...comment(), sha: '', extra: 'x'.repeat(1e6) } }
    expect(parseDraftOpRequest(req(op)).op).toEqual({ kind: 'add-comment', comment: comment() })
  })
})

describe('parseReviewDraft', () => {
  it('drops a malformed comment and keeps the others', () => {
    const raw = { comments: [comment(), { id: 'c2' }, 'x'], summary: 's', verdict: 'comment' }
    expect(parseReviewDraft(raw)).toEqual({ comments: [comment()], summary: 's', verdict: 'comment' })
  })

  it('is null for something that is not a draft, or nothing left of one', () => {
    expect(parseReviewDraft('x')).toBeNull()
    expect(parseReviewDraft({ comments: [{}], summary: 3 })).toBeNull()
  })
})

describe('truncateSnippet', () => {
  it('leaves a short snippet alone', () => {
    expect(truncateSnippet('+a\n-b')).toBe('+a\n-b')
  })

  it('cuts a long range to its first lines, and a wide line to a few KB', () => {
    const range = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join('\n')
    const cut = truncateSnippet(range)
    expect(cut.split('\n')).toHaveLength(40)
    expect(cut.endsWith('+line 39…')).toBe(true)
    expect(truncateSnippet('x'.repeat(100_000))).toBe(`${'x'.repeat(4096)}…`)
  })

  it('keeps any range the desktop or phone can select under the validator’s cap', () => {
    const url = 'https://github.com/acme/app/pull/7'
    const snippet = truncateSnippet(Array.from({ length: 5000 }, () => 'y'.repeat(200)).join('\n'))
    const op = { kind: 'add-comment', comment: comment({ snippet }) }
    expect(parseDraftOpRequest({ url, op }).op).toEqual(op)
  })
})
