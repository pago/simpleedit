import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff } from '../../../shared/parseDiff'
import type { ReviewThread } from '../../../shared/review-room'
import type { PrReviewComment } from '../../../shared/screenprs'
import { anchorText, buildTour, defaultVerdict, matchesFilter, placeThreads, sliceFile, stepId } from '../review-room'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,12 +1,13 @@',
  ' line1',
  ' line2',
  ' line3',
  '-old4',
  '+new4',
  '+new5',
  ' line6',
  ' line7',
  ' line8',
  ' line9',
  ' line10',
  ' line11',
  ' line12',
  '+new13',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,1 +1,2 @@',
  ' b1',
  '+b2',
].join('\n')
const FILES = parseUnifiedDiff(DIFF)
const A = FILES[0]

const comment = (over: Partial<PrReviewComment>): PrReviewComment => ({ id: 'c', source: 'you', file: '', text: 'x', ...over })

describe('sliceFile', () => {
  it('keeps the cited lines and three either side, under a hunk row', () => {
    const slice = sliceFile(A, [{ start: 4, end: 4 }])
    expect(slice.rows[0].kind).toBe('hunk')
    expect(slice.rows.filter((r) => r.kind !== 'hunk').map((r) => r.text)).toEqual(['line1', 'line2', 'line3', 'old4', 'new4', 'new5', 'line6', 'line7'])
    expect(slice.additions).toBe(2)
    expect(slice.deletions).toBe(1)
  })

  it('starts a new hunk row after a gap', () => {
    const slice = sliceFile(A, [{ start: 1, end: 1 }, { start: 13, end: 13 }], 1)
    expect(slice.rows.map((r) => (r.kind === 'hunk' ? '@@' : r.text))).toEqual(['@@', 'line1', 'line2', '@@', 'line12', 'new13'])
  })

  it('keeps the whole file without ranges', () => {
    expect(sliceFile(A, null)).toBe(A)
  })
})

describe('buildTour', () => {
  const steps = [
    { title: 'The new lines', summary: 'why', refs: [{ path: 'a.ts', line: '4-5' }] },
    { title: 'Unknown file', summary: '', refs: [{ path: 'nowhere.ts', line: '1' }] },
  ]

  it('slices each step to its citations and appends the files no step cites', () => {
    const tour = buildTour(184, steps, FILES)
    expect(tour.steps.map((s) => s.id)).toEqual(['184:0:the-new-lines', '184:1:unknown-file'])
    expect(tour.steps[0].files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect(tour.steps[0].files[0].rows.some((r) => r.text === 'new13')).toBe(false)
    expect(tour.steps[1].files).toEqual([])
    expect(tour.rest.map((f) => f.path)).toEqual(['src/b.ts'])
  })

  it('shows a whole file when a step cites it without a line', () => {
    const tour = buildTour(1, [{ title: 'All of a', summary: '', refs: [{ path: 'src/a.ts' }, { path: 'src/a.ts', line: '2' }] }], FILES)
    expect(tour.steps[0].files[0]).toBe(A)
  })

  it('names steps stably', () => {
    expect(stepId(7, 2, 'Read the *store* first!')).toBe('7:2:read-the-store-first')
  })
})

describe('defaultVerdict', () => {
  it('requests changes for a blocking draft, comments for any, approves otherwise', () => {
    expect(defaultVerdict([comment({ severity: 'nit' }), comment({ severity: 'blocking' })])).toBe('request_changes')
    expect(defaultVerdict([comment({ severity: 'consider' })])).toBe('comment')
    expect(defaultVerdict([])).toBe('approve')
  })
})

describe('line threads', () => {
  const t = (over: Partial<ReviewThread>): ReviewThread => ({
    id: 'rt_aaaaaa01',
    reviewId: 'r_aaaaaa01',
    anchor: { kind: 'line', pr: 184, headSha: 'h', path: 'src/a.ts', side: 'RIGHT', startLine: 5, endLine: 5, snippet: '', before: '', after: '' },
    origin: { kind: 'user' },
    status: 'open',
    outdated: false,
    readSeq: 0,
    askAuthorOpen: false,
    messages: [],
    createdAt: '',
    updatedAt: '',
    ...over,
  })

  it('sits in the first section that shows its end line, at the head on screen only', () => {
    const sections = [
      { key: 'one', files: [sliceFile(A, [{ start: 12, end: 13 }], 0)] },
      { key: 'two', files: [sliceFile(A, [{ start: 5, end: 5 }], 0)] },
      { key: 'rest', files: [A] },
    ]
    const here = t({})
    const old = t({ id: 'rt_aaaaaa02', anchor: { ...(here.anchor as Extract<ReviewThread['anchor'], { kind: 'line' }>), headSha: 'older' } })
    const placed = placeThreads([here, old], 184, 'h', sections)
    expect(placed.get(here.id)).toBe('two')
    expect(placed.has(old.id)).toBe(false)
  })

  it('reads the anchor text off the full file on its side', () => {
    expect(anchorText(A, 'RIGHT', 4, 5)).toEqual({ snippet: 'new4\nnew5', before: 'line1\nline2\nline3', after: 'line6\nline7\nline8' })
    expect(anchorText(A, 'LEFT', 4, 4).snippet).toBe('old4')
  })

  it('filters for the outline', () => {
    const finding = t({ origin: { kind: 'finding', source: 'deep', key: 'k', preExisting: true }, status: 'done' })
    expect(matchesFilter(finding, 'pre', false)).toBe(true)
    expect(matchesFilter(finding, 'open', false)).toBe(false)
    expect(matchesFilter(finding, 'done', false)).toBe(true)
    expect(matchesFilter(finding, 'post', true)).toBe(true)
    expect(matchesFilter(t({}), 'mine', false)).toBe(true)
  })
})
