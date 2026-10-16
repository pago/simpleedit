import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrReviewComment, PrReviewDraft } from '../../shared/screenprs'
import type { ReviewLayerSubmission } from '../../shared/review-room'

/**
 * `gh` is a router over fixtures: each PR's view, the compare answers and the
 * diffs. Everything GitHub-shaped the service reads comes from here.
 */
const gh = vi.hoisted(() => ({
  prs: new Map<string, Record<string, unknown>>(),
  compares: new Map<string, unknown>(),
  diffs: new Map<string, string>(),
  calls: [] as string[][],
}))
const fakes = vi.hoisted(() => ({
  cache: new Map<string, { headSha: string; baseKey?: string; diff: string; base?: unknown; triage: unknown; deep?: unknown; overview?: unknown }>(),
  board: [] as Array<{ url: string; number: number; headSha: string; headRefName: string; baseRefName: string }>,
  drafts: {} as Record<string, PrReviewDraft>,
  linked: new Set<string>(),
}))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
vi.mock('../github/gh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../github/gh')>()
  const runGh = vi.fn(async (args: string[]) => {
    gh.calls.push(args)
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ defaultBranchRef: { name: 'main' } })
    if (args[0] === 'pr' && args[1] === 'checks') return '[]'
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = gh.prs.get(args[2]!)
      if (!pr) throw new Error('gh pr exited 1: no such PR')
      return JSON.stringify(pr)
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      const head = args[args.indexOf('--head') + 1]
      return JSON.stringify([...gh.prs.values()].filter((p) => p.headRefName === head).map((p) => ({ ...p, isCrossRepository: false })))
    }
    if (args[0] === 'api') {
      const path = args.at(-1)!
      const accept = args.includes('Accept: application/vnd.github.diff')
      const answer = accept ? gh.diffs.get(path) : gh.compares.get(path)
      if (answer instanceof Error) throw answer
      if (answer === undefined) throw new Error(`gh api exited 1: unexpected ${path}`)
      return typeof answer === 'string' ? answer : JSON.stringify(answer)
    }
    throw new Error(`unexpected gh ${args.join(' ')}`)
  })
  return { ...actual, runGh, getPrDiff: vi.fn(async (ref: { url: string }) => gh.diffs.get(ref.url) ?? '') }
})
vi.mock('../github/review-graphql', () => ({ postReviewLayer: vi.fn(), deletePendingReview: vi.fn(async () => {}) }))
vi.mock('../github/review-threads', () => ({ importGithubReviewThreads: vi.fn(async () => []) }))
vi.mock('../screenprs', () => ({
  screeningSnapshot: () => ({ status: 'done', triaging: [], entries: fakes.board.map((pr) => ({ ref: pr, context: pr })) }),
}))
vi.mock('../screenprs-cache', () => ({ getCacheEntryAt: (url: string, head: string) => (fakes.cache.get(url)?.headSha === head ? fakes.cache.get(url) : undefined) }))
vi.mock('../screenprs-drafts', () => ({
  loadDrafts: () => ({ drafts: fakes.drafts, rev: 1 }),
  draftThreadIds: () => fakes.linked,
  removeDraftsForThread: vi.fn((threadId: string) =>
    threadId === 'rt_discard1' ? [{ url: 'https://github.com/acme/app/pull/13', result: { draft: null, rev: 4 } }] : []
  ),
  moveThreadDraft: vi.fn(() => [
    { url: 'https://github.com/acme/app/pull/13', result: { draft: null, rev: 2 } },
    { url: 'https://github.com/acme/app/pull/12', result: { draft: null, rev: 3 } },
  ]),
}))
vi.mock('../review-findings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../review-findings')>()
  return { ...actual, materialiseFindings: vi.fn(actual.materialiseFindings) }
})

import { openDb, useDbForTests } from '../db'
import { postReviewLayer, deletePendingReview } from '../github/review-graphql'
import { importGithubReviewThreads } from '../github/review-threads'
import { moveThreadDraft } from '../screenprs-drafts'
import { materialiseFindings } from '../review-findings'
import {
  addMainReviewThread,
  applyReviewOp,
  createReview,
  getReview,
  getReviewThread,
  setReviewLayerHead,
  setReviewStatus,
  threadsForReview,
} from '../review-room-store'
import {
  ackHead,
  configureReviewRoom,
  discardReview,
  layerDiff,
  markStep,
  moveDraft,
  onDeepFindings,
  onOverviewText,
  onTriageCard,
  openReview,
  placeOnNewHead,
  resetReviewRoomForTests,
  shouldAutoClose,
  since,
  sinceDiff,
  submitReview,
} from '../review-room-service'

const U12 = 'https://github.com/acme/app/pull/12'
const U13 = 'https://github.com/acme/app/pull/13'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,5 @@
 context before
+const added = true
+const second = 2
 context after
 final context
`
/** The same code five lines lower, and `second` gone: what a push looks like. */
const PUSHED = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -15,3 +15,4 @@
 context before
+const added = true
 context after
 final context
`

function pr(url: string, number: number, head: string, base: string, extra: Record<string, unknown> = {}) {
  gh.prs.set(url, {
    url,
    number,
    title: `PR ${number}`,
    author: { login: 'alice' },
    isDraft: false,
    state: 'OPEN',
    baseRefName: base,
    baseRefOid: `${base}-oid`,
    headRefName: `feat-${number}`,
    headRefOid: head,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    body: '',
    ...extra,
  })
}

const deps = {
  broadcastReview: vi.fn(),
  applyDraftOp: vi.fn((_url: string, _op: unknown) => ({ draft: null, rev: 1 })),
  broadcastDraft: vi.fn(),
  defaultCompanionAgent: vi.fn(() => ({ provider: 'claude', model: 'opus' })),
  endCompanion: vi.fn(),
  removeCheckouts: vi.fn(),
}

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
  gh.prs.clear()
  gh.compares.clear()
  gh.diffs.clear()
  gh.calls = []
  fakes.cache.clear()
  fakes.board = []
  fakes.drafts = {}
  fakes.linked = new Set()
  for (const fn of Object.values(deps)) fn.mockClear()
  vi.mocked(postReviewLayer).mockReset()
  vi.mocked(deletePendingReview).mockReset()
  vi.mocked(deletePendingReview).mockResolvedValue(undefined)
  vi.mocked(materialiseFindings).mockClear()
  vi.mocked(importGithubReviewThreads).mockClear()
  configureReviewRoom(deps)
  resetReviewRoomForTests()
  pr(U12, 12, 'head12', 'main')
  pr(U13, 13, 'head13', 'feat-12')
  gh.diffs.set(U12, DIFF)
})

function singleReview(id = 'r_aaaaaa'): void {
  createReview({ id, repo: 'github.com/acme/app', layers: [{ url: U12, number: 12, headSha: 'head12' }], companionAgent: { provider: 'claude', model: 'sonnet' } })
}

describe('review:open', () => {
  it('resolves the stack bottom → top and creates a review with the default companion agent', async () => {
    fakes.board = [{ url: U13, number: 13, headSha: 'head13', headRefName: 'feat-13', baseRefName: 'feat-12' }]
    const result = await openReview(U13)
    expect(result.layers.map((layer) => [layer.number, layer.headSha, layer.owner, layer.repo])).toEqual([
      [12, 'head12', 'acme', 'app'],
      [13, 'head13', 'acme', 'app'],
    ])
    const review = getReview(result.reviewId)!
    expect(review.layers.map((layer) => layer.url)).toEqual([U12, U13])
    expect(review.companionAgent).toEqual({ provider: 'claude', model: 'opus' })
    expect(review.repo).toBe('github.com/acme/app')
  })

  it('reuses the open review that already holds the PR', async () => {
    const first = await openReview(U12)
    const second = await openReview(`${U12}/`)
    expect(second.reviewId).toBe(first.reviewId)
  })

  it('refuses a url that is not a PR', async () => {
    await expect(openReview('--repo=x')).rejects.toThrow('Not a pull-request URL')
  })

  it('records a pushed head and re-places its line threads, outdating the ones it cannot place', async () => {
    singleReview()
    const line = (snippet: string, startLine: number) => ({
      kind: 'line' as const, pr: 12, headSha: 'head12', path: 'src/a.ts', side: 'RIGHT' as const,
      startLine, endLine: startLine, snippet, before: 'context before', after: '',
    })
    applyReviewOp('r_aaaaaa', { kind: 'add-thread', thread: { id: 'rt_kept01', anchor: line('const added = true', 11) } })
    applyReviewOp('r_aaaaaa', { kind: 'add-thread', thread: { id: 'rt_gone01', anchor: line('const second = 2', 12) } })
    pr(U12, 12, 'head12b', 'main')
    gh.diffs.set(U12, PUSHED)

    await openReview(U12)
    expect(getReview('r_aaaaaa')!.layers[0]!.headSha).toBe('head12b')
    await vi.waitFor(() => expect(getReviewThread('rt_gone01')?.outdated).toBe(true))
    expect(getReviewThread('rt_kept01')).toMatchObject({ outdated: false, anchor: { headSha: 'head12b', startLine: 16, endLine: 16 } })
    expect(getReviewThread('rt_gone01')?.anchor).toMatchObject({ headSha: 'head12', startLine: 12 })
  })

  it('imports GitHub threads and materialises cached results for the layer in the background', async () => {
    fakes.cache.set(U12, {
      headSha: 'head12',
      baseKey: 'default:main',
      diff: DIFF,
      triage: { impact: 'low', findings: [{ label: 'issue', file: 'src/a.ts', line: '11', title: 'Flag is always true' }] },
    })
    const { reviewId } = await openReview(U12)
    await vi.waitFor(() => expect(threadsForReview(reviewId)).toHaveLength(1))
    expect(importGithubReviewThreads).toHaveBeenCalledWith(reviewId, expect.objectContaining({ url: U12 }), DIFF, false)
    expect(threadsForReview(reviewId)[0]!.origin).toMatchObject({ kind: 'finding', source: 'triage', severity: 'consider' })
  })

  it('discards an open review whose PRs all merged while it was open, and starts a new one', async () => {
    singleReview()
    pr(U12, 12, 'head12', 'main', { state: 'MERGED', closedAt: '2999-01-01T00:00:00Z' })
    const { reviewId } = await openReview(U12)
    expect(getReview('r_aaaaaa')!.status).toBe('discarded')
    expect(reviewId).not.toBe('r_aaaaaa')
    expect(getReview(reviewId)!.status).toBe('open')
  })
})

describe('shouldAutoClose', () => {
  const review = { createdAt: '2026-10-01T00:00:00Z', submissions: [] } as unknown as Parameters<typeof shouldAutoClose>[0]
  it('closes only when every PR closed after the review started and nothing was posted', () => {
    expect(shouldAutoClose(review, [{ state: 'MERGED', closedAt: '2026-10-02T00:00:00Z' }])).toBe(true)
    expect(shouldAutoClose(review, [{ state: 'MERGED', closedAt: '2026-09-01T00:00:00Z' }])).toBe(false)
    expect(shouldAutoClose(review, [{ state: 'MERGED', closedAt: '2026-10-02T00:00:00Z' }, { state: 'OPEN' }])).toBe(false)
    const posted = { ...review, submissions: [{ layers: [{ state: 'posted' }] }] } as unknown as typeof review
    expect(shouldAutoClose(posted, [{ state: 'CLOSED', closedAt: '2026-10-02T00:00:00Z' }])).toBe(false)
  })
})

describe('placeOnNewHead', () => {
  it('never matches across the gap between two hunks', () => {
    const anchor = {
      kind: 'line' as const, pr: 12, headSha: 'h', path: 'src/a.ts', side: 'RIGHT' as const,
      startLine: 11, endLine: 11, snippet: '}', before: '', after: '',
    }
    expect(placeOnNewHead(anchor, PUSHED, 'h2')).toBeNull()
    expect(placeOnNewHead({ ...anchor, path: 'other.ts' }, PUSHED, 'h2')).toBeNull()
  })
})

describe('findings from each run', () => {
  it('materialise only into open reviews holding the layer at that head', () => {
    singleReview('r_aaaaaa')
    singleReview('r_bbbbbb')
    setReviewStatus('r_bbbbbb', 'discarded')
    onTriageCard({ url: U12, headSha: 'other', diff: DIFF, findings: [{ label: 'issue', file: 'src/a.ts', line: '11', title: 'x' }] })
    expect(materialiseFindings).not.toHaveBeenCalled()

    onTriageCard({ url: U12, headSha: 'head12', diff: DIFF, findings: [{ label: 'nitpick', file: 'src/a.ts', line: '11', title: 'Name' }] })
    expect(vi.mocked(materialiseFindings).mock.calls.map(([input]) => input.reviewId)).toEqual(['r_aaaaaa'])
    expect(threadsForReview('r_bbbbbb')).toHaveLength(0)
    expect(threadsForReview('r_aaaaaa')[0]!.origin).toMatchObject({ source: 'triage', severity: 'nit' })
    expect(deps.broadcastReview).toHaveBeenCalled()
  })

  it('maps deep findings with their lens and severity', () => {
    singleReview()
    onDeepFindings({
      url: U12, headSha: 'head12', diff: DIFF,
      findings: [{ lens: 'soundness', severity: 'blocking', file: 'src/a.ts', line: '11', title: 'Wrong', detail: 'Because' }],
    })
    const [thread] = threadsForReview('r_aaaaaa')
    expect(thread!.origin).toMatchObject({ source: 'deep', severity: 'blocking', lens: 'soundness' })
    expect(thread!.messages[0]!.body).toBe('Wrong\n\nBecause')
  })

  it('turns overview Look-into items with refs into threads, and only those', () => {
    singleReview()
    const text = [
      '## What changed', 'x', '## Why', 'y', '## Impact', 'z', '## Look into',
      '1. Is the flag ever false? `a.ts:11`', '2. A question with no citation',
    ].join('\n')
    onOverviewText({ url: U12, headSha: 'head12', diff: DIFF, text })
    const threads = threadsForReview('r_aaaaaa')
    expect(threads).toHaveLength(1)
    expect(threads[0]!.origin).toMatchObject({ source: 'overview', preExisting: false })
    expect(threads[0]!.origin).not.toHaveProperty('severity')
    expect(threads[0]!.anchor).toMatchObject({ kind: 'line', path: 'src/a.ts', startLine: 11 })
    // The same item again is the same thread.
    onOverviewText({ url: U12, headSha: 'head12', diff: DIFF, text })
    expect(threadsForReview('r_aaaaaa')).toHaveLength(1)
  })

  it('never throws into the run that reported', () => {
    singleReview()
    vi.mocked(materialiseFindings).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(() => onTriageCard({ url: U12, headSha: 'head12', diff: DIFF, findings: [] })).not.toThrow()
  })
})

describe('review:layer-diff', () => {
  it('serves the cached diff when head and base key match', async () => {
    singleReview()
    fakes.cache.set(U12, { headSha: 'head12', baseKey: 'default:main', diff: 'cached', base: { kind: 'default' }, triage: { impact: 'low', findings: [] } })
    await expect(layerDiff('r_aaaaaa', U12)).resolves.toEqual({ url: U12, headSha: 'head12', diff: 'cached', base: { kind: 'default' } })
  })

  it('refuses a head the review does not record', async () => {
    singleReview()
    pr(U12, 12, 'moved', 'main')
    await expect(layerDiff('r_aaaaaa', U12)).rejects.toThrow('head changed')
  })
})

describe('§8 return visits', () => {
  const path = (from: string, to: string) => `repos/acme/app/compare/${from}...${to}`

  it('is a first visit once, then compares the last seen head with the head', async () => {
    singleReview()
    await expect(since('r_aaaaaa', U12)).resolves.toEqual({ kind: 'first-visit' })
    expect(getReview('r_aaaaaa')!.lastSeenHead).toEqual({ [U12]: 'head12' })
    await expect(since('r_aaaaaa', U12)).resolves.toEqual({ kind: 'identical' })

    setReviewLayerHead('r_aaaaaa', 12, 'head12b')
    gh.compares.set(path('head12', 'head12b'), { status: 'ahead', ahead_by: 2, commits: [{ parents: [{}] }, { parents: [{}] }] })
    await expect(since('r_aaaaaa', U12)).resolves.toEqual({ kind: 'ahead', aheadBy: 2, from: 'head12', to: 'head12b' })
    gh.diffs.set(path('head12', 'head12b'), 'the new commits')
    await expect(sinceDiff('r_aaaaaa', U12)).resolves.toBe('the new commits')

    ackHead('r_aaaaaa', U12)
    expect(getReview('r_aaaaaa')!.lastSeenHead[U12]).toBe('head12b')
    await expect(since('r_aaaaaa', U12)).resolves.toEqual({ kind: 'identical' })
  })

  it('reads behind, diverged, a 404 and a failure', async () => {
    singleReview()
    await since('r_aaaaaa', U12)
    setReviewLayerHead('r_aaaaaa', 12, 'head12b')
    const p = path('head12', 'head12b')
    gh.compares.set(p, { status: 'behind', behind_by: 1 })
    await expect(since('r_aaaaaa', U12)).resolves.toMatchObject({ kind: 'behind' })
    gh.compares.set(p, { status: 'diverged', ahead_by: 1, behind_by: 1 })
    await expect(since('r_aaaaaa', U12)).resolves.toMatchObject({ kind: 'rewritten' })
    gh.compares.set(p, new Error('gh api exited 1: Not Found (HTTP 404)'))
    await expect(since('r_aaaaaa', U12)).resolves.toMatchObject({ kind: 'rewritten' })
    gh.compares.set(p, new Error('gh api exited 1: HTTP 502'))
    await expect(since('r_aaaaaa', U12)).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('shows no interdiff when the base was merged in', async () => {
    singleReview()
    await since('r_aaaaaa', U12)
    setReviewLayerHead('r_aaaaaa', 12, 'head12b')
    gh.compares.set(path('head12', 'head12b'), { status: 'ahead', ahead_by: 2, commits: [{ parents: [{}] }, { parents: [{}, {}] }] })
    await expect(sinceDiff('r_aaaaaa', U12)).resolves.toBe('')
  })

  it('validates mark-step', () => {
    singleReview()
    markStep('r_aaaaaa', 'step-1', true)
    expect(getReview('r_aaaaaa')!.readSteps).toEqual(['step-1'])
    expect(() => markStep('r_aaaaaa', 'step-1', 'yes')).toThrow()
    expect(() => markStep('r_aaaaaa', 'a\nb', true)).toThrow()
    expect(() => markStep('nope', 'step', true)).toThrow()
  })
})

describe('review:move-draft', () => {
  it('broadcasts every draft the move touched', () => {
    moveDraft('rt_aaaaaa', U13)
    expect(moveThreadDraft).toHaveBeenCalledWith('rt_aaaaaa', U13)
    expect(deps.broadcastDraft.mock.calls.map(([url]) => url)).toEqual([U13, U12])
    expect(() => moveDraft('nope', U13)).toThrow()
  })
})

function stackReview(): void {
  createReview({
    id: 'r_aaaaaa',
    repo: 'github.com/acme/app',
    layers: [{ url: U12, number: 12, headSha: 'head12' }, { url: U13, number: 13, headSha: 'head13' }],
    companionAgent: { provider: 'claude', model: 'sonnet' },
  })
  addMainReviewThread({ id: 'rt_thread12', reviewId: 'r_aaaaaa', anchor: { kind: 'pr', pr: 12 }, origin: { kind: 'user' }, author: 'user', body: 'q' })
  addMainReviewThread({ id: 'rt_thread13', reviewId: 'r_aaaaaa', anchor: { kind: 'pr', pr: 13 }, origin: { kind: 'user' }, author: 'user', body: 'q' })
  fakes.cache.set(U12, { headSha: 'head12', baseKey: 'default:main', diff: DIFF, base: { kind: 'default' }, triage: { impact: 'low', findings: [] } })
  fakes.cache.set(U13, { headSha: 'head13', baseKey: 'stacked:feat-12-oid', diff: DIFF, base: { kind: 'polluted', isolated: true, foreign: 1, behindBy: 0, own: [] }, triage: { impact: 'low', findings: [] } })
}

const comment = (id: string, threadId?: string): PrReviewComment => ({ id, source: 'you', file: '', text: id, ...(threadId ? { threadId } : {}) })

describe('review:submit', () => {
  it('posts each layer bottom → top, records progress, and clears a draft only after its layer posted', async () => {
    stackReview()
    fakes.drafts = {
      [U12]: { comments: [comment('c12', 'rt_thread12'), comment('stray')], summary: 'S12', verdict: 'comment' },
      [U13]: { comments: [comment('c13', 'rt_thread13')], summary: '', verdict: 'approve' },
    }
    const seen: ReviewLayerSubmission[][] = []
    vi.mocked(postReviewLayer).mockImplementation(async (input) => {
      const pending: ReviewLayerSubmission = { prUrl: input.pr.url, verdict: input.verdict, postedCommentIds: [], state: 'pending', reviewNodeId: `node-${input.pr.number}` }
      input.record(pending)
      seen.push(getReview('r_aaaaaa')!.submissions.at(-1)!.layers)
      if (input.pr.number === 13) {
        const failed = { ...pending, state: 'failed' as const }
        input.record(failed)
        return { outcome: { prUrl: input.pr.url, kind: 'failed', error: 'nope' }, state: failed }
      }
      const posted = { ...pending, state: 'posted' as const, postedCommentIds: ['c12'] }
      input.record(posted)
      return { outcome: { prUrl: input.pr.url, kind: 'posted', folded: 0 }, state: posted }
    })

    const result = await submitReview({ reviewId: 'r_aaaaaa', layers: [{ prUrl: U13, verdict: 'approve' }, { prUrl: U12, verdict: 'comment' }] })
    expect(result.complete).toBe(false)
    expect(result.layers.map((layer) => layer.kind)).toEqual(['posted', 'failed'])

    const calls = vi.mocked(postReviewLayer).mock.calls.map(([input]) => input)
    expect(calls.map((input) => input.pr.number)).toEqual([12, 13])
    expect(calls[0]!.draft.comments.map((c) => c.id)).toEqual(['c12'])
    expect(calls[0]).toMatchObject({ readHead: 'head12', isolatedBase: false, verdict: 'comment' })
    expect(calls[1]).toMatchObject({ readHead: 'head13', isolatedBase: true })
    expect(seen[0]![0]).toMatchObject({ state: 'pending', reviewNodeId: 'node-12' })

    expect(deps.applyDraftOp).toHaveBeenCalledTimes(1)
    expect(deps.applyDraftOp).toHaveBeenCalledWith(U12, { kind: 'clear-posted', ids: ['c12'], summary: 'S12', verdict: 'comment' })
    const review = getReview('r_aaaaaa')!
    expect(review.status).toBe('open')
    expect(review.submissions).toHaveLength(1)
    expect(review.submissions[0]!.layers.map((layer) => layer.state)).toEqual(['posted', 'failed'])
    expect(deps.endCompanion).not.toHaveBeenCalled()
  })

  it('retries with the last attempt’s state as prior and completes the review', async () => {
    stackReview()
    setReviewStatus('r_aaaaaa', 'open', [{
      at: '2026-10-16T00:00:00Z',
      destination: { session: false, github: true },
      layers: [
        { prUrl: U12, verdict: 'comment', postedCommentIds: ['c12'], state: 'posted', reviewNodeId: 'node-12' },
        { prUrl: U13, verdict: 'approve', postedCommentIds: [], state: 'unknown', reviewNodeId: 'node-13' },
      ],
    }])
    vi.mocked(postReviewLayer).mockImplementation(async (input) => {
      const state = { ...input.prior!, state: 'posted' as const }
      return { outcome: { prUrl: input.pr.url, kind: 'posted', folded: 0 }, state }
    })
    const result = await submitReview({ reviewId: 'r_aaaaaa', layers: [{ prUrl: U12, verdict: 'comment' }, { prUrl: U13, verdict: 'approve' }] })
    expect(result.complete).toBe(true)
    expect(vi.mocked(postReviewLayer).mock.calls.map(([input]) => input.prior?.reviewNodeId)).toEqual(['node-12', 'node-13'])
    // The first layer was cleared by the attempt that posted it.
    expect(deps.applyDraftOp.mock.calls.map(([url]) => url)).toEqual([U13])
    const review = getReview('r_aaaaaa')!
    expect(review.status).toBe('submitted')
    expect(review.submissions).toHaveLength(2)
    expect(deps.endCompanion).toHaveBeenCalledWith('r_aaaaaa')
    expect(deps.removeCheckouts).toHaveBeenCalledWith('r_aaaaaa')
  })

  it("removes the drafts of the review's threads", async () => {
    stackReview()
    addMainReviewThread({ id: 'rt_discard1', reviewId: 'r_aaaaaa', anchor: { kind: 'pr', pr: 13 }, origin: { kind: 'user' }, author: 'user', body: 'q' })
    await discardReview('r_aaaaaa')
    expect(deps.broadcastDraft).toHaveBeenCalledWith('https://github.com/acme/app/pull/13', { draft: null, rev: 4 })
  })

  it('counts a layer left out as skipped', async () => {
    stackReview()
    vi.mocked(postReviewLayer).mockImplementation(async (input) => {
      const state = { prUrl: input.pr.url, verdict: input.verdict, postedCommentIds: [], state: 'posted' as const }
      return { outcome: { prUrl: input.pr.url, kind: 'posted', folded: 0 }, state }
    })
    const result = await submitReview({ reviewId: 'r_aaaaaa', layers: [{ prUrl: U13, verdict: 'approve' }] })
    expect(result).toEqual({ complete: true, layers: [{ prUrl: U12, kind: 'skipped' }, { prUrl: U13, kind: 'posted', folded: 0 }] })
  })

  it.each([
    { reviewId: 'r_aaaaaa', layers: [] },
    { reviewId: 'r_aaaaaa', layers: [{ prUrl: U12, verdict: 'lgtm' }] },
    { reviewId: 'r_aaaaaa', layers: [{ prUrl: U12, verdict: 'approve' }, { prUrl: U12, verdict: 'approve' }] },
    { reviewId: 'r_aaaaaa', layers: [{ prUrl: U12, verdict: 'approve', adoptPendingReviewId: '--flag x' }] },
    { reviewId: 'r_aaaaaa', layers: [{ prUrl: 'https://github.com/acme/app/pull/99', verdict: 'approve' }] },
  ])('refuses a malformed request %#', async (request) => {
    stackReview()
    await expect(submitReview(request)).rejects.toThrow()
    expect(postReviewLayer).not.toHaveBeenCalled()
  })
})

describe('review:discard', () => {
  it('deletes the pending reviews SimpleEdit left, then ends the review', async () => {
    stackReview()
    setReviewStatus('r_aaaaaa', 'open', [{
      at: '2026-10-16T00:00:00Z',
      destination: { session: false, github: true },
      layers: [
        { prUrl: U12, verdict: 'comment', postedCommentIds: [], state: 'posted', reviewNodeId: 'node-12' },
        { prUrl: U13, verdict: 'approve', postedCommentIds: [], state: 'failed', reviewNodeId: 'node-13' },
      ],
    }])
    await discardReview('r_aaaaaa')
    expect(vi.mocked(deletePendingReview).mock.calls).toEqual([['node-13']])
    expect(getReview('r_aaaaaa')!.status).toBe('discarded')
    expect(deps.endCompanion).toHaveBeenCalledWith('r_aaaaaa')
    expect(deps.removeCheckouts).toHaveBeenCalledWith('r_aaaaaa')
  })

  it('stays open when a pending review cannot be deleted', async () => {
    stackReview()
    setReviewStatus('r_aaaaaa', 'open', [{
      at: '2026-10-16T00:00:00Z',
      destination: { session: false, github: true },
      layers: [{ prUrl: U13, verdict: 'approve', postedCommentIds: [], state: 'unknown', reviewNodeId: 'node-13' }],
    }])
    vi.mocked(deletePendingReview).mockRejectedValueOnce(new Error('HTTP 502'))
    await expect(discardReview('r_aaaaaa')).rejects.toThrow('pending review')
    expect(getReview('r_aaaaaa')!.status).toBe('open')
  })
})
