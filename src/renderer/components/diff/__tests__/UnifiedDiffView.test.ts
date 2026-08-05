import { render, screen } from '@testing-library/svelte'
import { describe, it, expect } from 'vitest'
import { tick } from 'svelte'
import UnifiedDiffView from '../UnifiedDiffView.svelte'
import { parseUnifiedDiff } from '../../../lib/parseDiff'

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
