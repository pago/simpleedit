/**
 * PR Overview — the parser for the model's fixed-section markdown answer.
 *
 * The contract fixes four headings (`## What changed`, `## Why`, `## Impact`,
 * `## Look into`), the last a numbered list of questions with backticked
 * `path:line` citations. Code renders the facts and the actions; the model only
 * writes the prose inside these sections. Anything the parser cannot place with
 * confidence sets `wellFormed: false`, and the caller renders `raw` as one block
 * so no output is ever lost. Pure, so the renderer re-parses cached raw text and
 * parser fixes apply retroactively.
 */

export interface OverviewRef {
  path: string
  /** `"12"` or `"12-18"`, in the shape `parseLineAnchor` reads. */
  line?: string
}

export interface OverviewLookIntoItem {
  markdown: string
  refs: OverviewRef[]
}

export interface OverviewSections {
  what?: string
  why?: string
  impact?: string
  lookInto?: OverviewLookIntoItem[]
}

/**
 * Facts about the PR the overview header shows, gathered by code alongside the
 * model's text (author, reviews and CI are already on the PR context).
 */
export interface OverviewFacts {
  draft: boolean
  /** `base`: none here, but the PR is stacked and the lower layer may carry it. */
  changeset: 'yes' | 'no' | 'base'
  /** The lower layer, as `#N` or its branch, when `changeset` is `base`. */
  changesetBase?: string
}

export type OverviewStatus = 'idle' | 'running' | 'done' | 'error'

/** A PR's overview: the raw markdown (parsed on render) and the facts it came with. */
export interface OverviewState {
  status: OverviewStatus
  text?: string
  facts?: OverviewFacts
  /** The head the overview's citations were read off. */
  headSha?: string
  error?: string
}

export interface ParsedOverview {
  sections: OverviewSections
  raw: string
  wellFormed: boolean
}

type SectionKey = keyof OverviewSections

const SECTION_KEYS: SectionKey[] = ['what', 'why', 'impact', 'lookInto']

/**
 * Heading text (lower-cased, colon and closing hashes stripped) → section. The
 * aliases are the `/pr-overview` skill's own headings, which a prompt override
 * modelled on the skill is likely to reproduce.
 */
const HEADINGS: Record<string, SectionKey> = {
  'what changed': 'what',
  why: 'why',
  impact: 'impact',
  'impact / public api': 'impact',
  'look into': 'lookInto',
  'what to look into': 'lookInto',
  'what to look into in more detail': 'lookInto',
}

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

function headingKey(text: string): SectionKey | undefined {
  const normalized = text
    .replace(/[ \t]+#+$/, '')
    .replace(/:$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return HEADINGS[normalized]
}

/** A model that wraps its whole answer in one ```markdown fence still followed the contract. */
function unwrapFence(text: string): string {
  const m = /^(`{3,}|~{3,})[ \t]*(?:markdown|md)?[ \t]*\n([\s\S]*?)\n\1[ \t]*$/i.exec(text)
  return m ? m[2] : text
}

export function parseOverview(text: string): ParsedOverview {
  const raw = text
  const lines = unwrapFence(text.replace(/\r\n?/g, '\n').trim()).split('\n')
  const bodies = new Map<SectionKey, string[]>()
  let current: string[] | null = null
  let wellFormed = true
  let fence: string | null = null

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
    } else if (fenceMatch) {
      fence = fenceMatch[1]
    } else {
      const heading = HEADING_RE.exec(line)
      const key = heading && heading[1].length <= 3 ? headingKey(heading[2]) : undefined
      if (key) {
        if (bodies.has(key)) wellFormed = false
        current = []
        bodies.set(key, current)
        continue
      }
      // A deeper heading inside a section is the model structuring its prose;
      // an unknown top-level one is a section the contract doesn't have.
      if (heading && heading[1].length <= 2) wellFormed = false
    }
    if (current) current.push(line)
    else if (line.trim()) wellFormed = false // preamble
  }

  const sections: OverviewSections = {}
  for (const key of SECTION_KEYS) {
    const body = bodies.get(key)
    if (!body) {
      wellFormed = false
      continue
    }
    const markdown = body.join('\n').trim()
    if (key === 'lookInto') {
      const list = parseLookInto(markdown)
      sections.lookInto = list.items
      if (!list.clean) wellFormed = false
    } else {
      sections[key] = markdown
    }
  }
  return { sections, raw, wellFormed }
}

const ORDERED_ITEM_RE = /^ ?(\d{1,3})[.)][ \t]+(.*)$/
const BULLET_ITEM_RE = /^ ?[-*+][ \t]+(.*)$/

/**
 * Split the Look-into section into its list items. The first item decides the
 * marker kind, so a nested `-` list inside a numbered item stays part of that
 * item. `clean` is false when text sits outside any item — a lead-in sentence,
 * or an unindented paragraph after a blank line, which ends the list in
 * CommonMark — since the item list alone would silently drop it.
 */
function parseLookInto(markdown: string): { items: OverviewLookIntoItem[]; clean: boolean } {
  const items: string[][] = []
  let kind: 'ordered' | 'bullet' | null = null
  let clean = true
  let fence: string | null = null
  let prevBlank = false

  for (const line of markdown ? markdown.split('\n') : []) {
    const fenceMatch = FENCE_RE.exec(line)
    const item = items.at(-1)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
      item?.push(line)
      continue
    }
    const ordered: RegExpExecArray | null = kind !== 'bullet' ? ORDERED_ITEM_RE.exec(line) : null
    const bullet: RegExpExecArray | null = kind !== 'ordered' && !ordered ? BULLET_ITEM_RE.exec(line) : null
    const content = ordered ? ordered[2] : bullet ? bullet[1] : null
    if (content !== null) {
      kind ??= ordered ? 'ordered' : 'bullet'
      items.push([content])
    } else if (item && (!prevBlank || !line.trim() || /^\s/.test(line))) {
      item.push(line.replace(/^ {1,4}/, ''))
    } else if (line.trim()) {
      clean = false
    }
    if (fenceMatch) fence = fenceMatch[1]
    prevBlank = !line.trim()
  }

  return {
    items: items.map((lines) => {
      const md = lines.join('\n').trim()
      return { markdown: md, refs: extractRefs(md) }
    }),
    clean,
  }
}

/**
 * File extensions that make a slash-less token a file (`package.json`,
 * `CLAUDE.md`) rather than an identifier (`Array.from`, `store.get`).
 */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'svelte', 'vue', 'json', 'jsonc', 'md', 'mdx',
  'yml', 'yaml', 'toml', 'css', 'scss', 'less', 'html', 'svg', 'py', 'rs', 'go', 'java', 'kt', 'swift',
  'rb', 'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sh', 'sql', 'graphql', 'proto', 'xml', 'txt', 'lock',
])

/** `path`, `path:12`, `path:12-18` / `12–18`, `path:12:5` (column dropped), `path#L12-L18`. */
const REF_RE = /^([\w@~+.\-/[\]]+?)(?::(\d+)(?:[-–](\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)?$/

/**
 * Whether a token names a file rather than an identifier (`Array.from`), a
 * branch (`origin/main`) or a host (`localhost:3000`). An extension decides it
 * when the token also has a slash or a line; a bare name needs a known one.
 * Without an extension only a dotfile or a slashed path with a line qualifies.
 */
function isFilePath(path: string, hasLine: boolean): boolean {
  if (path.endsWith('/')) return false
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return (dot === 0 && name.length > 1) || (hasLine && path.includes('/'))
  const ext = name.slice(dot + 1).toLowerCase()
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return false
  return path.includes('/') || hasLine || FILE_EXTENSIONS.has(ext)
}

/**
 * Citations from the item's backticked code spans. A span may hold several,
 * comma- or space-separated. Only backticked text counts: prose mentioning a
 * file by name is not a jump target.
 */
export function extractRefs(markdown: string): OverviewRef[] {
  const refs: OverviewRef[] = []
  const seen = new Set<string>()
  for (const span of markdown.matchAll(/(`+)([^`]+?)\1(?!`)/g)) {
    for (const token of span[2].split(/[\s,]+/)) {
      const ref = parseRef(token)
      if (!ref) continue
      const id = `${ref.path}:${ref.line ?? ''}`
      if (seen.has(id)) continue
      seen.add(id)
      refs.push(ref)
    }
  }
  return refs
}

function parseRef(token: string): OverviewRef | null {
  const m = REF_RE.exec(token.replace(/^\.\//, ''))
  if (!m) return null
  const [, path, colonStart, colonEnd, hashStart, hashEnd] = m
  const start = colonStart ?? hashStart
  const end = colonEnd ?? hashEnd
  if (!isFilePath(path, start !== undefined)) return null
  if (start === undefined) return { path }
  return { path, line: end !== undefined && end !== start ? `${start}-${end}` : start }
}

/**
 * The diff path a citation means. Exact first; otherwise the one diff path that
 * ends with the cited path, because a model sometimes shortens
 * `packages/ui/src/Table/body.tsx` to `Table/body.tsx`. Ambiguous or absent
 * matches resolve to nothing rather than to a guess.
 */
export function resolveRefPath(paths: readonly string[], cited: string): string | undefined {
  if (paths.includes(cited)) return cited
  const matches = paths.filter((p) => p.endsWith(`/${cited}`))
  return matches.length === 1 ? matches[0] : undefined
}
