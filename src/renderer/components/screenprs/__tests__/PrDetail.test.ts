import { render, screen } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import PrDetail from '../PrDetail.svelte'
import type { BaseAnalysis, PrContext } from '../../../../shared/screenprs'

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

beforeEach(() => {
  vi.stubGlobal('api', { invoke: vi.fn(async () => []), on: () => () => {} })
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
        source: 'overview',
        file: 'packages/ui/src/Table/body.tsx',
        line: '41',
        text: 'question: Is the overscan right? `Table/body.tsx:41`',
        sha: 'sha9',
      },
    ])
  })
})
