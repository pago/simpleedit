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

/**
 * `---` and `+++` are file headers only BEFORE the first hunk.
 *
 * Inside a hunk every line carries a `+`/`-`/space marker, so an added line
 * whose own text begins `++ ` — a nested markdown bullet, a C++ note — arrives
 * as `+++ …` and used to be read as a new file header: the path was replaced
 * and every following line numbered against the wrong hunk. Harmless while
 * these rows were only displayed; not harmless now that a tap on one becomes
 * the `path` and `line` of a GitHub review comment.
 */
describe('parseUnifiedDiff — markers inside a hunk are content', () => {
  const diff = [
    'diff --git a/notes.md b/notes.md',
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -1,3 +1,4 @@',
    ' intro',
    '+++ nested bullet',
    // A removed line whose own text is `-- struck through`. Three dashes, so
    // the `--- ` guard has something to get wrong — the two-dash version this
    // fixture used to carry could never have matched it.
    '--- struck through',
    ' outro',
  ].join('\n')

  it('keeps the path when an added line starts with ++', () => {
    const [file] = parseUnifiedDiff(diff)
    expect(file.path).toBe('notes.md')
  })

  it('counts it as an addition and numbers the lines after it correctly', () => {
    const [file] = parseUnifiedDiff(diff)
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
    const added = file.rows.find((r) => r.kind === 'add')
    expect(added).toEqual({ kind: 'add', text: '++ nested bullet', newNo: 2 })
    // Swallowing either marker line leaves this row numbered against the wrong
    // side — which is the number a review comment would be anchored to.
    expect(file.rows.at(-1)).toEqual({ kind: 'ctx', text: 'outro', oldNo: 3, newNo: 3 })
  })

  it('keeps a removed line whose text starts with --, and counts it', () => {
    const [file] = parseUnifiedDiff(diff)
    expect(file.rows.find((r) => r.kind === 'del')).toEqual({
      kind: 'del', text: '-- struck through', oldNo: 2,
    })
    expect(file.deletions).toBe(1)
  })

  it('still reads the real headers, including a rename to /dev/null', () => {
    const [file] = parseUnifiedDiff(
      ['diff --git a/old.ts b/new.ts', '--- a/old.ts', '+++ b/new.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
    )
    expect(file.path).toBe('new.ts')
  })
})
