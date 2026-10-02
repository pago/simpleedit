import { describe, it, expect } from 'vitest'
import {
  bucketOf,
  isCritical,
  compareInBucket,
  compareDeepFindings,
  parseLineAnchor,
  parseLineRange,
  commentableLines,
  buildReviewPayload,
  foldedReviewPayload,
  addFolds,
  describeFolds,
  reviewSubmitError,
  groupStacks,
  type ScreenPrCard,
  type TriageFinding,
  type DeepFinding,
  type PrReviewDraft,
  type PrReviewComment,
  anchorState,
  anchorsForHead,
  anchorCounts,
  reviewFolds,
  baseWarning,
  type BaseAnalysis,
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
  it('returns null for a line number GitHub cannot accept', () => {
    // Files are 1-based. A `0` anchor is a guaranteed 422, and a 422 collapses
    // EVERY anchor in the review into the body — one bad number costs the whole
    // payload its line comments.
    expect(parseLineAnchor('0')).toBeNull()
    expect(parseLineAnchor('L0')).toBeNull()
  })
})

describe('anchorState', () => {
  const at = (sha: string | undefined, line?: string): PrReviewComment => ({
    id: 'c', source: 'you', file: 'a.ts', text: 'note', ...(line === undefined ? {} : { line }), ...(sha === undefined ? {} : { sha }),
  })

  it('is `current` only when the stamp matches the head on screen', () => {
    expect(anchorState(at('sha1', '11'), 'sha1')).toBe('current')
  })

  it('is `moved` when the stamp names a different head', () => {
    expect(anchorState(at('sha1', '11'), 'sha2')).toBe('moved')
  })

  it('is `unverified` when either side is missing — not `current`', () => {
    // The whole point of the third state. Both of these used to resolve to
    // "fine, anchor it", which is how a comment reached a line nobody read.
    expect(anchorState(at(undefined, '11'), 'sha1')).toBe('unverified')
    expect(anchorState(at('sha1', '11'), '')).toBe('unverified')
    expect(anchorState(at('', '11'), 'sha1')).toBe('unverified')
  })

  it('is `none` for a comment that never had a line', () => {
    expect(anchorState(at('sha1'), 'sha1')).toBe('none')
    expect(anchorState(at(undefined), '')).toBe('none')
  })
})

describe('anchorsForHead', () => {
  const at = (sha: string | undefined, line: string, text = `note ${line}`): PrReviewComment => ({
    id: 'c', source: 'you', file: 'a.ts', line, text, ...(sha === undefined ? {} : { sha }),
  })
  const draftOf = (...comments: PrReviewComment[]): PrReviewDraft => ({ comments, summary: '', verdict: 'comment' })

  it('keeps a verified anchor', () => {
    const draft = draftOf(at('sha1', '11'))
    expect(anchorsForHead(draft, 'sha1')).toBe(draft)
    expect(buildReviewPayload(anchorsForHead(draft, 'sha1')).comments).toHaveLength(1)
  })

  it('folds a moved anchor into the body, keeping the file and the text', () => {
    const payload = buildReviewPayload(anchorsForHead(draftOf(at('sha1', '11')), 'sha2'))
    expect(payload.comments).toEqual([])
    expect(payload.body).toContain('a.ts:11 (on an earlier commit) — note 11')
  })

  it('cites an unchecked line as unchecked, and only a real number', () => {
    expect(buildReviewPayload(anchorsForHead(draftOf(at(undefined, '11')), 'sha1')).body).toBe('- a.ts:11 (not checked against this commit) — note 11')
    expect(buildReviewPayload(anchorsForHead(draftOf(at('sha1', '—')), 'sha2')).body).toBe('- a.ts — note —')
  })

  it('leaves the counts as they were on the raw draft', () => {
    const raw = draftOf(at('sha1', '11'), at(undefined, '12'), at('sha2', '13'))
    expect(anchorCounts(raw, 'sha2')).toEqual({ none: 0, current: 1, moved: 1, unverified: 1 })
    expect(reviewFolds(raw, { headSha: 'sha2' })).toEqual({ count: 2, reasons: { moved: 1, unverified: 1 } })
    expect(anchorsForHead(raw, 'sha2').comments.map((c) => c.line)).toEqual([undefined, undefined, '13'])
  })

  it('folds an anchor it cannot check, for either reason', () => {
    expect(buildReviewPayload(anchorsForHead(draftOf(at(undefined, '11')), 'sha1')).comments).toEqual([])
    expect(buildReviewPayload(anchorsForHead(draftOf(at('sha1', '11')), '')).comments).toEqual([])
  })

  it('gives siblings read off one commit the same fate', () => {
    // One folding while the other posts is what a two-valued predicate produced.
    const payload = buildReviewPayload(anchorsForHead(draftOf(at('sha1', '11'), at('sha1', '40')), 'sha2'))
    expect(payload.comments).toEqual([])
    expect(payload.body).toContain('note 11')
    expect(payload.body).toContain('note 40')
  })

  it('separates the two reasons an anchor was dropped', () => {
    const counts = anchorCounts(draftOf(at('sha1', '11'), at(undefined, '40'), at('sha2', '7')), 'sha2')
    expect(counts).toEqual({ none: 0, current: 1, moved: 1, unverified: 1 })
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
        { id: 'c1', source: 'triage', file: 'a.ts', line: '88', text: 'x' },
        { id: 'c2', source: 'deep', file: 'b.ts', line: '10–14', text: 'y' },
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
        { id: 'c3', source: 'you', file: 'c.ts', line: '—', text: 'no anchor' },
        { id: 'c4', source: 'you', file: '', text: 'general note' },
      ],
    }))
    expect(p.comments).toEqual([])
    expect(p.body).toBe('Overall LGTM\n\n- c.ts — no anchor\n- general note')
  })
  it('keeps an empty body empty when there is nothing to say', () => {
    expect(buildReviewPayload(draft({})).body).toBe('')
  })
})

describe('parseLineRange', () => {
  it('reads single lines and ranges', () => {
    expect(parseLineRange('88')).toEqual({ start: 88, end: 88 })
    expect(parseLineRange('88–94')).toEqual({ start: 88, end: 94 })
    expect(parseLineRange('88-94')).toEqual({ start: 88, end: 94 })
    expect(parseLineRange('L88-L94')).toEqual({ start: 88, end: 94 })
  })
  it('keeps only the first line of a reversed range', () => {
    expect(parseLineRange('94-88')).toEqual({ start: 94, end: 94 })
  })
  it('returns null where there is no line to anchor', () => {
    expect(parseLineRange(undefined)).toBeNull()
    expect(parseLineRange('—')).toBeNull()
    expect(parseLineRange('0-4')).toBeNull()
  })
})

// a.ts: two hunks. b.ts: one hunk, a deletion only.
const GH_DIFF = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,5 @@ fn
 ctx10
-old11
+new11
+new12
 ctx13
 ctx14
@@ -40,3 +41,3 @@ other
 ctx41
-old41
+new42
 ctx43
diff --git a/b.ts b/b.ts
index 3333333..4444444 100644
--- a/b.ts
+++ b/b.ts
@@ -5,3 +5,2 @@
 keep5
-gone6
 keep6
`

describe('commentableLines', () => {
  const lines = commentableLines(GH_DIFF)
  it('maps each side of each file to the hunk a line sits in', () => {
    const a = lines.get('a.ts')
    expect([...(a?.RIGHT ?? [])]).toEqual([[10, 0], [11, 0], [12, 0], [13, 0], [14, 0], [41, 1], [42, 1], [43, 1]])
    expect([...(a?.LEFT ?? [])]).toEqual([[10, 0], [11, 0], [12, 0], [13, 0], [40, 1], [41, 1], [42, 1]])
  })
  it('keeps files apart', () => {
    const b = lines.get('b.ts')
    expect([...(b?.RIGHT.keys() ?? [])]).toEqual([5, 6])
    expect([...(b?.LEFT.keys() ?? [])]).toEqual([5, 6, 7])
  })
})

describe('buildReviewPayload against GitHub\'s diff', () => {
  const commentable = commentableLines(GH_DIFF)
  const you = (over: Partial<PrReviewComment>): PrReviewComment => ({ id: 'c', source: 'you', file: 'a.ts', text: 'n', ...over })
  const build = (comments: PrReviewComment[], opts: Parameters<typeof buildReviewPayload>[1] = {}) =>
    buildReviewPayload(draft({ comments }), { commentable, ...opts })

  it('posts a range inside one hunk as a real range', () => {
    expect(build([you({ line: '11-13' })]).comments).toEqual([
      { path: 'a.ts', start_line: 11, start_side: 'RIGHT', line: 13, side: 'RIGHT', body: 'n' },
    ])
  })
  it('narrows a range across hunks to its first line', () => {
    expect(build([you({ line: '12-42' })]).comments).toEqual([{ path: 'a.ts', line: 12, side: 'RIGHT', body: 'n' }])
  })
  it('anchors a deleted line on the LEFT side', () => {
    expect(build([you({ file: 'b.ts', line: '6', side: 'LEFT' })]).comments).toEqual([
      { path: 'b.ts', line: 6, side: 'LEFT', body: 'n' },
    ])
  })
  it('folds a deleted-line comment on an isolated base, keeping its line and snippet', () => {
    const p = build([you({ file: 'b.ts', line: '6', side: 'LEFT', text: 'why?', snippet: 'gone6' })], { isolatedBase: true })
    expect(p.comments).toEqual([])
    expect(p.body).toBe('- b.ts:6 (deleted line) — why?\n  > gone6')
  })
  it('still anchors new-side comments on an isolated base', () => {
    expect(build([you({ line: '11' })], { isolatedBase: true }).comments).toHaveLength(1)
  })
  it('folds a row outside the hunks alone while the others anchor', () => {
    const p = build([you({ line: '11', text: 'ok' }), you({ line: '30', text: 'out', snippet: 'far away' })])
    expect(p.comments).toEqual([{ path: 'a.ts', line: 11, side: 'RIGHT', body: 'ok' }])
    expect(p.body).toBe('- a.ts:30 — out\n  > far away')
  })
  it('folds a range whose first line is outside the hunks, keeping the range', () => {
    expect(build([you({ line: '30-41' })]).body).toBe('- a.ts:30-41 — n')
  })
  it('folds a comment on a file GitHub does not show', () => {
    expect(build([you({ file: 'c.ts', line: '1' })]).comments).toEqual([])
  })
  it('pins the review to the head it was checked against', () => {
    expect(build([], { headSha: 'abc123' }).commit_id).toBe('abc123')
    expect(build([]).commit_id).toBeUndefined()
  })
})

describe('buildReviewPayload without a commentable set', () => {
  it('honours the side but does not check or widen anchors', () => {
    const p = buildReviewPayload(draft({
      comments: [
        { id: 'c5', source: 'you', file: 'a.ts', line: '5', side: 'LEFT', text: 'x' },
        { id: 'c6', source: 'you', file: 'a.ts', line: '30-41', text: 'y' },
      ],
    }))
    expect(p.comments).toEqual([
      { path: 'a.ts', line: 5, side: 'LEFT', body: 'x' },
      { path: 'a.ts', line: 30, side: 'RIGHT', body: 'y' },
    ])
    expect(p.commit_id).toBeUndefined()
  })
})

describe('foldedReviewPayload (422 recovery)', () => {
  it('puts every comment in the body, in draft order, and clears comments', () => {
    const folded = foldedReviewPayload(draft({
      summary: 's', comments: [{ id: 'c7', source: 'triage', file: 'a.ts', line: '5', text: 'boom' }, { id: 'c8', source: 'you', file: '', text: 'note' }],
    }))
    expect(folded.comments).toEqual([])
    expect(folded.body).toBe('s\n\n- a.ts:5 — boom\n- note')
  })
  it('keeps the side, the range, the snippet and the commit', () => {
    const folded = foldedReviewPayload(draft({
      verdict: 'comment',
      comments: [
        { id: 'r', source: 'you', file: 'a.ts', line: '3-5', text: 'r' },
        { id: 'l', source: 'you', file: 'b.ts', line: '6', side: 'LEFT', text: 'l', snippet: 'old()' },
      ],
    }), { headSha: 'abc' })
    expect(folded).toEqual({ event: 'COMMENT', commit_id: 'abc', comments: [], body: '- a.ts:3-5 — r\n- b.ts:6 (deleted line) — l\n  > old()' })
  })
})

describe('describeFolds', () => {
  it('names each reason with its count, in a fixed order', () => {
    const folds = addFolds(addFolds({ count: 0, reasons: {} }, 'moved'), 'not-in-diff', 2)
    expect(folds.count).toBe(3)
    expect(describeFolds(folds)).toBe('2 outside GitHub’s diff, 1 written before the branch moved')
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
      verdict: 'request_changes', comments: [{ id: 'c8', source: 'you', file: 'a.ts', line: '1', text: 'fix' }],
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

describe('baseWarning', () => {
  const polluted: BaseAnalysis = { kind: 'polluted', basePr: 2531, foreign: 1, behindBy: 199, own: [{ sha: 'a', subject: 'x' }, { sha: 'b', subject: 'y' }], isolated: true }

  it('contrasts GitHub’s file count with the own commits’ once the diff is narrowed', () => {
    const base = { ...polluted, github: { additions: 900, deletions: 40, changedFiles: 69 } }
    expect(baseWarning({ base, baseRefName: 'compact-density', changedFiles: 52 })).toBe(
      "Misleading diff on GitHub: includes 1 commit from #2531 (base rebased, behind by 199). GitHub shows 69 files; this PR's own 2 commits touch 52. Showing only those."
    )
  })

  it('names what is shown when GitHub’s figures are unknown', () => {
    expect(baseWarning({ base: polluted, baseRefName: 'compact-density', changedFiles: 52 })).toBe(
      "Misleading diff on GitHub: includes 1 commit from #2531 (base rebased, behind by 199). Showing only this PR's 2 commits."
    )
  })

  it('falls back to the branch name and says when it could not isolate', () => {
    const base = { ...polluted, basePr: undefined, behindBy: 0, foreign: 2, isolated: false }
    expect(baseWarning({ base, baseRefName: 'lower', changedFiles: 69 })).toBe(
      "Misleading diff on GitHub: includes 2 commits from lower (base rebased). Couldn't isolate this PR's commits; the diff below includes the lower layer."
    )
  })

  it('stays quiet unless the diff is polluted', () => {
    expect(baseWarning({ base: undefined, baseRefName: 'main', changedFiles: 1 })).toBeNull()
    expect(baseWarning({ base: { kind: 'default' }, baseRefName: 'main', changedFiles: 1 })).toBeNull()
    expect(baseWarning({ base: { kind: 'clean' }, baseRefName: 'lower', changedFiles: 1 })).toBeNull()
  })
})
