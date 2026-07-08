/**
 * Parse a unified `git diff` (as produced by `gh pr diff`) into per-file blocks
 * for display: git plumbing lines (`diff --git`, `index`, `---`, `+++`, mode/
 * rename headers) are stripped, hunk headers become section separators, and each
 * changed line carries old/new line numbers. Pure — unit-tested.
 */
export interface DiffRow {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  /** Line content without the leading +/-/space (hunk rows carry the @@ header). */
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffFile {
  /** Display path (new path; old path for deletions). */
  path: string
  /** Set when the file was renamed (old ≠ new). */
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  rows: DiffRow[]
  additions: number
  deletions: number
  /** True for binary files (no textual hunks). */
  binary: boolean
}

function stripPrefix(p: string): string {
  if (p === '/dev/null') return p
  return p.replace(/^[ab]\//, '')
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let oldNo = 0
  let newNo = 0

  const push = (): void => {
    if (cur) files.push(cur)
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      push()
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      const oldP = m ? m[1] : ''
      const newP = m ? m[2] : ''
      cur = {
        path: newP || oldP,
        oldPath: oldP && newP && oldP !== newP ? oldP : undefined,
        status: 'modified',
        rows: [],
        additions: 0,
        deletions: 0,
        binary: false,
      }
      continue
    }
    if (!cur) continue

    // File-level metadata → refine status / path, but don't render.
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue }
    if (line.startsWith('rename from ')) { cur.oldPath = line.slice('rename from '.length); cur.status = 'renamed'; continue }
    if (line.startsWith('rename to ')) { cur.path = line.slice('rename to '.length); cur.status = 'renamed'; continue }
    if (line.startsWith('index ') || line.startsWith('similarity ') || line.startsWith('dissimilarity ') ||
        line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('\\ ')) continue
    if (line.startsWith('Binary files ')) { cur.binary = true; continue }
    if (line.startsWith('--- ')) continue
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4))
      if (p !== '/dev/null') cur.path = p
      continue
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
      oldNo = m ? Number(m[1]) : 0
      newNo = m ? Number(m[2]) : 0
      cur.rows.push({ kind: 'hunk', text: (m ? m[3] : line).trim() || line })
      continue
    }
    // Content lines.
    if (line.startsWith('+')) {
      cur.rows.push({ kind: 'add', text: line.slice(1), newNo })
      newNo++
      cur.additions++
    } else if (line.startsWith('-')) {
      cur.rows.push({ kind: 'del', text: line.slice(1), oldNo })
      oldNo++
      cur.deletions++
    } else if (line.startsWith(' ')) {
      cur.rows.push({ kind: 'ctx', text: line.slice(1), oldNo, newNo })
      oldNo++
      newNo++
    }
    // Any other stray line (blank trailing, etc.) is ignored.
  }
  push()
  return files
}

/** Monaco language id for a path, for syntax highlighting. */
export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', svelte: 'html', vue: 'html',
    md: 'markdown', markdown: 'markdown',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', xml: 'xml', sql: 'sql',
  }
  return map[ext] ?? 'plaintext'
}
