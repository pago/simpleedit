import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect } from 'vitest'
import MobileDiff from '../MobileDiff.svelte'

/**
 * What the phone can actually read, and what it must never do.
 *
 * `parseDiff.test.ts` already proves the parse. What is new here is the
 * rendering promises this surface makes: the page never scrolls sideways, a
 * huge file does not have to be paid for up front, and without `ontap`
 * nothing on a row is actionable.
 */

const SMALL = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ export function a() {
 const keep = 1
-const gone = 2
+const added = 2
+const also = 3
`

function bigDiff(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n')
  return `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,${lines} @@\n${body}\n`
}

describe('MobileDiff', () => {
  it('renders every changed line with its new-file line number', () => {
    render(MobileDiff, { props: { diff: SMALL } })
    const rows = screen.getAllByTestId('diff-line')
    // 1 context + 1 deletion + 2 additions, under one hunk header
    expect(rows).toHaveLength(4)
    expect(screen.getAllByTestId('diff-hunk')).toHaveLength(1)
    const added = rows.find((r) => r.textContent?.includes('const added = 2'))
    const removed = rows.find((r) => r.textContent?.includes('const gone = 2'))
    expect(added?.getAttribute('data-line')).toBe('2')
    expect(added?.textContent).toContain('+')
    // A deletion has no line in the new file, so it gets no number rather than
    // a borrowed one that would read as a place you could go.
    expect(removed?.getAttribute('data-line')).toBe('')
    expect(removed?.textContent).toContain('−')
  })

  it('counts the file and shows its path', () => {
    render(MobileDiff, { props: { diff: SMALL } })
    const header = screen.getByTestId('diff-file-header')
    expect(header.textContent).toContain('src/a.ts')
    expect(header.textContent).toContain('+2')
    expect(header.textContent).toContain('−1')
  })

  // A horizontally scrolling PAGE fights every vertical swipe on a touch
  // screen, so the overflow has to be owned by the diff's own box.
  it('keeps long lines inside a scroll container of their own', () => {
    const { container } = render(MobileDiff, { props: { diff: SMALL } })
    expect(container.querySelector('.overflow-x-auto')).toBeTruthy()
  })

  // Read, don't write: a row that lights up under a thumb promises an action
  // this surface does not have.
  it('makes no row actionable', () => {
    render(MobileDiff, { props: { diff: SMALL } })
    for (const row of screen.getAllByTestId('diff-line')) {
      expect(row.tagName).toBe('DIV')
      expect(row.closest('li')?.querySelector('button')).toBeNull()
    }
  })

  it('opens a small diff and collapses a wide one', async () => {
    const many = Array.from(
      { length: 6 },
      (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1 +1 @@\n+x\n`,
    ).join('')
    const { unmount } = render(MobileDiff, { props: { diff: SMALL } })
    expect(screen.queryAllByTestId('diff-line').length).toBeGreaterThan(0)
    unmount()

    render(MobileDiff, { props: { diff: many } })
    expect(screen.queryAllByTestId('diff-line')).toHaveLength(0)
    await fireEvent.click(screen.getAllByTestId('diff-file-header')[0])
    expect(screen.queryAllByTestId('diff-line').length).toBeGreaterThan(0)
  })

  it('holds a huge file back behind one tap rather than rendering it all', async () => {
    render(MobileDiff, { props: { diff: bigDiff(900) } })
    // The 500-row budget counts the hunk header too.
    expect(screen.getAllByTestId('diff-line')).toHaveLength(499)
    await fireEvent.click(screen.getByTestId('show-all-rows'))
    expect(screen.getAllByTestId('diff-line')).toHaveLength(900)
  })

  it('says so instead of rendering nothing for a binary file', () => {
    render(MobileDiff, {
      props: {
        diff: 'diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n',
      },
    })
    expect(screen.getByText(/Binary file/)).toBeTruthy()
  })

  it('says a diff is empty rather than showing a blank pane', () => {
    render(MobileDiff, { props: { diff: '' } })
    expect(screen.getByTestId('diff-empty')).toBeTruthy()
  })
})
