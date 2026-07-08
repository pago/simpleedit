import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, languageForPath } from '../parseDiff'

const SAMPLE = `diff --git a/src/Calendar.tsx b/src/Calendar.tsx
index da4c95e7ef..399d3742b7 100644
--- a/src/Calendar.tsx
+++ b/src/Calendar.tsx
@@ -10,3 +10,4 @@ export function Calendar() {
   const x = 1
-  return null
+  const y = 2
+  return y
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Title
+body`

describe('parseUnifiedDiff', () => {
  it('splits into per-file blocks and strips git plumbing lines', () => {
    const files = parseUnifiedDiff(SAMPLE)
    expect(files.map((f) => f.path)).toEqual(['src/Calendar.tsx', 'README.md'])
    // No `diff --git`, `index`, `---`, `+++` rows survive.
    const kinds = files.flatMap((f) => f.rows.map((r) => r.text))
    expect(kinds.some((t) => t.startsWith('diff --git') || t.startsWith('index ') || t.startsWith('+++'))).toBe(false)
  })

  it('tracks additions/deletions and status', () => {
    const [cal, readme] = parseUnifiedDiff(SAMPLE)
    expect(cal.status).toBe('modified')
    expect(cal.additions).toBe(2)
    expect(cal.deletions).toBe(1)
    expect(readme.status).toBe('added')
    expect(readme.additions).toBe(2)
    expect(readme.deletions).toBe(0)
  })

  it('assigns old/new line numbers from the hunk header', () => {
    const [cal] = parseUnifiedDiff(SAMPLE)
    const content = cal.rows.filter((r) => r.kind !== 'hunk')
    expect(content[0]).toMatchObject({ kind: 'ctx', text: '  const x = 1', oldNo: 10, newNo: 10 })
    expect(content[1]).toMatchObject({ kind: 'del', text: '  return null', oldNo: 11 })
    expect(content[2]).toMatchObject({ kind: 'add', text: '  const y = 2', newNo: 11 })
    expect(content[3]).toMatchObject({ kind: 'add', text: '  return y', newNo: 12 })
  })

  it('keeps the hunk header as a separator row', () => {
    const [cal] = parseUnifiedDiff(SAMPLE)
    expect(cal.rows[0].kind).toBe('hunk')
    expect(cal.rows[0].text).toContain('export function Calendar()')
  })

  it('detects renames', () => {
    const renamed = parseUnifiedDiff(
      `diff --git a/old/path.ts b/new/path.ts\nsimilarity index 100%\nrename from old/path.ts\nrename to new/path.ts`
    )
    expect(renamed[0]).toMatchObject({ status: 'renamed', path: 'new/path.ts', oldPath: 'old/path.ts' })
  })
})

describe('languageForPath', () => {
  it('maps common extensions to Monaco language ids', () => {
    expect(languageForPath('a/b.tsx')).toBe('typescript')
    expect(languageForPath('x.css')).toBe('css')
    expect(languageForPath('x.py')).toBe('python')
    expect(languageForPath('Makefile')).toBe('plaintext')
    expect(languageForPath('data.yaml')).toBe('yaml')
  })
})
