import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
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
