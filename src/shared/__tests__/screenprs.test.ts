import { describe, it, expect } from 'vitest'
import {
  bucketOf,
  isCritical,
  compareInBucket,
  compareDeepFindings,
  parseLineAnchor,
  buildReviewPayload,
  foldCommentsIntoBody,
  reviewSubmitError,
  groupStacks,
  type ScreenPrCard,
  type TriageFinding,
  type DeepFinding,
  type PrReviewDraft,
} from '../screenprs'

const issue: TriageFinding = { label: 'issue', file: 'a.ts', title: 'bug' }
const suggestion: TriageFinding = { label: 'suggestion', file: 'a.ts', title: 'nit' }

function card(over: Partial<ScreenPrCard>): ScreenPrCard {
  const base: ScreenPrCard = {
    owner: 'acme', repo: 'ui', number: 1, url: 'u', title: 't', author: 'a', updatedAt: '2026-07-01',
    headSha: 'sha1', additions: 10, deletions: 2, changedFiles: 1, baseRefName: 'main', headRefName: 'feat/x',
    ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false, body: '', diff: '',
    impact: 'low', findings: [], bucket: 'quick',
  }
  const merged = { ...base, ...over }
  return { ...merged, bucket: bucketOf(merged) }
}

describe('isCritical', () => {
  it('is true for high impact or any issue finding', () => {
    expect(isCritical({ impact: 'high', findings: [] })).toBe(true)
    expect(isCritical({ impact: 'low', findings: [issue] })).toBe(true)
    expect(isCritical({ impact: 'low', findings: [suggestion] })).toBe(false)
    expect(isCritical({ impact: 'medium', findings: [] })).toBe(false)
  })
})

describe('bucketOf', () => {
  it('sends CI-failing PRs to waiting-on-author regardless of everything else', () => {
    expect(bucketOf({ ci: 'failing', approvedByOther: false, impact: 'high', findings: [issue] })).toBe('waiting')
  })
  it('surfaces approved-by-other only when critical, else FYI', () => {
    expect(bucketOf({ ci: 'green', approvedByOther: true, impact: 'high', findings: [] })).toBe('attention')
    expect(bucketOf({ ci: 'green', approvedByOther: true, impact: 'low', findings: [] })).toBe('fyi')
  })
  it('routes unapproved PRs by criticality', () => {
    expect(bucketOf({ ci: 'green', approvedByOther: false, impact: 'low', findings: [issue] })).toBe('attention')
    expect(bucketOf({ ci: 'pending', approvedByOther: false, impact: 'low', findings: [] })).toBe('quick')
  })
})

describe('compareInBucket', () => {
  it('orders attention worst-first (impact, then issue count)', () => {
    const hi = card({ impact: 'high', findings: [issue], number: 1 })
    const med = card({ impact: 'low', findings: [issue, issue], number: 2 }) // critical via issues
    expect(hi.bucket).toBe('attention')
    expect(med.bucket).toBe('attention')
    expect(compareInBucket(hi, med)).toBeLessThan(0) // high impact sorts first
  })
  it('orders quick smallest-first', () => {
    const small = card({ impact: 'low', additions: 1, deletions: 0, number: 1 })
    const big = card({ impact: 'low', additions: 90, deletions: 30, number: 2 })
    expect(small.bucket).toBe('quick')
    expect(compareInBucket(small, big)).toBeLessThan(0)
  })
  it('is a total order across buckets (attention before quick before waiting before fyi)', () => {
    const attn = card({ impact: 'high' })
    const quick = card({ impact: 'low' })
    const waiting = card({ ci: 'failing' })
    const fyi = card({ approvedByOther: true, impact: 'low' })
    const sorted = [fyi, waiting, quick, attn].sort(compareInBucket).map((c) => c.bucket)
    expect(sorted).toEqual(['attention', 'quick', 'waiting', 'fyi'])
  })
})

describe('compareDeepFindings', () => {
  const f = (over: Partial<DeepFinding>): DeepFinding => ({
    lens: 'soundness', severity: 'note', file: 'a.ts', title: 't', detail: 'd', ...over,
  })
  it('orders blocking → concern → note, then by lens order, then file', () => {
    const note = f({ severity: 'note' })
    const blocking = f({ severity: 'blocking' })
    const concern = f({ severity: 'concern' })
    expect([note, blocking, concern].sort(compareDeepFindings).map((x) => x.severity)).toEqual([
      'blocking', 'concern', 'note',
    ])
  })
  it('breaks severity ties by lens order (soundness before intent)', () => {
    const intent = f({ severity: 'concern', lens: 'intent' })
    const soundness = f({ severity: 'concern', lens: 'soundness' })
    expect([intent, soundness].sort(compareDeepFindings).map((x) => x.lens)).toEqual(['soundness', 'intent'])
  })
})

// ── review composer ─────────────────────────────────────────────────────────

const draft = (over: Partial<PrReviewDraft>): PrReviewDraft => ({
  comments: [], summary: '', verdict: 'approve', ...over,
})

describe('parseLineAnchor', () => {
  it('takes a single line, the first of a range, or after an L prefix', () => {
    expect(parseLineAnchor('88')).toBe(88)
    expect(parseLineAnchor('88–94')).toBe(88) // en-dash range
    expect(parseLineAnchor('88-94')).toBe(88) // hyphen range
    expect(parseLineAnchor('L120')).toBe(120)
  })
  it('returns null for missing / placeholder / non-numeric lines', () => {
    expect(parseLineAnchor(undefined)).toBeNull()
    expect(parseLineAnchor('')).toBeNull()
    expect(parseLineAnchor('—')).toBeNull()
    expect(parseLineAnchor('n/a')).toBeNull()
  })
})

describe('buildReviewPayload', () => {
  it('maps the verdict to the GitHub review event', () => {
    expect(buildReviewPayload(draft({ verdict: 'approve' })).event).toBe('APPROVE')
    expect(buildReviewPayload(draft({ verdict: 'comment' })).event).toBe('COMMENT')
    expect(buildReviewPayload(draft({ verdict: 'request_changes' })).event).toBe('REQUEST_CHANGES')
  })
  it('anchors single/range lines to the RIGHT side', () => {
    const p = buildReviewPayload(draft({
      comments: [
        { source: 'triage', file: 'a.ts', line: '88', text: 'x' },
        { source: 'deep', file: 'b.ts', line: '10–14', text: 'y' },
      ],
    }))
    expect(p.comments).toEqual([
      { path: 'a.ts', line: 88, side: 'RIGHT', body: 'x' },
      { path: 'b.ts', line: 10, side: 'RIGHT', body: 'y' },
    ])
  })
  it('folds line-less and file-less comments into the body as bullets', () => {
    const p = buildReviewPayload(draft({
      summary: 'Overall LGTM',
      comments: [
        { source: 'you', file: 'c.ts', line: '—', text: 'no anchor' },
        { source: 'you', file: '', text: 'general note' },
      ],
    }))
    expect(p.comments).toEqual([])
    expect(p.body).toBe('Overall LGTM\n\n- c.ts — no anchor\n- general note')
  })
  it('keeps an empty body empty when there is nothing to say', () => {
    expect(buildReviewPayload(draft({})).body).toBe('')
  })
})

describe('foldCommentsIntoBody (422 recovery)', () => {
  it('collapses anchored comments into body bullets and clears comments', () => {
    const p = buildReviewPayload(draft({
      summary: 's', comments: [{ source: 'triage', file: 'a.ts', line: '5', text: 'boom' }],
    }))
    const folded = foldCommentsIntoBody(p)
    expect(folded.comments).toEqual([])
    expect(folded.body).toBe('s\n\n- a.ts:5 — boom')
  })
  it('is a no-op when there are no anchored comments', () => {
    const p = buildReviewPayload(draft({ summary: 's' }))
    expect(foldCommentsIntoBody(p)).toEqual(p)
  })
})

describe('reviewSubmitError', () => {
  it('allows an empty approve', () => {
    expect(reviewSubmitError(draft({ verdict: 'approve' }))).toBeNull()
  })
  it('requires content for comment / request-changes', () => {
    expect(reviewSubmitError(draft({ verdict: 'comment' }))).toMatch(/summary or at least one comment/)
    expect(reviewSubmitError(draft({ verdict: 'request_changes' }))).toMatch(/summary or a comment/)
  })
  it('is satisfied by a body or by a comment', () => {
    expect(reviewSubmitError(draft({ verdict: 'comment', summary: 'hi' }))).toBeNull()
    expect(reviewSubmitError(draft({
      verdict: 'request_changes', comments: [{ source: 'you', file: 'a.ts', line: '1', text: 'fix' }],
    }))).toBeNull()
  })
})

describe('groupStacks', () => {
  it('chains a stack base→head and leaves standalones alone', () => {
    const foundation = card({ number: 645, headRefName: 'feat/builder', baseRefName: 'main' })
    const dependent = card({ number: 648, headRefName: 'feat/migrate', baseRefName: 'feat/builder' })
    const solo = card({ number: 700, headRefName: 'fix/z', baseRefName: 'main' })
    const groups = groupStacks([foundation, dependent, solo])
    expect(groups).toHaveLength(2)
    const stack = groups.find((g) => g.stackId)
    expect(stack?.cards.map((c) => c.number)).toEqual([645, 648])
    expect(groups.find((g) => !g.stackId)?.cards[0].number).toBe(700)
  })
  it('does not link across repos even with matching branch names', () => {
    const a = card({ repo: 'ui', number: 1, headRefName: 'feat/x', baseRefName: 'main' })
    const b = card({ repo: 'api', number: 2, headRefName: 'feat/y', baseRefName: 'feat/x' })
    const groups = groupStacks([a, b])
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => !g.stackId)).toBe(true)
  })
  it('treats a card whose parent is absent (another bucket) as standalone', () => {
    const dependent = card({ number: 648, headRefName: 'feat/migrate', baseRefName: 'feat/builder' })
    const groups = groupStacks([dependent])
    expect(groups).toHaveLength(1)
    expect(groups[0].stackId).toBeUndefined()
  })
  it('keeps all descendants of a branching stack (parent before children)', () => {
    const root = card({ number: 1, headRefName: 'root', baseRefName: 'main' })
    const childA = card({ number: 2, headRefName: 'a', baseRefName: 'root' })
    const childB = card({ number: 3, headRefName: 'b', baseRefName: 'root' })
    const groups = groupStacks([root, childA, childB])
    expect(groups).toHaveLength(1)
    // all three in one stack; neither dependent is dropped to standalone
    expect(groups[0].cards.map((c) => c.number)).toEqual([1, 2, 3])
    expect(groups[0].cards[0].number).toBe(1) // root first
  })
})
