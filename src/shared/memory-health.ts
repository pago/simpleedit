/**
 * Health checks for a Claude auto-memory directory: index links that point
 * nowhere, root-level memories the index never mentions, and `[[wiki]]` links
 * no memory answers to. Pure — main walks the dir and hands the files in.
 *
 * Ranges are 1-based Monaco positions on the BOM-stripped text, `endColumn`
 * exclusive.
 */
export const MEMORY_MAX_FILES = 2000
export const MEMORY_MAX_FILE_BYTES = 1024 * 1024
export const MEMORY_MAX_DEPTH = 3

export type MemoryHealthIssueKind = 'index-missing-file' | 'unindexed-file' | 'broken-link'
export type MemoryHealthSeverity = 'warning' | 'info'

export interface MemoryHealthIssue {
  kind: MemoryHealthIssueKind
  /** Path relative to the memory dir, `/`-separated. */
  rel: string
  line: number
  column: number
  endColumn: number
  message: string
}

export interface MemoryHealthReportIssue extends MemoryHealthIssue {
  /** Absolute path of `rel`. */
  file: string
}

export interface MemoryHealthReport {
  memoryDir: string
  indexPresent: boolean
  fileCount: number
  issues: MemoryHealthReportIssue[]
}

export interface MemoryFile {
  /** Path relative to the memory dir, `/`-separated. */
  rel: string
  /**
   * File text, or null when it was not read (non-markdown, over the size cap,
   * unreadable). A null index means its links are unknown, not absent.
   */
  content: string | null
}

export function memoryIssueSeverity(kind: MemoryHealthIssueKind): MemoryHealthSeverity {
  return kind === 'unindexed-file' ? 'info' : 'warning'
}

/** Canonical form of a memory name, so `[[My Note]]` finds `my_note.md`. */
export function normalizeMemoryKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[\s_]+/g, '-')
}

function toLines(content: string): string[] {
  return content.replace(/^﻿/, '').split(/\r?\n/)
}

/**
 * The top-level `name:` of a `---`-fenced frontmatter block. Tolerant: a
 * missing or malformed block just yields no name.
 */
export function parseMemoryFrontmatter(content: string): { name: string | null } {
  const lines = toLines(content)
  if (lines[0]?.trimEnd() !== '---') return { name: null }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trimEnd() === '---') return { name: null }
    const m = /^name:(.*)$/.exec(line)
    if (m) {
      const closed = lines.slice(i + 1).some((l) => l.trimEnd() === '---')
      if (!closed) return { name: null }
      const value = m[1]!.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
      return { name: value || null }
    }
  }
  return { name: null }
}

// Shared with the renderer, which has no `path` module.
function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

function stripExt(rel: string): string {
  const dot = rel.lastIndexOf('.')
  return dot > rel.lastIndexOf('/') + 1 ? rel.slice(0, dot) : rel
}

function normalizeRel(rel: string): string {
  const out: string[] = []
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function keysFor(file: MemoryFile, frontmatterName: string | null): string[] {
  const keys = [normalizeMemoryKey(stripExt(baseName(file.rel))), normalizeMemoryKey(stripExt(file.rel))]
  if (frontmatterName) keys.push(normalizeMemoryKey(frontmatterName))
  return keys.filter((k) => k !== '')
}

function isMarkdown(rel: string): boolean {
  return /\.md$/i.test(rel)
}

/** Replace inline code spans with spaces so columns stay put. */
function maskInlineCode(line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i]
      i++
      continue
    }
    let run = 0
    while (line[i + run] === '`') run++
    const fence = '`'.repeat(run)
    let search = i + run
    let close = -1
    while (search < line.length) {
      const at = line.indexOf(fence, search)
      if (at === -1) break
      let len = 0
      while (line[at + len] === '`') len++
      if (len === run) {
        close = at
        break
      }
      search = at + len
    }
    if (close === -1) {
      out += fence
      i += run
    } else {
      out += ' '.repeat(close + run - i)
      i = close + run
    }
  }
  return out
}

/** Each line with fenced code blanked and inline code masked. */
function proseLines(lines: string[]): string[] {
  let fence: { char: string; len: number } | null = null
  return lines.map((line) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len && line.trim() === m[1]) fence = null
      return ''
    }
    if (m) {
      fence = { char: m[1]![0]!, len: m[1]!.length }
      return ''
    }
    return maskInlineCode(line)
  })
}

const WIKI_LINK = /\[\[([^\]|#\n]+)(?:[|#][^\]]*)?\]\]/g
// The optional part after the destination is a CommonMark title only ("…",
// '…' or (…)); anything else means the text isn't a link at all, so
// `[x](my note.md)` is not a link to "my".
const MD_LINK = /\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g

interface Hit {
  line: number
  column: number
  endColumn: number
  value: string
}

function findAll(lines: string[], re: RegExp): Hit[] {
  const hits: Hit[] = []
  lines.forEach((line, idx) => {
    re.lastIndex = 0
    for (let m = re.exec(line); m; m = re.exec(line)) {
      hits.push({ line: idx + 1, column: m.index + 1, endColumn: m.index + m[0].length + 1, value: m[1]! })
    }
  })
  return hits
}

/** The relative path an index link names, or null if it is external / an anchor. */
function linkTarget(raw: string): string | null {
  let t = raw.trim()
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim()
  if (t === '' || t.startsWith('#') || /^(https?:|mailto:|file:)/i.test(t)) return null
  // Absolute paths point outside the memory dir; there is nothing to check them against.
  if (/^([/\\~]|[A-Za-z]:[/\\])/.test(t)) return null
  const cut = t.search(/[#?]/)
  if (cut !== -1) t = t.slice(0, cut)
  try {
    t = decodeURIComponent(t)
  } catch {
    // Malformed escapes: match against the raw text.
  }
  while (t.startsWith('./')) t = t.slice(2)
  const normalized = normalizeRel(t)
  return normalized === '' ? null : normalized
}

/** The root-level `MEMORY.md` (any case), if present. */
export function findMemoryIndex(files: readonly MemoryFile[]): MemoryFile | undefined {
  const roots = files.filter((f) => !f.rel.includes('/') && f.rel.toLowerCase() === 'memory.md')
  return roots.find((f) => f.rel === 'MEMORY.md') ?? roots[0]
}

export function analyzeMemory(input: readonly MemoryFile[]): MemoryHealthIssue[] {
  const files = input.slice(0, MEMORY_MAX_FILES)
  const names = new Set(files.map((f) => f.rel))
  const dirs = new Set<string>()
  for (const f of files) {
    for (let i = f.rel.indexOf('/'); i !== -1; i = f.rel.indexOf('/', i + 1)) dirs.add(f.rel.slice(0, i))
  }
  const readable = (f: MemoryFile): f is MemoryFile & { content: string } =>
    f.content !== null && isMarkdown(f.rel) && f.content.length <= MEMORY_MAX_FILE_BYTES

  const keysByRel = new Map<string, string[]>()
  const knownKeys = new Set<string>(['memory'])
  for (const f of files) {
    const keys = keysFor(f, readable(f) ? parseMemoryFrontmatter(f.content).name : null)
    keysByRel.set(f.rel, keys)
    for (const k of keys) knownKeys.add(k)
  }

  const issues: MemoryHealthIssue[] = []
  const proseByRel = new Map<string, string[]>()
  for (const f of files) if (readable(f)) proseByRel.set(f.rel, proseLines(toLines(f.content)))

  for (const [rel, lines] of proseByRel) {
    for (const hit of findAll(lines, WIKI_LINK)) {
      const key = normalizeMemoryKey(hit.value)
      if (key === '' || knownKeys.has(key)) continue
      issues.push({
        kind: 'broken-link',
        rel,
        line: hit.line,
        column: hit.column,
        endColumn: hit.endColumn,
        message: `No memory named "${hit.value.trim()}"`,
      })
    }
  }

  const index = findMemoryIndex(files)
  if (index && readable(index)) {
    const linked = new Set<string>()
    for (const hit of findAll(proseByRel.get(index.rel) ?? [], MD_LINK)) {
      const target = linkTarget(hit.value)
      if (target === null) continue
      const resolved = names.has(target) ? target : names.has(`${target}.md`) ? `${target}.md` : null
      if (resolved) {
        linked.add(resolved)
        continue
      }
      if (dirs.has(target)) continue
      issues.push({
        kind: 'index-missing-file',
        rel: index.rel,
        line: hit.line,
        column: hit.column,
        endColumn: hit.endColumn,
        message: `Index links to "${target}", which does not exist`,
      })
    }
    const indexWikiKeys = new Set(
      findAll(proseByRel.get(index.rel) ?? [], WIKI_LINK).map((h) => normalizeMemoryKey(h.value)),
    )

    for (const f of files) {
      if (f.rel === index.rel || f.rel.includes('/') || !isMarkdown(f.rel)) continue
      if (linked.has(f.rel)) continue
      if ((keysByRel.get(f.rel) ?? []).some((k) => indexWikiKeys.has(k))) continue
      const firstLine = f.content === null ? '' : (toLines(f.content)[0] ?? '')
      issues.push({
        kind: 'unindexed-file',
        rel: f.rel,
        line: 1,
        column: 1,
        endColumn: Math.max(2, firstLine.length + 1),
        message: `Not linked from ${index.rel}`,
      })
    }
  }

  return issues.sort((a, b) =>
    a.rel === b.rel ? a.line - b.line || a.column - b.column : a.rel < b.rel ? -1 : 1,
  )
}
