import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, afterEach } from 'vitest'
import PrDiff from '../PrDiff.svelte'
import type { CommentTarget } from '../lib/prs.svelte'

/**
 * Which lines can carry an anchor, and which honestly cannot.
 *
 * `buildReviewPayload` posts anchored comments with `side: 'RIGHT'`, so only a
 * line that exists in the NEW file has a number GitHub will accept. A deleted
 * line has an old number and no new one — anchoring to it produces a 422 that
 * the recovery path then folds into the body anyway. This proves the tap layer
 * refuses to invent that anchor in the first place.
 */
const DIFF = [
  'diff --git a/src/gate.ts b/src/gate.ts',
  'index 111..222 100644',
  '--- a/src/gate.ts',
  '+++ b/src/gate.ts',
  '@@ -10,3 +10,3 @@',
  ' const before = 1',
  '-const removed = 2',
  '+const added = 2',
  ' const after = 3',
].join('\n')

function renderDiff() {
  const taps: CommentTarget[] = []
  render(PrDiff, { diff: DIFF, comments: [], oncomment: (t: CommentTarget) => taps.push(t) })
  return taps
}

/** The row button whose rendered text starts with the given code. */
function row(text: string): HTMLElement {
  const match = screen.getAllByTestId('diff-line').find((el) => el.textContent?.includes(text))
  if (!match) throw new Error(`no diff row containing ${text}`)
  return match
}

describe('PrDiff tap targets', () => {
  it('anchors an added line to its new-file line number', async () => {
    const taps = renderDiff()
    await fireEvent.click(row('const added = 2'))
    expect(taps).toEqual([{ file: 'src/gate.ts', line: '11', snippet: 'const added = 2' }])
  })

  it('anchors a context line too — comments are not limited to what changed', async () => {
    const taps = renderDiff()
    await fireEvent.click(row('const after = 3'))
    expect(taps[0].line).toBe('12')
  })

  it('raises a deleted line with NO line, so it folds into the body', async () => {
    const taps = renderDiff()
    await fireEvent.click(row('const removed = 2'))
    expect(taps).toEqual([{ file: 'src/gate.ts', line: undefined, snippet: 'const removed = 2' }])
  })

  it('does not make the hunk header a tap target', () => {
    renderDiff()
    for (const el of screen.getAllByTestId('diff-line')) {
      expect(el.textContent).not.toContain('@@')
    }
  })

  it('shows a draft comment under the line it is anchored to', () => {
    render(PrDiff, {
      diff: DIFF,
      comments: [{ source: 'you', file: 'src/gate.ts', line: '11', text: 'why the rename?' }],
      oncomment: vi.fn(),
    })
    expect(screen.getByTestId('inline-comment')).toHaveTextContent('why the rename?')
  })
})

/**
 * The overview's Look-into citations jump here. On the phone a file may be
 * collapsed (big PRs open as a table of contents) or truncated at the row
 * budget, so the jump has to open what it lands in.
 */
describe('PrDiff reveal', () => {
  afterEach(() => vi.restoreAllMocks())

  function fileDiff(path: string, rows: string[]): string {
    return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${rows.length} +1,${rows.length} @@`, ...rows.map((r) => ` ${r}`)].join('\n')
  }

  function renderReveal(diff: string) {
    const scrolled: Element[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this)
    })
    const { component, container } = render(PrDiff, { diff, comments: [], oncomment: vi.fn() })
    return { component, container, scrolled }
  }

  it('scrolls to and highlights the cited line', async () => {
    const { component, container, scrolled } = renderReveal(DIFF)
    expect(await component.reveal('src/gate.ts', '11-12')).toBe(true)
    const marked = container.querySelectorAll('[data-revealed]')
    expect(marked).toHaveLength(1)
    expect(marked[0]).toHaveAttribute('data-line', '11')
    expect(scrolled).toEqual([marked[0]])
  })

  it('opens a collapsed file to reach the line', async () => {
    // Six files: past the auto-expand limit, so every file starts collapsed.
    const diff = ['one', 'two', 'three', 'four', 'five', 'six'].map((n) => fileDiff(`src/${n}.ts`, [`const ${n} = 1`])).join('\n')
    const { component, container } = renderReveal(diff)
    expect(screen.queryAllByTestId('diff-line')).toHaveLength(0)

    await component.reveal('src/four.ts', 1)
    expect(container.querySelector('[data-revealed]')).toHaveTextContent('const four = 1')
    expect(screen.getAllByTestId('diff-line')).toHaveLength(1)
  })

  it('shows the rest of a long file when the line is past the row budget', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => `const line${i + 1} = ${i + 1}`)
    const { component, container } = renderReveal(fileDiff('src/long.ts', rows))
    expect(screen.getByTestId('show-all-rows')).toBeInTheDocument()

    await component.reveal('src/long.ts', '550')
    expect(container.querySelector('[data-revealed]')).toHaveAttribute('data-line', '550')
    expect(screen.queryByTestId('show-all-rows')).not.toBeInTheDocument()
  })

  it('lands on the file header without a line, and reports an unknown file', async () => {
    const { component, container } = renderReveal(DIFF)
    await component.reveal('src/gate.ts')
    expect(container.querySelector('[data-revealed]')).toHaveAttribute('data-testid', 'diff-file-header')
    expect(await component.reveal('src/other.ts', '1')).toBe(false)
  })
})
