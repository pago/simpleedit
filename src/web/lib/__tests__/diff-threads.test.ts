import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, type DiffFile } from '../../../shared/parseDiff'
import { diffAnchor, locateLine, rowKey, threadsByRow } from '../diff-threads'
import type { AgentThread, ThreadAnchor } from '../../../shared/agent-threads'

// Two hunks: new lines 10-15, then 40-41. `inserted` is new 12.
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,5 +10,6 @@',
  ' ten',
  ' eleven',
  '+inserted',
  ' thirteen',
  '-gone',
  ' fourteen',
  ' fifteen',
  '@@ -39,2 +40,2 @@',
  ' forty',
  ' forty-one',
].join('\n')

const file = (): DiffFile => parseUnifiedDiff(DIFF)[0]!
const rowOf = (text: string) => file().rows.find((r) => r.text === text)!
const WT = { worktreePath: '/wt', commit: 'uncommitted' }

function thread(id: string, anchor: Partial<ThreadAnchor>, over: Partial<AgentThread> = {}): AgentThread {
  return {
    id,
    sessionId: 's1',
    worktreePath: '/wt',
    anchor: { path: 'src/a.ts', startLine: 12, endLine: 12, snippet: '', before: '', after: '', context: 'file', ...anchor },
    status: 'open',
    messages: [],
    lastReadAt: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

describe('diffAnchor', () => {
  it('anchors a tapped line with up to three new-side lines either side, skipping deletions', () => {
    expect(diffAnchor(file(), rowOf('thirteen'), WT)).toEqual({
      path: 'src/a.ts',
      startLine: 13,
      endLine: 13,
      snippet: 'thirteen',
      before: 'ten\neleven\ninserted',
      after: 'fourteen\nfifteen',
      context: { commit: 'uncommitted' },
    })
  })

  it('stops the context at a hunk edge rather than borrowing the next hunk', () => {
    const a = diffAnchor(file(), rowOf('forty'), { worktreePath: '/wt', commit: 'abc1234' })
    expect(a).toMatchObject({ startLine: 40, before: '', after: 'forty-one', context: { commit: 'abc1234' } })
  })

  it('refuses a deleted line: it has no line on the side a thread lives on', () => {
    expect(diffAnchor(file(), rowOf('gone'), WT)).toBeNull()
  })
})

describe('threadsByRow', () => {
  it('places working-copy threads in the uncommitted diff, under their last line', () => {
    const placed = threadsByRow(
      [
        thread('t_file', { startLine: 11, endLine: 12 }),
        thread('t_unc', { startLine: 15, endLine: 15, context: { commit: 'uncommitted' } }),
        thread('t_commit', { context: { commit: 'abc1234' } }),
      ],
      [file()],
      WT,
    )
    expect(placed.get(rowKey('src/a.ts', 12))?.map((t) => t.id)).toEqual(['t_file'])
    expect(placed.get(rowKey('src/a.ts', 15))?.map((t) => t.id)).toEqual(['t_unc'])
    expect([...placed.values()].flat()).toHaveLength(2)
  })

  it("places a commit's threads only in that commit's diff", () => {
    const threads = [thread('t_commit', { context: { commit: 'abc1234' } }), thread('t_file', {})]
    const placed = threadsByRow(threads, [file()], { worktreePath: '/wt/', commit: 'abc1234' })
    expect([...placed.values()].flat().map((t) => t.id)).toEqual(['t_commit'])
  })

  it('falls back to the first line, and leaves out what the diff does not hold', () => {
    const placed = threadsByRow(
      [
        thread('t_range', { startLine: 15, endLine: 20 }),
        thread('t_far', { startLine: 25, endLine: 25 }),
        thread('t_other', { path: 'src/b.ts' }),
        thread('t_orphan', { orphaned: true }),
        thread('t_elsewhere', {}, { worktreePath: '/other' }),
      ],
      [file()],
      WT,
    )
    expect([...placed.entries()].map(([k, ts]) => [k, ts.map((t) => t.id)])).toEqual([[rowKey('src/a.ts', 15), ['t_range']]])
  })
})

describe('locateLine', () => {
  it('keeps a line that still reads the same, and refuses one that does not', () => {
    expect(locateLine(file(), 12, 'inserted')).toBe(12)
    expect(locateLine(file(), 11, 'inserted')).toBeNull()
  })

  it('finds distinctive text that moved, but only when it is unique', () => {
    const long = 'const answer = computeTheAnswer(input)'
    const moved = parseUnifiedDiff(['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,1 +1,3 @@', '+a', '+b', `+${long}`].join('\n'))[0]!
    expect(locateLine(moved, 1, long)).toBe(3)
    const twice = parseUnifiedDiff(['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,1 +1,3 @@', `+${long}`, '+b', `+${long}`].join('\n'))[0]!
    expect(locateLine(twice, 2, long)).toBeNull()
  })
})
