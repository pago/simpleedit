/**
 * Pure helpers for the desktop Review Room (`components/review/`): how a
 * thread is labelled and filtered, how a layer's diff is cut into the
 * overview's reading order, and which row a line thread sits under.
 */
import type { ReviewMessage, ReviewReportLayer, ReviewThread, ReviewThreadAnchor } from '../../shared/review-room'
import type { ReviewVerdict } from '../../shared/review-room-ipc'
import type { DiffFile, DiffRow } from '../../shared/parseDiff'
import { parseLineRange, type PrReviewComment } from '../../shared/screenprs'
import { parseOverview, resolveRefPath, type OverviewReadingStep } from '../../shared/pr-overview'
import type { Briefing } from '../../shared/review-briefing'

export type Side = 'LEFT' | 'RIGHT'

// A deletion exists only in the old file, so it anchors to its old number on
// LEFT; additions and context lines anchor to their new number on RIGHT.
export const sideOf = (row: DiffRow): Side => (row.kind === 'del' ? 'LEFT' : 'RIGHT')
export const lineOn = (row: DiffRow, side: Side): number | undefined => (side === 'LEFT' ? row.oldNo : row.newNo)

// ── Labels ──────────────────────────────────────────────────────────────────

export interface OriginBadge {
  mark: string
  label: string
  tone: string
}

const SOURCE_LABEL = { triage: 'Screening', overview: 'Overview', deep: 'Deep review', author: 'Author' } as const

export function originBadge(t: ReviewThread): OriginBadge {
  const o = t.origin
  if (o.kind === 'github') return { mark: 'R', label: `@${o.author}`, tone: 'bg-emerald-500/15 text-emerald-300' }
  if (o.kind === 'user') return { mark: 'Y', label: 'You', tone: 'bg-zinc-700 text-zinc-200' }
  switch (o.source) {
    case 'triage':
      return { mark: 'S', label: SOURCE_LABEL.triage, tone: 'bg-orange-500/15 text-orange-300' }
    case 'overview':
      return { mark: 'O', label: SOURCE_LABEL.overview, tone: 'bg-teal-500/15 text-teal-300' }
    case 'deep':
      return { mark: 'D', label: SOURCE_LABEL.deep, tone: 'bg-blue-500/15 text-blue-300' }
    case 'author':
      return { mark: 'A', label: SOURCE_LABEL.author, tone: 'bg-amber-500/15 text-amber-300' }
  }
}

export function messageAuthor(t: ReviewThread, m: ReviewMessage, first: boolean): string {
  switch (m.author) {
    case 'user':
      return m.toAuthor ? 'You · to the PR author' : 'You'
    case 'companion':
      return 'Companion'
    case 'author':
      return 'PR author'
    case 'reviewer':
      return t.origin.kind === 'github' && first ? `@${t.origin.author}` : 'Reviewer'
    case 'tool':
      return t.origin.kind === 'finding' ? SOURCE_LABEL[t.origin.source] : 'SimpleEdit'
  }
}

/**
 * The item (what the thread is about: a finding, a reviewer's comments) and
 * the private conversation with the companion, each in order.
 */
export function splitMessages(t: ReviewThread): { item: ReviewMessage[]; conversation: ReviewMessage[] } {
  const sorted = [...t.messages].sort((a, b) => a.seq - b.seq)
  return {
    item: sorted.filter((m) => m.author === 'tool' || m.author === 'reviewer'),
    conversation: sorted.filter((m) => m.author !== 'tool' && m.author !== 'reviewer'),
  }
}

export function newestSeq(t: ReviewThread): number {
  return t.messages.reduce((max, m) => Math.max(max, m.seq), 0)
}

/** Something arrived that the user hasn't had on screen yet. */
export function hasUnreadMessages(t: ReviewThread): boolean {
  return t.messages.some((m) => m.author !== 'user' && m.seq > t.readSeq)
}

export function threadTitle(t: ReviewThread): string {
  const { item, conversation } = splitMessages(t)
  const first = item[0] ?? conversation[0]
  if (!first) return 'Your comment'
  const line = first.body.trim().split('\n')[0].replace(/^#+\s*/, '').replace(/\*\*/g, '')
  return line.length > 110 ? `${line.slice(0, 108)}…` : line
}

export function anchorLabel(anchor: ReviewThreadAnchor): string {
  if (anchor.kind === 'stack') return 'Whole stack'
  if (anchor.kind === 'pr') return `#${anchor.pr}`
  const lines = anchor.startLine === anchor.endLine ? `${anchor.startLine}` : `${anchor.startLine}-${anchor.endLine}`
  return `${anchor.path}:${lines}${anchor.side === 'LEFT' ? ' (deleted)' : ''}`
}

export function shortAnchorLabel(anchor: ReviewThreadAnchor): string {
  if (anchor.kind !== 'line') return anchor.kind === 'stack' ? 'stack' : 'PR'
  return `${anchor.path.split('/').pop()}:${anchor.endLine}`
}

/** What the stack map and the post bar show per layer. */
export interface LayerFigures {
  open: number
  toPost: number
  /** 0–1, absent without a reading order. */
  read?: number
  newCommits?: number
}

// ── Outline ─────────────────────────────────────────────────────────────────

export type OutlineFilter = 'open' | 'post' | 'done' | 'mine' | 'pre' | 'all'

export const OUTLINE_FILTERS: { key: OutlineFilter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'post', label: 'To post' },
  { key: 'done', label: 'Done' },
  { key: 'mine', label: 'Started by me' },
  { key: 'pre', label: 'Pre-existing' },
  { key: 'all', label: 'All' },
]

export function isPreExisting(t: ReviewThread): boolean {
  return t.origin.kind === 'finding' && t.origin.preExisting
}

export function matchesFilter(t: ReviewThread, filter: OutlineFilter, hasDraft: boolean): boolean {
  switch (filter) {
    case 'open':
      return t.status === 'open'
    case 'post':
      return hasDraft
    case 'done':
      return t.status === 'done'
    case 'mine':
      return t.origin.kind === 'user'
    case 'pre':
      return isPreExisting(t)
    case 'all':
      return true
  }
}

// ── Submitting ──────────────────────────────────────────────────────────────

/** Request changes when a blocking draft exists, Comment when any do, Approve otherwise. */
export function defaultVerdict(comments: readonly PrReviewComment[]): ReviewVerdict {
  if (comments.some((c) => c.severity === 'blocking')) return 'request_changes'
  return comments.length ? 'comment' : 'approve'
}

// ── The tour ────────────────────────────────────────────────────────────────

/** Stable across re-renders and re-runs of the same reading order. */
export function stepId(prNumber: number, index: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return `${prNumber}:${index}:${slug || 'step'}`
}

/** The overview's reading order, when it has one (older overviews don't). */
export function readingOrderOf(overviewText: string | undefined): OverviewReadingStep[] {
  return overviewText ? (parseOverview(overviewText).sections.readingOrder ?? []) : []
}

const REPORT_VERDICT: Record<ReviewReportLayer['verdict'], string> = { approve: 'Approve', comment: 'Comment', request_changes: 'Request changes' }

/** A submitted review as markdown, from what the submission recorded (the drafts are gone by then). */
export function reportMarkdown(report: readonly ReviewReportLayer[]): string {
  return report
    .map((layer) => {
      const comments = layer.comments.map((c) => {
        const where = c.reply ? 'reply' : c.path ? `${c.path}${c.line ? `:${c.startLine ? `${c.startLine}-` : ''}${c.line}` : ''}` : 'PR comment'
        return `- \`${where}\`${c.severity ? ` **${c.severity}:**` : ''} ${c.body.trim()}`
      })
      return [`## #${layer.number} — ${REPORT_VERDICT[layer.verdict]}`, ...(layer.summary.trim() ? ['', layer.summary.trim()] : []), ...(comments.length ? ['', ...comments] : [])].join('\n')
    })
    .join('\n\n')
}

/** The author's reading order as tour steps (refs already resolved against the layer's diff by main). */
export function briefingSteps(briefing: Briefing | undefined): OverviewReadingStep[] {
  return (briefing?.readingOrder ?? []).map((section) => ({
    title: section.title,
    summary: section.summary,
    refs: section.refs.map((ref) => ({
      path: ref.path,
      ...(ref.startLine ? { line: ref.endLine && ref.endLine !== ref.startLine ? `${ref.startLine}-${ref.endLine}` : String(ref.startLine) } : {}),
    })),
  }))
}

/**
 * Whose reading order the layer's tour follows: the independent overview's
 * once it ran, else the author's briefing, else none (path order).
 */
export function tourSteps(overviewText: string | undefined, briefing: Briefing | undefined): { steps: OverviewReadingStep[]; by: 'overview' | 'author' | null } {
  const fromOverview = readingOrderOf(overviewText)
  if (fromOverview.length) return { steps: fromOverview, by: 'overview' }
  const fromAuthor = briefingSteps(briefing)
  return fromAuthor.length ? { steps: fromAuthor, by: 'author' } : { steps: [], by: null }
}

/** A layer's tour steps as the outline lists them, and how many are ticked. */
export function readingProgress(prNumber: number, steps: readonly OverviewReadingStep[], readSteps: readonly string[]): { id: string; title: string; read: boolean }[] {
  const read = new Set(readSteps)
  return steps.map((s, i) => {
    const id = stepId(prNumber, i, s.title)
    return { id, title: s.title, read: read.has(id) }
  })
}

export interface LineRange {
  start: number
  end: number
}

const HUNK_NEW_START = /^@@ -\d+(?:,\d+)? \+(\d+)/

/**
 * The rows of `f` within `context` lines of any range (new-file numbers), with
 * a hunk row ahead of each run. `null` keeps the whole file. A deleted row has
 * no new number, so it counts as sitting just after the row before it.
 */
export function sliceFile(f: DiffFile, ranges: LineRange[] | null, context = 3): DiffFile {
  if (!ranges || f.binary) return f
  const rows: DiffRow[] = []
  let header = ''
  let lastNew = 0
  let lastIncluded = -2
  f.rows.forEach((row, i) => {
    if (row.kind === 'hunk') {
      header = row.text
      const start = HUNK_NEW_START.exec(row.text)
      lastNew = start ? Number(start[1]) - 1 : lastNew
      return
    }
    const pos = row.newNo ?? lastNew + 0.5
    if (row.newNo !== undefined) lastNew = row.newNo
    if (!ranges.some((r) => pos >= r.start - context && pos <= r.end + context)) return
    if (lastIncluded !== i - 1) rows.push({ kind: 'hunk', text: header })
    rows.push(row)
    lastIncluded = i
  })
  return {
    ...f,
    rows,
    additions: rows.filter((r) => r.kind === 'add').length,
    deletions: rows.filter((r) => r.kind === 'del').length,
  }
}

export interface TourStep {
  id: string
  title: string
  summary: string
  files: DiffFile[]
}

/**
 * The reading order with each step's referenced hunks, and the files no step
 * cites, which are always shown after it: a tour can't hide a file.
 */
export function buildTour(prNumber: number, steps: readonly OverviewReadingStep[], files: readonly DiffFile[]): { steps: TourStep[]; rest: DiffFile[] } {
  const paths = files.map((f) => f.path)
  const cited = new Set<string>()
  const tour = steps.map((step, index) => {
    const ranges = new Map<string, LineRange[] | null>()
    for (const ref of step.refs) {
      const path = resolveRefPath(paths, ref.path)
      if (!path) continue
      cited.add(path)
      const range = parseLineRange(ref.line)
      const prior = ranges.get(path)
      if (prior === null) continue
      if (!range) ranges.set(path, null)
      else ranges.set(path, [...(prior ?? []), range])
    }
    const stepFiles = files.filter((f) => ranges.has(f.path)).map((f) => sliceFile(f, ranges.get(f.path) ?? null))
    return { id: stepId(prNumber, index, step.title), title: step.title, summary: step.summary, files: stepFiles }
  })
  const shown = new Set<DiffRow>()
  for (const step of tour) for (const f of step.files) for (const row of f.rows) shown.add(row)
  const rest = files.flatMap((f) => {
    if (!cited.has(f.path)) return [f]
    const left = withoutRows(f, shown)
    return left ? [left] : []
  })
  return { steps: tour, rest }
}

/** `f` without the rows in `shown` (a hunk row ahead of each run left), or null when every row is shown. */
function withoutRows(f: DiffFile, shown: ReadonlySet<DiffRow>): DiffFile | null {
  const rows: DiffRow[] = []
  let header = ''
  let lastKept = -2
  f.rows.forEach((row, i) => {
    if (row.kind === 'hunk') {
      header = row.text
      return
    }
    if (shown.has(row)) return
    if (lastKept !== i - 1) rows.push({ kind: 'hunk', text: header })
    rows.push(row)
    lastKept = i
  })
  if (!rows.length) return null
  return { ...f, rows, additions: rows.filter((r) => r.kind === 'add').length, deletions: rows.filter((r) => r.kind === 'del').length }
}

export function byPath(files: readonly DiffFile[]): DiffFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path))
}

// ── Line threads ────────────────────────────────────────────────────────────

/** The thread sits under the last row it covers, on the head on screen. */
export function anchorEndsAt(anchor: ReviewThreadAnchor, prNumber: number, headSha: string, f: DiffFile, row: DiffRow): boolean {
  if (anchor.kind !== 'line' || anchor.pr !== prNumber || anchor.headSha !== headSha) return false
  if (anchor.path !== f.path || row.kind === 'hunk') return false
  return lineOn(row, anchor.side) === anchor.endLine
}

export interface Section {
  key: string
  files: DiffFile[]
}

/** Which section shows each of a layer's line threads: the first whose rows include its end line. */
export function placeThreads(threads: readonly ReviewThread[], prNumber: number, headSha: string, sections: readonly Section[]): Map<string, string> {
  const placed = new Map<string, string>()
  for (const t of threads) {
    for (const s of sections) {
      if (placed.has(t.id)) break
      if (s.files.some((f) => f.rows.some((row) => anchorEndsAt(t.anchor, prNumber, headSha, f, row)))) placed.set(t.id, s.key)
    }
  }
  return placed
}

const MAX_ANCHOR_TEXT = 8 * 1024
const CONTEXT_LINES = 3

/** The anchored rows and three rows either side, on `side`, read off the full file. */
export function anchorText(f: DiffFile, side: Side, from: number, to: number): { snippet: string; before: string; after: string } {
  const rows = f.rows.filter((r) => r.kind !== 'hunk' && lineOn(r, side) !== undefined)
  const pick = (lo: number, hi: number): string =>
    rows
      .filter((r) => {
        const n = lineOn(r, side) ?? 0
        return n >= lo && n <= hi
      })
      .map((r) => r.text)
      .join('\n')
      .slice(0, MAX_ANCHOR_TEXT)
  return {
    snippet: pick(from, to),
    before: pick(from - CONTEXT_LINES, from - 1),
    after: pick(to + 1, to + CONTEXT_LINES),
  }
}
