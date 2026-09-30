import { describe, it, expect } from 'vitest'
import { findRevealTarget } from '../diffReveal'
import { parseUnifiedDiff } from '../parseDiff'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,3 @@',
  ' const before = 1', // row 1, new 10
  '-const removed = 2', // row 2, old only
  '+const added = 2', // row 3, new 11
  ' const after = 3', // row 4, new 12
  '@@ -40,2 +40,2 @@',
  ' const far = 1', // row 6, new 40
  '+const farAdded = 2', // row 7, new 41
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 90%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  '--- a/old/name.ts',
  '+++ b/new/name.ts',
  '@@ -1,1 +1,1 @@',
  '-x',
  '+y',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
].join('\n')

const files = parseUnifiedDiff(DIFF)

describe('findRevealTarget', () => {
  it('lands on the exact new-file row when the hunks include it', () => {
    expect(findRevealTarget(files, 'src/a.ts', '11')).toEqual({ path: 'src/a.ts', row: 3 })
    expect(findRevealTarget(files, 'src/a.ts', 41)).toEqual({ path: 'src/a.ts', row: 7 })
  })

  it('takes the start of a range, in either dash', () => {
    expect(findRevealTarget(files, 'src/a.ts', '12-18')).toEqual({ path: 'src/a.ts', row: 4 })
    expect(findRevealTarget(files, 'src/a.ts', '40–41')).toEqual({ path: 'src/a.ts', row: 6 })
  })

  it('falls back to the nearest new-file row for a line outside every hunk', () => {
    expect(findRevealTarget(files, 'src/a.ts', '20')).toEqual({ path: 'src/a.ts', row: 4 })
    expect(findRevealTarget(files, 'src/a.ts', '35')).toEqual({ path: 'src/a.ts', row: 6 })
    expect(findRevealTarget(files, 'src/a.ts', '1')).toEqual({ path: 'src/a.ts', row: 1 })
  })

  it('lands on the header without a usable line, or for a binary file', () => {
    expect(findRevealTarget(files, 'src/a.ts')).toEqual({ path: 'src/a.ts', row: null })
    expect(findRevealTarget(files, 'src/a.ts', 'n/a')).toEqual({ path: 'src/a.ts', row: null })
    expect(findRevealTarget(files, 'src/a.ts', 0)).toEqual({ path: 'src/a.ts', row: null })
    expect(findRevealTarget(files, 'img.png', '3')).toEqual({ path: 'img.png', row: null })
  })

  it("finds a renamed file by its old path, reporting the diff's display path", () => {
    expect(findRevealTarget(files, 'old/name.ts', '1')).toEqual({ path: 'new/name.ts', row: 2 })
  })

  it('returns null for a file the diff does not contain', () => {
    expect(findRevealTarget(files, 'src/missing.ts', '1')).toBeNull()
  })
})
