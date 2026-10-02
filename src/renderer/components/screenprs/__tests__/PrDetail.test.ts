import { render, screen, fireEvent, within } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import PrDetail, { _resetInlineEditors } from '../PrDetail.svelte'
import { _resetListEditors } from '../ReviewComposer.svelte'
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
    await screenPrsStore.loadDrafts() // main holds none: the mirror empties
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
    await screenPrsStore.loadDrafts() // main holds none: the mirror empties
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
      clearDraft: true,
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

describe('desktop PR detail — inline comments', () => {
  const URL_ = 'https://github.com/ivx/ui-pack/pull/2800'
  const DIFF = [
    'diff --git a/src/x.ts b/src/x.ts',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -10,3 +10,3 @@',
    ' const a = 1',
    '-const gone = 2',
    '+const b = 2',
    ' const c = 3',
  ].join('\n')
  const ctx: PrContext = { ...CONTEXT, url: URL_, number: 2800, diff: DIFF, headSha: 'head-x' }

  async function store(): Promise<typeof import('../../../stores/screenprs.svelte').screenPrsStore> {
    const { screenPrsStore } = await import('../../../stores/screenprs.svelte')
    screenPrsStore.resetSubmitted(URL_)
    await screenPrsStore.loadDrafts() // main holds none: the mirror empties
    _resetInlineEditors()
    _resetListEditors()
    for (const c of screenPrsStore.draftFor(URL_).comments) screenPrsStore.removeComment(URL_, c.id)
    return screenPrsStore
  }

  // Row order in DIFF: ctx 10/10, del 11/–, add –/11, ctx 12/12.
  const plus = (i: number): HTMLElement => screen.getAllByTestId('diff-line-comment')[i]
  const field = (): HTMLTextAreaElement => screen.getByLabelText('Comment text')

  it('＋ opens a focused editor under the row and adds a “you” comment with side, snippet and head', async () => {
    const s = await store()
    render(PrDetail, { props: { context: ctx } })
    await fireEvent.click(plus(2))
    expect(field()).toHaveFocus()
    expect(screen.getByText('Comment on line 11')).toBeInTheDocument()
    await fireEvent.input(field(), { target: { value: 'nit: name' } })
    screen.getByText('Add comment').click()
    expect(s.draftFor(URL_).comments).toEqual([
      { id: expect.any(String), source: 'you', file: 'src/x.ts', line: '11', side: 'RIGHT', snippet: 'const b = 2', text: 'nit: name', sha: 'head-x' },
    ])
    await vi.waitFor(() => expect(screen.queryByTestId('inline-comment-editor')).toBeNull())
    expect(screen.getByTestId('inline-comment')).toHaveTextContent('nit: name')
  })

  it('anchors a deleted row to its old number on LEFT', async () => {
    const s = await store()
    render(PrDetail, { props: { context: ctx } })
    await fireEvent.click(plus(1))
    expect(screen.getByText('Comment on deleted line 11')).toBeInTheDocument()
    await fireEvent.input(field(), { target: { value: 'why?' } })
    await fireEvent.keyDown(field(), { key: 'Enter', metaKey: true })
    expect(s.draftFor(URL_).comments[0]).toMatchObject({ line: '11', side: 'LEFT', snippet: 'const gone = 2' })
  })

  it('shift-click extends to a range on the same side, keeping the text; a different side restarts', async () => {
    const s = await store()
    const { container } = render(PrDetail, { props: { context: ctx } })
    await fireEvent.click(plus(0))
    await fireEvent.input(field(), { target: { value: 'span' } })
    await fireEvent.click(plus(3), { shiftKey: true })
    expect(screen.getByText('Comment on lines 10–12')).toBeInTheDocument()
    expect(field().value).toBe('span')
    expect(container.querySelectorAll('[data-selected]')).toHaveLength(3)
    screen.getByText('Add comment').click()
    expect(s.draftFor(URL_).comments[0]).toMatchObject({ line: '10-12', side: 'RIGHT', snippet: 'const a = 1\nconst b = 2\nconst c = 3' })

    await fireEvent.click(plus(0))
    await fireEvent.click(plus(1), { shiftKey: true })
    expect(screen.getByText('Comment on deleted line 11')).toBeInTheDocument()
  })

  it('Esc cancels an empty editor at once, but asks before discarding typed text', async () => {
    await store()
    render(PrDetail, { props: { context: ctx } })
    await fireEvent.click(plus(0))
    await fireEvent.keyDown(field(), { key: 'Escape' })
    expect(screen.queryByTestId('inline-comment-editor')).toBeNull()

    await fireEvent.click(plus(0))
    await fireEvent.input(field(), { target: { value: 'draft' } })
    await fireEvent.keyDown(field(), { key: 'Escape' })
    expect(screen.getByTestId('inline-comment-discard')).toHaveTextContent('Discard this comment?')
    screen.getByText('Keep editing').click()
    await vi.waitFor(() => expect(screen.queryByTestId('inline-comment-discard')).toBeNull())
    expect(field().value).toBe('draft')

    // Opening another editor asks too, and only switches once discarded.
    await fireEvent.click(plus(3))
    expect(screen.getByText('Comment on line 10')).toBeInTheDocument()
    ;(await screen.findByText('Discard')).click()
    await vi.waitFor(() => expect(screen.getByText('Comment on line 12')).toBeInTheDocument())
    expect(field().value).toBe('')
  })

  it('shows any anchored draft comment under its line; Edit saves through updateComment and ✕ removes', async () => {
    const s = await store()
    s.addComment(URL_, { source: 'deep', file: 'src/x.ts', line: '12', text: 'race here', sha: 'head-x' })
    s.addComment(URL_, { source: 'triage', file: 'src/x.ts', line: '99', text: 'off the diff', sha: 'head-x' })
    const update = vi.spyOn(s, 'updateComment')
    render(PrDetail, { props: { context: ctx } })
    const inline = screen.getByTestId('inline-comment')
    expect(inline).toHaveTextContent('deep')
    expect(inline).toHaveTextContent('race here')

    screen.getByRole('button', { name: 'Edit comment' }).click()
    await vi.waitFor(() => expect(field().value).toBe('race here'))
    expect(screen.queryByTestId('inline-comment')).toBeNull()
    await fireEvent.input(field(), { target: { value: 'race here, twice' } })
    screen.getByText('Save').click()
    const id = s.draftFor(URL_).comments[0].id
    expect(update).toHaveBeenCalledWith(URL_, id, { text: 'race here, twice' })
    expect(await screen.findByTestId('inline-comment')).toHaveTextContent('race here, twice')

    screen.getByRole('button', { name: 'Remove comment' }).click()
    await vi.waitFor(() => expect(screen.queryByTestId('inline-comment')).toBeNull())
    expect(s.draftFor(URL_).comments.map((c) => c.text)).toEqual(['off the diff'])
    update.mockRestore()
  })

  it('the composer list reveals a comment in the diff, marks deleted lines, and edits in place', async () => {
    const s = await store()
    s.addComment(URL_, { source: 'you', file: 'src/x.ts', line: '11', side: 'LEFT', text: 'gone?', sha: 'head-x' })
    s.addComment(URL_, { source: 'triage', file: 'src/x.ts', line: '99', text: 'off the diff', sha: 'head-x' })
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const { container } = render(PrDetail, { props: { context: ctx } })
    screen.getByText('📝 Review to post').click()
    const items = await screen.findAllByTestId('composer-comment')
    expect(items[0]).toHaveTextContent('· deleted line')
    expect(items[1]).not.toHaveTextContent('deleted line')
    // Off the diff: nothing to reveal.
    expect(within(items[1]).queryByRole('button', { name: /src\/x\.ts:99/ })).toBeNull()

    within(items[0]).getByText('src/x.ts:11').click()
    await vi.waitFor(() => expect(container.querySelector('[data-revealed]')).toHaveTextContent('const gone = 2'))

    within(items[0]).getByText('Edit').click()
    await vi.waitFor(() => expect(field().value).toBe('gone?'))
    expect(screen.getByText('Comment on deleted line 11')).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it('edits a comment whose line is not in the diff right in the composer list', async () => {
    const s = await store()
    s.addComment(URL_, { source: 'triage', file: 'src/x.ts', line: '99', text: 'off the diff', sha: 'head-x' })
    render(PrDetail, { props: { context: ctx } })
    screen.getByText('📝 Review to post').click()
    const item = (await screen.findAllByTestId('composer-comment'))[0]
    within(item).getByText('Edit').click()
    await vi.waitFor(() => expect(field().value).toBe('off the diff'))
    await fireEvent.input(field(), { target: { value: 'off the diff, reworded' } })
    await fireEvent.keyDown(field(), { key: 'Enter', metaKey: true })
    expect(s.draftFor(URL_).comments[0].text).toBe('off the diff, reworded')
    await vi.waitFor(() => expect(screen.queryByTestId('inline-comment-editor')).toBeNull())
  })

  it('keeps a comment from an earlier head out of the diff, editable in the list with a note', async () => {
    const s = await store()
    s.addComment(URL_, { source: 'you', file: 'src/x.ts', line: '12', text: 'read on the old head', sha: 'head-old' })
    render(PrDetail, { props: { context: ctx } })
    expect(screen.queryByTestId('inline-comment')).toBeNull()
    screen.getByText('📝 Review to post').click()
    const item = (await screen.findAllByTestId('composer-comment'))[0]
    expect(within(item).getByTestId('comment-earlier-commit')).toHaveTextContent('earlier commit')
    expect(within(item).queryByRole('button', { name: /src\/x\.ts:12/ })).toBeNull()
    within(item).getByText('Edit').click()
    await vi.waitFor(() => expect(field().value).toBe('read on the old head'))
    expect(screen.getByText('Edit comment')).toBeInTheDocument()
  })

  it('previews against GitHub’s diff: a line outside its hunks is shown folded', async () => {
    const s = await store()
    s.addComment(URL_, { source: 'you', file: 'src/x.ts', line: '12', text: 'in a hunk', sha: 'head-x' })
    s.addComment(URL_, { source: 'triage', file: 'src/x.ts', line: '99', text: 'outside', sha: 'head-x' })
    render(PrDetail, { props: { context: ctx } })
    screen.getByText('📝 Review to post').click()
    ;(await screen.findByText(/on GitHub →/)).click()
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('1 line comment anchored')
    expect(within(dialog).getByTestId('confirm-folded')).toHaveTextContent('1 folded')
    expect(within(dialog).queryByTestId('confirm-unchecked')).toBeNull()
  })

  it('previews an isolated stacked diff as it stands, saying lines are checked on submit', async () => {
    const s = await store()
    s.addComment(URL_, { source: 'triage', file: 'src/x.ts', line: '99', text: 'outside', sha: 'head-x' })
    render(PrDetail, { props: { context: { ...ctx, base: POLLUTED } } })
    screen.getByText('📝 Review to post').click()
    ;(await screen.findByText(/on GitHub →/)).click()
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('1 line comment anchored')
    expect(within(dialog).getByTestId('confirm-unchecked')).toHaveTextContent('checked against GitHub’s diff when this posts')
  })

  it('says so when main refuses a change, until dismissed', async () => {
    const s = await store()
    const invoke = window.api.invoke as Mock
    const answer = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'screenprs:draft-op') throw new Error('disk full')
      return answer(channel, ...args)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(PrDetail, { props: { context: ctx } })
    s.addComment(URL_, { source: 'you', file: 'src/x.ts', line: '12', text: 'lost', sha: 'head-x' })
    expect(await screen.findByTestId('draft-notice')).toHaveTextContent("couldn't be saved")
    expect(s.draftFor(URL_).comments).toEqual([])
    within(screen.getByTestId('draft-notice')).getByTitle('Dismiss').click()
    await vi.waitFor(() => expect(screen.queryByTestId('draft-notice')).toBeNull())
    vi.restoreAllMocks()
  })

  it('keeps each PR’s half-written comment across switching PRs, and one PR’s editor never touches another’s', async () => {
    await store()
    const other: PrContext = { ...ctx, url: 'https://github.com/ivx/ui-pack/pull/2801', number: 2801 }
    const { rerender, unmount } = render(PrDetail, { props: { context: ctx } })
    await fireEvent.click(plus(2))
    await fireEvent.input(field(), { target: { value: 'half-written' } })

    await rerender({ context: other })
    expect(screen.queryByTestId('inline-comment-editor')).toBeNull()
    await fireEvent.click(plus(0))
    expect(screen.queryByTestId('inline-comment-discard')).toBeNull()
    await fireEvent.input(field(), { target: { value: 'on the other PR' } })

    await rerender({ context: ctx })
    expect(screen.getByText('Comment on line 11')).toBeInTheDocument()
    expect(field().value).toBe('half-written')

    // Survives the view remounting, too.
    unmount()
    render(PrDetail, { props: { context: other } })
    expect(screen.getByText('Comment on line 10')).toBeInTheDocument()
    expect(field().value).toBe('on the other PR')
  })
})
