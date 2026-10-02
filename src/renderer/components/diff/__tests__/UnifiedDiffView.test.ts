import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRawSnippet, tick } from 'svelte'
import UnifiedDiffView from '../UnifiedDiffView.svelte'
import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../../../../shared/parseDiff'
import { REVEAL_FLASH_MS } from '../../../lib/diffReveal'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,2 @@',
  ' export const a = 1',
  '+export const added = 2',
  '-export const gone = 3',
].join('\n')

// The composed-panel DiffBlock and the screen-PRs detail view share this
// component; a regression here breaks both.
describe('UnifiedDiffView', () => {
  it('renders one card per file with its rows, and no git plumbing', async () => {
    render(UnifiedDiffView, { files: parseUnifiedDiff(DIFF) })
    await tick()

    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('export const added = 2')).toBeInTheDocument()
    expect(screen.getByText('export const gone = 3')).toBeInTheDocument()
    expect(screen.queryByText(/index 1111111/)).not.toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
  })

  it('keeps wide rows inside their own horizontally scrollable container', async () => {
    const { container } = render(UnifiedDiffView, { files: parseUnifiedDiff(DIFF) })
    await tick()
    expect(container.querySelector('.overflow-x-auto')).not.toBeNull()
  })

  it('shows the empty label when there is nothing to diff', async () => {
    render(UnifiedDiffView, { files: [], emptyLabel: 'No parsable diff content.' })
    await tick()
    expect(screen.getByText('No parsable diff content.')).toBeInTheDocument()
  })

  it('flags a binary file instead of rendering rows', async () => {
    const binary = parseUnifiedDiff(
      ['diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ'].join('\n'),
    )
    render(UnifiedDiffView, { files: binary })
    await tick()
    expect(screen.getByText('Binary file not shown')).toBeInTheDocument()
  })
})

describe('UnifiedDiffView reveal', () => {
  const TWO_FILES = [
    DIFF,
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -20,2 +20,2 @@',
    ' export const b = 1',
    '+export const bAdded = 2',
  ].join('\n')

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function renderView() {
    const scrolled: Element[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this)
    })
    const { component, container } = render(UnifiedDiffView, { files: parseUnifiedDiff(TWO_FILES) })
    return { component, container, scrolled }
  }

  it('scrolls to and highlights the row for a path:line', async () => {
    const { component, container, scrolled } = renderView()
    expect(await component.reveal('src/b.ts', '21')).toBe(true)

    const marked = container.querySelectorAll('[data-revealed]')
    expect(marked).toHaveLength(1)
    expect(marked[0]).toHaveTextContent('export const bAdded = 2')
    expect(scrolled).toEqual([marked[0]])
  })

  it('lands on the file header when there is no line', async () => {
    const { component, container, scrolled } = renderView()
    await component.reveal('src/b.ts')
    const marked = container.querySelector('[data-revealed]')
    expect(marked).toHaveTextContent('src/b.ts')
    expect(marked).not.toHaveTextContent('bAdded')
    expect(scrolled).toEqual([marked])
  })

  it('clears the highlight after the flash, and moves it on a second reveal', async () => {
    vi.useFakeTimers()
    const { component, container } = renderView()
    await component.reveal('src/a.ts', 2)
    expect(container.querySelector('[data-revealed]')).toHaveTextContent('export const added = 2')

    await component.reveal('src/b.ts', 20)
    expect(container.querySelectorAll('[data-revealed]')).toHaveLength(1)
    expect(container.querySelector('[data-revealed]')).toHaveTextContent('export const b = 1')

    vi.advanceTimersByTime(REVEAL_FLASH_MS)
    await tick()
    expect(container.querySelector('[data-revealed]')).toBeNull()
  })

  it('reports a file the diff does not contain, without scrolling', async () => {
    const { component, scrolled } = renderView()
    expect(await component.reveal('src/missing.ts', '1')).toBe(false)
    expect(scrolled).toEqual([])
  })
})

describe('UnifiedDiffView line hooks', () => {
  it('stays read-only without onLineClick: no ＋, no extra row content', async () => {
    const { container } = render(UnifiedDiffView, { files: parseUnifiedDiff(DIFF) })
    await tick()
    expect(screen.queryAllByTestId('diff-line-comment')).toHaveLength(0)
    expect(container.querySelector('.sticky')).toBeNull()
  })

  it('offers a labelled ＋ on every line row that reports the row it sits on', async () => {
    const onLineClick = vi.fn()
    const files = parseUnifiedDiff(DIFF)
    render(UnifiedDiffView, { files, onLineClick })
    await tick()
    const pluses = screen.getAllByTestId('diff-line-comment')
    expect(pluses).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Comment on deleted line 2' })).toBe(pluses[2])
    await fireEvent.click(pluses[1], { shiftKey: true })
    const [file, row, index, ev] = onLineClick.mock.calls[0]
    expect(file).toBe(files[0])
    expect(row).toMatchObject({ kind: 'add', newNo: 2 })
    expect(index).toBe(2)
    expect((ev as MouseEvent).shiftKey).toBe(true)
  })

  it('highlights the selected range on its own side only', async () => {
    const files = parseUnifiedDiff(DIFF)
    const { container, rerender } = render(UnifiedDiffView, {
      files,
      onLineClick: () => {},
      selectedRange: { path: 'src/a.ts', side: 'RIGHT', from: 1, to: 2 },
    })
    await tick()
    const selected = () => [...container.querySelectorAll('[data-selected]')].map((el) => el.textContent)
    expect(selected()).toEqual([expect.stringContaining('export const a = 1'), expect.stringContaining('export const added = 2')])

    await rerender({ selectedRange: { path: 'src/a.ts', side: 'LEFT', from: 2, to: 2 } })
    expect(selected()).toEqual([expect.stringContaining('export const gone = 3')])
  })

  it('renders belowRow after each line row, but not after hunk headers', async () => {
    const belowRow = createRawSnippet<[DiffFile, DiffRow, number]>((_f, row, i) => ({
      render: () => `<p data-testid="below">${i()}:${row().kind}</p>`,
    }))
    render(UnifiedDiffView, { files: parseUnifiedDiff(DIFF), belowRow })
    await tick()
    expect(screen.getAllByTestId('below').map((el) => el.textContent)).toEqual(['1:ctx', '2:add', '3:del'])
  })
})
