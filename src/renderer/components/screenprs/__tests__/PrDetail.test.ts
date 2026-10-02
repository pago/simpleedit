import { render, screen } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import PrDetail from '../PrDetail.svelte'
import type { BaseAnalysis, PrContext, PrReviewDraft } from '../../../../shared/screenprs'
import { applyDraftOp, type PrReviewDraftOp } from '../../../../shared/review-drafts'

const CONTEXT: PrContext = {
  owner: 'ivx', repo: 'ui-pack', number: 2532, url: 'https://github.com/ivx/ui-pack/pull/2532',
  title: 'Virtualize the Table', author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
  headSha: 'own-2', additions: 1, deletions: 0, changedFiles: 1,
  baseRefName: 'compact-density', headRefName: 'table-virtualization', ci: 'green', ciFailing: [],
  reviewers: [], approvedByOther: false, body: '', diff: '',
}
const POLLUTED: BaseAnalysis = {
  kind: 'polluted', basePr: 2531, foreign: 1, behindBy: 199, isolated: true,
  own: [{ sha: 'own-1', subject: 'Improve Timeline' }, { sha: 'own-2', subject: 'Virtualize rows' }],
}

// Never reset: the store is a module singleton and ignores revisions older than one it has seen.
let mainRev = 0

beforeEach(() => {
  const mainDrafts = new Map<string, PrReviewDraft>()
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'screenprs:drafts-load') return { drafts: {}, rev: ++mainRev }
    if (channel === 'screenprs:draft-op') {
      const { url, op } = args[0] as { url: string; op: PrReviewDraftOp }
      const draft = applyDraftOp(mainDrafts.get(url) ?? null, op)
      if (draft) mainDrafts.set(url, draft)
      else mainDrafts.delete(url)
      return { draft, rev: ++mainRev }
    }
    return []
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })
})

describe('desktop PR detail — base warning', () => {
  it('warns above the diff when GitHub’s diff carries a lower layer', () => {
    const base = { ...POLLUTED, github: { additions: 900, deletions: 40, changedFiles: 69 } }
    render(PrDetail, { props: { context: { ...CONTEXT, changedFiles: 52, base } } })
    expect(screen.getByTestId('base-warning')).toHaveTextContent(
      "Misleading diff on GitHub: includes 1 commit from #2531 (base rebased, behind by 199). GitHub shows 69 files; this PR's own 2 commits touch 52. Showing only those."
    )
  })

  it('says nothing for a clean stack', () => {
    render(PrDetail, { props: { context: { ...CONTEXT, base: { kind: 'clean' } } } })
    expect(screen.queryByTestId('base-warning')).toBeNull()
  })
})

describe('desktop PR detail — overview', () => {
  const URL_ = 'https://github.com/ivx/ui-pack/pull/2600'
  const DIFF = [
    'diff --git a/packages/ui/src/Table/body.tsx b/packages/ui/src/Table/body.tsx',
    '--- a/packages/ui/src/Table/body.tsx',
    '+++ b/packages/ui/src/Table/body.tsx',
    '@@ -40,2 +40,3 @@',
    ' const a = 1',
    '+const overscan = 4',
    ' const b = 2',
  ].join('\n')
  const TEXT = '## What changed\nA\n## Why\nB\n## Impact\nC\n## Look into\n1. Is the overscan right? `Table/body.tsx:41`'
  const ctx: PrContext = { ...CONTEXT, url: URL_, number: 2600, diff: DIFF, headSha: 'sha9' }
  const CARD = { ...ctx, impact: 'low' as const, findings: [{ label: 'issue' as const, file: 'a.ts', title: 'bug' }], bucket: 'quick' as const }

  beforeEach(async () => {
    const { screenPrsStore } = await import('../../../stores/screenprs.svelte')
    screenPrsStore._onOverviewStatus(URL_, 'idle')
    screenPrsStore.resetSubmitted(URL_)
  })

  async function withOverview(): Promise<typeof import('../../../stores/screenprs.svelte').screenPrsStore> {
    const { screenPrsStore } = await import('../../../stores/screenprs.svelte')
    screenPrsStore._onOverviewResult(URL_, 'sha9', TEXT, { draft: false, changeset: 'no' })
    screenPrsStore._onOverviewStatus(URL_, 'done')
    return screenPrsStore
  }

  it('starts an overview with the full context from the header button', async () => {
    render(PrDetail, { props: { context: ctx, card: CARD } })
    screen.getByTestId('run-overview').click()
    const invoke = (window.api.invoke as ReturnType<typeof vi.fn>).mock.calls
    await vi.waitFor(() => expect(invoke.some(([ch]) => ch === 'screenprs:overview-start')).toBe(true))
    expect(invoke.find(([ch]) => ch === 'screenprs:overview-start')?.[1]).toMatchObject({ url: URL_, diff: DIFF })
  })

  it('puts the card above triage, below the base warning, and collapses triage', async () => {
    await withOverview()
    const polluted = { ...ctx, base: { ...POLLUTED, isolated: false } }
    render(PrDetail, { props: { context: polluted, card: { ...CARD, ...polluted } } })
    const card = screen.getByTestId('overview-card')
    const warning = screen.getByTestId('base-warning')
    expect(warning.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText(/superseded by the overview/)).toBeInTheDocument()
    expect(screen.queryByText('bug')).toBeNull()
  })

  it('jumps a citation to its row in the diff, even from a shortened path', async () => {
    await withOverview()
    const scrolled: Element[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this)
    })
    const { container } = render(PrDetail, { props: { context: ctx, card: CARD } })
    screen.getByTestId('overview-ref').click()
    await vi.waitFor(() => expect(container.querySelector('[data-revealed]')).toHaveTextContent('const overscan = 4'))
    expect(scrolled).toEqual([container.querySelector('[data-revealed]')])
    vi.restoreAllMocks()
  })

  it('＋ review adds a question anchored to the first citation, at the diff’s full path', async () => {
    const store = await withOverview()
    render(PrDetail, { props: { context: ctx, card: CARD } })
    screen.getByTestId('overview-add-review').click()
    expect(store.draftFor(URL_).comments).toEqual([
      {
        id: expect.any(String),
        source: 'overview',
        file: 'packages/ui/src/Table/body.tsx',
        line: '41',
        text: 'question: Is the overscan right? `Table/body.tsx:41`',
        sha: 'sha9',
      },
    ])
  })
})

describe('desktop PR detail — anchoring a review to the head', () => {
  const URL_ = 'https://github.com/ivx/ui-pack/pull/2700'
  const ctx: PrContext = { ...CONTEXT, url: URL_, number: 2700, headSha: 'head-new' }
  const CARD = {
    ...ctx,
    impact: 'low' as const,
    findings: [{ label: 'issue' as const, file: 'a.ts', line: '3', title: 'bug' }],
    bucket: 'quick' as const,
  }
  const FINDING = { lens: 'soundness' as const, severity: 'concern' as const, file: 'b.ts', line: '9', title: 'race', detail: '' }

  async function store(): Promise<typeof import('../../../stores/screenprs.svelte').screenPrsStore> {
    const { screenPrsStore } = await import('../../../stores/screenprs.svelte')
    screenPrsStore.resetSubmitted(URL_)
    screenPrsStore._onDeepStatus(URL_, 'idle')
    return screenPrsStore
  }

  function submits(): unknown[] {
    return (window.api.invoke as ReturnType<typeof vi.fn>).mock.calls
      .filter(([ch]) => ch === 'screenprs:submit-review')
      .map(([, req]) => req)
  }

  it('stamps a triage finding with its card’s head and a deep finding with the head the lenses ran on', async () => {
    const s = await store()
    render(PrDetail, { props: { context: ctx, card: CARD } })
    screen.getByTestId('add-triage').click()
    // A finished deep review collapses triage, so it arrives second.
    s.startDeep({ ...ctx, headSha: 'head-old' })
    s._onDeepResult(URL_, [FINDING], 'head-old')
    s._onDeepStatus(URL_, 'done')
    ;(await screen.findByTestId('add-deep')).click()
    expect(s.draftFor(URL_).comments.map((c) => [c.source, c.sha])).toEqual([['triage', 'head-new'], ['deep', 'head-old']])
  })

  it('counts the moved anchor in the confirm and sends the raw draft with the head to main', async () => {
    const s = await store()
    s.addComment(URL_, { source: 'you', file: 'a.ts', line: '3', text: 'old', sha: 'head-old' })
    s.addComment(URL_, { source: 'you', file: 'a.ts', line: '4', text: 'new', sha: 'head-new' })
    const isolated = { ...ctx, base: POLLUTED }
    render(PrDetail, { props: { context: isolated, card: { ...CARD, ...isolated } } })
    screen.getByText('📝 Review to post').click()
    ;(await screen.findByText(/on GitHub →/)).click()
    expect(await screen.findByTestId('confirm-moved')).toHaveTextContent('1 written against an earlier commit')
    expect(screen.getByTestId('confirm-folded')).toHaveTextContent('1 folded into the summary')
    screen.getByText('Post approve on GitHub').click()
    await vi.waitFor(() => expect(submits()).toHaveLength(1))
    expect(submits()[0]).toMatchObject({
      headSha: 'head-new',
      isolatedBase: true,
      draft: { comments: [{ line: '3', sha: 'head-old' }, { line: '4', sha: 'head-new' }] },
    })
  })

  it('says after posting which comments went into the summary, and why', async () => {
    const s = await store()
    s.addComment(URL_, { source: 'you', file: 'a.ts', line: '3', text: 'x', sha: 'head-new' })
    const invoke = window.api.invoke as unknown as Mock<(ch: string, ...args: unknown[]) => Promise<unknown>>
    const fallback = invoke.getMockImplementation()
    invoke.mockImplementation(async (ch: string, ...args: unknown[]) =>
      ch === 'screenprs:submit-review'
        ? { ok: true, folded: { count: 2, reasons: { 'not-in-diff': 1, moved: 1 } } }
        : fallback?.(ch, ...args)
    )
    render(PrDetail, { props: { context: ctx, card: CARD } })
    screen.getByText('📝 Review to post').click()
    ;(await screen.findByText(/on GitHub →/)).click()
    ;(await screen.findByText('Post approve on GitHub')).click()
    expect(await screen.findByTestId('review-folded')).toHaveTextContent(
      '2 comments folded into the summary: 1 outside GitHub’s diff, 1 written before the branch moved'
    )
  })
})
