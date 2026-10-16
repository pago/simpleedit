/**
 * The author's briefing (`request_review(…, briefing)`, plan §4a): what the
 * requesting agent says about its own PR. It is untrusted input from an agent,
 * so it is rebuilt field by field here, capped, and stripped of control
 * characters; unknown fields are dropped. Main then keeps only the refs that
 * resolve to a path in the layer's review diff and stamps the head it was
 * written for (`finishBriefing`).
 *
 * It is only ever rendered as markdown or passed to the overview as fenced
 * data, never typed into a PTY.
 */
import { resolveRefPath } from './pr-overview'

export interface BriefingRef {
  path: string
  startLine?: number
  endLine?: number
}

export interface BriefingSection {
  title: string
  summary: string
  refs: BriefingRef[]
}

export interface BriefingQuestion {
  path?: string
  line?: number
  text: string
}

export interface BriefingEvidence {
  command: string
  outputExcerpt: string
  exitCode?: number
}

export interface Briefing {
  what: string
  why: string
  impact: string
  readingOrder: BriefingSection[]
  openQuestions: BriefingQuestion[]
  evidence: BriefingEvidence[]
  /** The layer head the author wrote it for; after a push it is shown as written for an earlier head. */
  forHead: string
}

export interface AuthorBriefing {
  stack?: { summary: string }
  /** By PR url. */
  layers: Record<string, Briefing>
}

/** One layer's briefing as parsed from the tool input, before main checks its refs. */
export type BriefingDraft = Omit<Briefing, 'forHead'>

export interface ParsedBriefingInput {
  stack?: { summary: string }
  layers: Array<{ pr: number; briefing: BriefingDraft }>
  /** What the caps dropped, reported back to the agent. */
  notes: string[]
}

export const BRIEFING_LAYER_MAX_BYTES = 20 * 1024
export const BRIEFING_SECTIONS_MAX = 50
export const BRIEFING_QUESTIONS_MAX = 30
export const BRIEFING_EVIDENCE_MAX = 10
export const BRIEFING_EXCERPT_MAX = 4 * 1024
const PROSE_MAX = 4000
const TITLE_MAX = 200
const SUMMARY_MAX = 2000
const COMMAND_MAX = 1000
const PATH_MAX = 4096
const REFS_MAX = 10
const LAYERS_MAX = 100

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Control characters out (newlines and tabs stay), CRLF folded, cut at `max`. */
export function cleanBriefingText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const clean = value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, ' ')
    // Bidi overrides and zero-width characters would let a path or command display as something else.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

const line = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined

function cleanPath(value: unknown): string | undefined {
  const path = cleanBriefingText(value, PATH_MAX).replace(/^\.?\//, '')
  if (!path || path.includes('\n') || path.split('/').includes('..')) return undefined
  return path
}

function parseRef(raw: unknown): BriefingRef | null {
  if (!isObject(raw)) return null
  const path = cleanPath(raw.path)
  if (!path) return null
  const startLine = line(raw.start_line)
  const endLine = line(raw.end_line)
  if (startLine === undefined) return { path }
  return { path, startLine, endLine: endLine !== undefined && endLine >= startLine ? endLine : startLine }
}

function list(raw: unknown, max: number, what: string, notes: string[]): unknown[] {
  if (!Array.isArray(raw)) return []
  if (raw.length > max) notes.push(`Only the first ${max} ${what} were kept (${raw.length} sent).`)
  return raw.slice(0, max)
}

function parseLayer(raw: Fields, label: string, notes: string[]): BriefingDraft {
  const readingOrder = list(raw.reading_order, BRIEFING_SECTIONS_MAX, `reading-order sections of ${label}`, notes).flatMap(
    (entry): BriefingSection[] => {
      if (!isObject(entry)) return []
      const title = cleanBriefingText(entry.title, TITLE_MAX).replace(/\n+/g, ' ')
      const summary = cleanBriefingText(entry.summary, SUMMARY_MAX)
      if (!title && !summary) return []
      const refs = (Array.isArray(entry.refs) ? entry.refs.slice(0, REFS_MAX) : []).map(parseRef).filter((ref): ref is BriefingRef => ref !== null)
      return [{ title: title || 'Untitled', summary, refs }]
    },
  )
  const openQuestions = list(raw.open_questions, BRIEFING_QUESTIONS_MAX, `open questions of ${label}`, notes).flatMap(
    (entry): BriefingQuestion[] => {
      const text = cleanBriefingText(isObject(entry) ? entry.text : entry, SUMMARY_MAX)
      if (!text) return []
      const path = isObject(entry) ? cleanPath(entry.path) : undefined
      const at = isObject(entry) && path ? line(entry.line) : undefined
      return [{ text, ...(path ? { path } : {}), ...(at !== undefined ? { line: at } : {}) }]
    },
  )
  const evidence = list(raw.evidence, BRIEFING_EVIDENCE_MAX, `evidence entries of ${label}`, notes).flatMap(
    (entry): BriefingEvidence[] => {
      if (!isObject(entry)) return []
      const command = cleanBriefingText(entry.command, COMMAND_MAX)
      if (!command) return []
      const exitCode = typeof entry.exit_code === 'number' && Number.isSafeInteger(entry.exit_code) ? entry.exit_code : undefined
      return [{
        command,
        outputExcerpt: cleanBriefingText(entry.output_excerpt, BRIEFING_EXCERPT_MAX),
        ...(exitCode !== undefined ? { exitCode } : {}),
      }]
    },
  )
  const draft: BriefingDraft = {
    what: cleanBriefingText(raw.what, PROSE_MAX),
    why: cleanBriefingText(raw.why, PROSE_MAX),
    impact: cleanBriefingText(raw.impact, PROSE_MAX),
    readingOrder,
    openQuestions,
    evidence,
  }
  const bytes = new TextEncoder().encode(JSON.stringify(draft)).length
  if (bytes > BRIEFING_LAYER_MAX_BYTES) {
    throw new Error(`The briefing for ${label} is ${bytes} bytes; the limit is ${BRIEFING_LAYER_MAX_BYTES}. Shorten it.`)
  }
  return draft
}

const isEmpty = (draft: BriefingDraft): boolean =>
  !draft.what && !draft.why && !draft.impact && !draft.readingOrder.length && !draft.openQuestions.length && !draft.evidence.length

/**
 * The tool's `briefing` argument: either one layer's fields at the top level
 * (for `requestedPr`), or `layers: [{pr, …}]` plus an optional stack `summary`.
 * Throws on a shape it can't read; caps what is too long.
 */
export function parseBriefingInput(raw: unknown, requestedPr: number): ParsedBriefingInput {
  if (raw === undefined || raw === null) return { layers: [], notes: [] }
  if (!isObject(raw)) throw new Error('briefing must be an object')
  const notes: string[] = []
  const summary = cleanBriefingText(raw.summary, PROSE_MAX)
  const layers: ParsedBriefingInput['layers'] = []
  const seen = new Set<number>()
  if (raw.layers !== undefined) {
    if (!Array.isArray(raw.layers)) throw new Error('briefing.layers must be an array')
    for (const entry of raw.layers.slice(0, LAYERS_MAX)) {
      if (!isObject(entry)) throw new Error('Each briefing layer must be an object')
      const pr = line(entry.pr)
      if (pr === undefined) throw new Error('Each briefing layer needs `pr` (its PR number)')
      if (seen.has(pr)) throw new Error(`briefing.layers names #${pr} twice`)
      seen.add(pr)
      const briefing = parseLayer(entry, `#${pr}`, notes)
      if (!isEmpty(briefing)) layers.push({ pr, briefing })
    }
  } else {
    const briefing = parseLayer(raw, `#${requestedPr}`, notes)
    if (!isEmpty(briefing)) layers.push({ pr: requestedPr, briefing })
  }
  return { ...(summary ? { stack: { summary } } : {}), layers, notes }
}

/**
 * Keep only refs and question paths that resolve to one path of the layer's
 * review diff (models shorten paths, so the `resolveRefPath` rule), and stamp
 * the head. Returns what was dropped, for the tool's answer.
 */
export function finishBriefing(draft: BriefingDraft, diffPaths: readonly string[], forHead: string): { briefing: Briefing; dropped: number } {
  let dropped = 0
  const resolve = (path: string): string | undefined => {
    const hit = resolveRefPath(diffPaths, path)
    if (!hit) dropped++
    return hit
  }
  const readingOrder = draft.readingOrder.map((section) => ({
    ...section,
    refs: section.refs.flatMap((ref): BriefingRef[] => {
      const path = resolve(ref.path)
      return path ? [{ ...ref, path }] : []
    }),
  }))
  const openQuestions = draft.openQuestions.map((question): BriefingQuestion => {
    if (!question.path) return question
    const path = resolve(question.path)
    return path ? { ...question, path } : { text: question.text }
  })
  return { briefing: { ...draft, readingOrder, openQuestions, forHead }, dropped }
}

/** The briefing as markdown for the overview's input; the caller fences it. */
export function renderBriefingMarkdown(briefing: Briefing, stackSummary?: string): string {
  const out: string[] = []
  if (stackSummary) out.push('## Stack', stackSummary, '')
  if (briefing.what) out.push('## What changed', briefing.what, '')
  if (briefing.why) out.push('## Why', briefing.why, '')
  if (briefing.impact) out.push('## Impact', briefing.impact, '')
  if (briefing.readingOrder.length) {
    out.push('## Reading order')
    briefing.readingOrder.forEach((section, index) => {
      const refs = section.refs.map((ref) => (ref.startLine ? `${ref.path}:${ref.startLine}${ref.endLine && ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}` : ref.path))
      out.push(`${index + 1}. ${section.title}${refs.length ? ` (${refs.join(', ')})` : ''}${section.summary ? `: ${section.summary}` : ''}`)
    })
    out.push('')
  }
  if (briefing.openQuestions.length) {
    out.push('## Open questions')
    for (const question of briefing.openQuestions) {
      out.push(`- ${question.path ? `${question.path}${question.line ? `:${question.line}` : ''}: ` : ''}${question.text}`)
    }
    out.push('')
  }
  out.push('## Evidence the author reports')
  if (!briefing.evidence.length) out.push('(none)')
  for (const entry of briefing.evidence) {
    out.push(`- \`${entry.command}\`${entry.exitCode !== undefined ? ` (exit ${entry.exitCode})` : ''}`)
    if (entry.outputExcerpt) out.push('  Output excerpt:', ...entry.outputExcerpt.split('\n').map((text) => `    ${text}`))
  }
  return out.join('\n').trim()
}
