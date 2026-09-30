import { render, screen, fireEvent, within } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import OverviewCard from '../OverviewCard.svelte'
import type { OverviewState } from '../../../stores/screenprs.svelte'
import type { PrContext } from '../../../../shared/screenprs'

const CONTEXT: Pick<PrContext, 'author' | 'reviewers' | 'ci' | 'ciFailing' | 'headSha'> = {
  author: 'dana',
  reviewers: [{ login: 'lee', state: 'approved' }, { login: 'kim', state: 'changes_requested' }],
  ci: 'failing',
  ciFailing: ['lint'],
  headSha: 'sha1',
}

const TEXT = `## What changed
Adds a **virtualized** body (\`src/Table/body.tsx:12\`).

## Why
Scrolling 1000 rows was slow.

## Impact
New \`rowHeight\` prop.

## Look into
1. Is the overscan right? \`src/Table/body.tsx:40-52\`
2. Should this ship behind a flag?`

function done(over: Partial<OverviewState> = {}): OverviewState {
  return { status: 'done', text: TEXT, facts: { draft: false, changeset: 'base', changesetBase: '#2531' }, headSha: 'sha1', ...over }
}

function renderCard(overview: OverviewState, extra: Record<string, unknown> = {}) {
  const onref = vi.fn()
  const onreview = vi.fn()
  render(OverviewCard, { props: { context: CONTEXT, overview, onref, onreview, ...extra } })
  return { onref, onreview }
}

describe('OverviewCard', () => {
  it('renders the facts header from code, never from the model', () => {
    renderCard(done())
    const facts = screen.getByTestId('overview-facts')
    expect(facts).toHaveTextContent('@dana')
    expect(facts).toHaveTextContent('ready')
    expect(facts).toHaveTextContent('1 approved · 1 changes requested')
    expect(facts).toHaveTextContent('CI failing: lint')
    expect(facts).toHaveTextContent('changeset: maybe in #2531')
  })

  it('shows a running state', () => {
    renderCard({ status: 'running' })
    expect(screen.getByTestId('overview-running')).toBeInTheDocument()
    expect(screen.queryByTestId('overview-section-what')).toBeNull()
  })

  it('shows the error', () => {
    renderCard({ status: 'error', error: 'claude exited with code 1' })
    expect(screen.getByTestId('overview-error')).toHaveTextContent('Overview failed: claude exited with code 1')
  })

  it('renders each section as sanitized markdown', () => {
    renderCard(done({ text: TEXT.replace('slow.', 'slow. <img src=x onerror="alert(1)">') }))
    const what = screen.getByTestId('overview-section-what')
    expect(within(what).getByText('virtualized').tagName).toBe('STRONG')
    expect(screen.getByTestId('overview-section-why').querySelector('img')?.getAttribute('onerror')).toBeNull()
    expect(screen.getAllByTestId('look-into-item')).toHaveLength(2)
  })

  it('opens only the sections asked for, and lets the reader toggle the rest', async () => {
    renderCard(done(), { initiallyOpen: ['what'] })
    expect(screen.getByTestId('overview-section-what')).toHaveTextContent('virtualized')
    expect(screen.getByTestId('overview-section-why')).not.toHaveTextContent('Scrolling')
    await fireEvent.click(within(screen.getByTestId('overview-section-why')).getByRole('button'))
    expect(screen.getByTestId('overview-section-why')).toHaveTextContent('Scrolling 1000 rows was slow.')
  })

  it('jumps to a citation and lifts an item into the review', async () => {
    const { onref, onreview } = renderCard(done())
    const [first] = screen.getAllByTestId('look-into-item')
    await fireEvent.click(within(first).getByTestId('overview-ref'))
    expect(onref).toHaveBeenCalledWith({ path: 'src/Table/body.tsx', line: '40-52' })
    await fireEvent.click(within(first).getByTestId('overview-add-review'))
    expect(onreview).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'Is the overscan right? `src/Table/body.tsx:40-52`' }))
  })

  it('offers Discuss only where there is an agent to discuss with', () => {
    renderCard(done())
    expect(screen.queryByTestId('overview-discuss')).toBeNull()
  })

  it('offers Discuss per item when given a handler', async () => {
    const ondiscuss = vi.fn()
    renderCard(done(), { ondiscuss })
    await fireEvent.click(screen.getAllByTestId('overview-discuss')[1])
    expect(ondiscuss).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'Should this ship behind a flag?', refs: [] }))
  })

  it('shows unstructured output whole, with a note, instead of dropping it', () => {
    renderCard(done({ text: 'Here is your overview!\n\n## What changed\nA thing.' }))
    expect(screen.getByTestId('overview-unstructured')).toBeInTheDocument()
    expect(screen.getByTestId('overview-raw')).toHaveTextContent('Here is your overview!')
    expect(screen.getByTestId('overview-raw')).toHaveTextContent('A thing.')
    expect(screen.queryByTestId('look-into-item')).toBeNull()
  })

  it('says when the overview was written for an earlier head', () => {
    renderCard(done({ headSha: 'old' }))
    expect(screen.getByTestId('overview-stale')).toBeInTheDocument()
  })
})
