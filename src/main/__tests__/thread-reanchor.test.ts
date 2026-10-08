import { describe, it, expect } from 'vitest'
import { followsWorkingCopy, reanchor } from '../thread-reanchor'
import type { ThreadAnchor } from '../../shared/agent-threads'

const FILE = [
  'import { x } from "y"', // 1
  '', // 2
  'function alpha() {', // 3
  '  const total = items.reduce((a, b) => a + b, 0)', // 4
  '  return total', // 5
  '}', // 6
  '', // 7
  'function beta() {', // 8
  '  return 2', // 9
  '}', // 10
]

const text = (lines: string[]): string => lines.join('\n')

/** An anchor as the client captures it: 3 context lines either side. */
function anchorAt(lines: string[], startLine: number, endLine: number, context: ThreadAnchor['context'] = 'file'): ThreadAnchor {
  return {
    path: 'src/a.ts',
    startLine,
    endLine,
    snippet: lines.slice(startLine - 1, endLine).join('\n'),
    before: lines.slice(Math.max(0, startLine - 4), startLine - 1).join('\n'),
    after: lines.slice(endLine, endLine + 3).join('\n'),
    context,
  }
}

describe('reanchor', () => {
  const a = anchorAt(FILE, 4, 5)

  it('leaves an anchor whose lines still hold the snippet alone', () => {
    expect(reanchor(a, text(FILE))).toBeNull()
    expect(reanchor(a, text([...FILE, '// trailing edit']))).toBeNull()
  })

  it('follows code moved down', () => {
    const next = reanchor(a, text(['// one', '// two', ...FILE]))
    expect(next).toMatchObject({ startLine: 6, endLine: 7, snippet: a.snippet })
    expect(next?.orphaned).toBeUndefined()
  })

  it('follows code moved up', () => {
    const next = reanchor(a, text(FILE.slice(2)))
    expect(next).toMatchObject({ startLine: 2, endLine: 3 })
    expect(next?.before).toBe('function alpha() {')
  })

  it('refreshes the context around the new place', () => {
    const lines = ['// new', ...FILE]
    const next = reanchor(a, text(lines))
    expect(next?.before).toBe(text(lines.slice(1, 4)))
    expect(next?.after).toBe(text(lines.slice(6, 9)))
  })

  it('stays in place with fresh context when a distinctive snippet loses its surroundings', () => {
    const lines = [...FILE]
    lines[2] = 'function alphaRenamed() {'
    lines[5] = '} // end'
    const next = reanchor(a, text(lines))
    expect(next).toMatchObject({ startLine: 4, endLine: 5 })
    expect(next?.before).toBe(text(lines.slice(0, 3)))
    expect(next?.after).toBe(text(lines.slice(5, 8)))
    expect(reanchor(next!, text(lines))).toBeNull()
  })

  it('falls back to the snippet alone when its context was edited', () => {
    const lines = ['// new', ...FILE]
    lines[3] = 'function alphaRenamed() {'
    lines[7] = '// changed'
    expect(reanchor(a, text(lines))).toMatchObject({ startLine: 5, endLine: 6 })
  })

  it('orphans, keeping its lines, when the snippet itself was edited', () => {
    const lines = ['// new', ...FILE]
    lines[4] = '  const total = sum(items)'
    expect(reanchor(a, text(lines))).toEqual({ ...a, orphaned: true })
  })

  it('does not orphan again what is already orphaned', () => {
    expect(reanchor({ ...a, orphaned: true }, text(['nothing here']))).toBeNull()
    expect(reanchor({ ...a, orphaned: true }, null)).toBeNull()
  })

  it('orphans when the snippet appears more than once and its context is gone', () => {
    const lines = ['// new', ...FILE.slice(2, 6), '// other', ...FILE.slice(2, 6)]
    expect(reanchor(a, text(lines))).toMatchObject({ orphaned: true, startLine: 4 })
  })

  it('tells duplicates apart by their context', () => {
    const lines = ['// copy', FILE[3]!, FILE[4]!, '// end', ...FILE]
    const next = reanchor(a, text(lines))
    expect(next).toMatchObject({ startLine: 8, endLine: 9 })
    expect(next?.orphaned).toBeUndefined()
  })

  describe('a short snippet', () => {
    const brace = anchorAt(FILE, 6, 6)

    it('re-anchors with its context', () => {
      expect(reanchor(brace, text(['// new', ...FILE]))).toMatchObject({ startLine: 7, endLine: 7 })
    })

    it('moves off an identical line it was shifted onto, when its context is found elsewhere', () => {
      const nested = ['{', '  x', '}', '}', 'd']
      const outer = anchorAt(nested, 4, 4)
      const lines = ['// top', ...nested]
      expect(lines[3]).toBe('}')
      expect(reanchor(outer, text(lines))).toMatchObject({ startLine: 5, endLine: 5 })
    })

    it('orphans after an edit right above it when no unique context matches', () => {
      const lines = [...FILE]
      lines[4] = '  return total * 2'
      expect(reanchor(brace, text(lines))).toEqual({ ...brace, orphaned: true })
    })

    it("orphans rather than keep another function's identical line", () => {
      const fns = ['function a() {', '  1', '}', 'function b() {', '  2', '}', 'function c() {', '  3', '}']
      const bClose = anchorAt(fns, 6, 6)
      const withoutB = [...fns.slice(0, 3), ...fns.slice(6)]
      expect(withoutB[5]).toBe('}')
      expect(reanchor(bClose, text(withoutB))).toMatchObject({ orphaned: true, startLine: 6 })
    })

    it('treats context cut off by the end of the file as matching', () => {
      const last = anchorAt(FILE, 10, 10)
      expect(last.after).toBe('')
      expect(reanchor({ ...last, after: 'x\ny' }, text(FILE))).toBeNull()
    })

    it('never re-anchors on the snippet alone', () => {
      const lines = ['// new', ...FILE]
      lines[5] = '  return total // edited'
      expect(lines.filter((l) => l === '}')).toHaveLength(2)
      const single = { ...brace, before: '', after: '' }
      expect(reanchor(single, text(['x', '}']))).toEqual({ ...single, orphaned: true })
      expect(reanchor(brace, text(lines))).toMatchObject({ orphaned: true })
    })

    it('does re-anchor a single line of 20+ visible characters on its own', () => {
      const line = anchorAt(FILE, 4, 4)
      const lines = ['// new', ...FILE]
      lines[3] = '// renamed'
      lines[5] = '  return total + 0'
      expect(reanchor(line, text(lines))).toMatchObject({ startLine: 5, endLine: 5 })
    })

    it('re-anchors two non-blank lines on their own however short', () => {
      const pair = anchorAt(['a', 'b', 'x', 'y', 'c'], 3, 4)
      expect(reanchor(pair, text(['z', 'x', 'y']))).toMatchObject({ startLine: 2, endLine: 3 })
    })

    it('does not count blank lines towards the two', () => {
      const blankish = anchorAt(['a', 'b', '}', '', 'c'], 3, 4)
      expect(reanchor(blankish, text(['z', '}', '']))).toMatchObject({ orphaned: true })
    })
  })

  it('matches a CRLF file against an LF snippet', () => {
    expect(reanchor(a, FILE.join('\r\n'))).toBeNull()
    expect(reanchor(a, ['// new', ...FILE].join('\r\n'))).toMatchObject({ startLine: 5, endLine: 6 })
  })

  it('orphans when the file is gone', () => {
    expect(reanchor(a, null)).toEqual({ ...a, orphaned: true })
  })

  it('handles a file now shorter than the old range', () => {
    const late = anchorAt(FILE, 8, 10)
    expect(reanchor(late, text(FILE.slice(7)))).toMatchObject({ startLine: 1, endLine: 3 })
    expect(reanchor(late, text(FILE.slice(0, 3)))).toMatchObject({ orphaned: true, startLine: 8, endLine: 10 })
    expect(reanchor(late, '')).toMatchObject({ orphaned: true })
  })

  it('recovers an orphaned thread when its code is unique again', () => {
    const orphaned: ThreadAnchor = { ...a, orphaned: true }
    const back = reanchor(orphaned, text(['// new', ...FILE]))
    expect(back).toMatchObject({ startLine: 5, endLine: 6 })
    expect(back && 'orphaned' in back).toBe(false)
    const inPlace = reanchor(orphaned, text(FILE))
    expect(inPlace).toEqual(a)
  })

  it('anchors at the file start, where there is no context above', () => {
    const top = anchorAt(FILE, 1, 1)
    expect(top.before).toBe('')
    expect(reanchor(top, text(['// header', ...FILE]))).toMatchObject({ startLine: 2, endLine: 2 })
  })
})

describe('followsWorkingCopy', () => {
  it('follows file and uncommitted anchors, never a commit', () => {
    expect(followsWorkingCopy(anchorAt(FILE, 1, 1))).toBe(true)
    expect(followsWorkingCopy(anchorAt(FILE, 1, 1, { commit: 'uncommitted' }))).toBe(true)
    expect(followsWorkingCopy(anchorAt(FILE, 1, 1, { commit: 'abc1234' }))).toBe(false)
  })
})
