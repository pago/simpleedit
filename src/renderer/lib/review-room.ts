/**
 * Pure helpers for the Review Room, desktop (`components/review/`) and phone
 * (`web/`) alike: how a thread is labelled and filtered, what its card offers
 * and drafts, what a layer's submit posts, how a layer's diff is cut into the
 * overview's reading order, and which row a line thread sits under.
 */
import type { ReviewCloseReason, ReviewMessage, ReviewReportLayer, ReviewSeverity, ReviewThread, ReviewThreadAnchor } from '../../shared/review-room'
import type { ReviewLayerDiff, ReviewLayerInfo, ReviewVerdict } from '../../shared/review-room-ipc'
import type { DiffFile, DiffRow } from '../../shared/parseDiff'
import { DIFF_TRUNCATED_MARKER } from '../../shared/ipc-types'
import { truncateSnippet } from '../../shared/review-drafts'
import {
  anchorCounts,
  anchorsForHead,
  buildReviewPayload,
  commentableLines,
  parseLineRange,
  type PrReviewComment,
  type PrReviewCommentSource,
  type PrReviewDraft,
} from '../../shared/screenprs'
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

/** The outline's groups: whole-stack threads, then each layer's, bottom → top; empty ones left out. */
export function outlineGroups(threads: readonly ReviewThread[], layers: readonly ReviewLayerInfo[]): { key: string; label: string; items: ReviewThread[] }[] {
  return [
    { key: 'stack', label: 'Whole stack', items: threads.filter((t) => t.anchor.kind === 'stack') },
    ...layers.map((l) => ({
      key: l.url,
      label: `#${l.number}`,
      items: threads.filter((t) => t.anchor.kind !== 'stack' && t.anchor.pr === l.number),
    })),
  ].filter((g) => g.items.length)
}

export function outlineStatus(t: ReviewThread, hasDraft: boolean): string {
  if (t.status === 'done') return hasDraft ? 'done · will post' : 'done'
  return hasDraft ? 'drafted' : 'open'
}

// ── Thread cards ────────────────────────────────────────────────────────────

/** A thread's draft as the room finds it: the draft store's `threadId` is the only link. */
export interface ThreadDraft {
  url: string
  comment: PrReviewComment
}

/**
 * Each of the review's threads' draft, across its layers' drafts. These are
 * exactly what main posts per layer (with its summary); other comments in a
 * layer's draft are left alone.
 */
export function reviewDrafts(threads: readonly ReviewThread[], layerUrls: readonly string[], draftFor: (url: string) => PrReviewDraft): Map<string, ThreadDraft> {
  const ids = new Set(threads.map((t) => t.id))
  const out = new Map<string, ThreadDraft>()
  for (const url of layerUrls) {
    for (const c of draftFor(url).comments) if (c.threadId && ids.has(c.threadId)) out.set(c.threadId, { url, comment: c })
  }
  return out
}

export const CLOSE_REASONS: { key: ReviewCloseReason; label: string }[] = [
  { key: 'fixed', label: 'Fixed' },
  { key: 'not-a-problem', label: 'Not a problem' },
  { key: 'intentional', label: 'Intentional' },
  { key: 'wont-fix', label: 'Won’t fix' },
]

const REASON_LABEL: Record<ReviewCloseReason, string> = {
  fixed: 'fixed',
  'not-a-problem': 'not a problem',
  intentional: 'intentional',
  'wont-fix': 'won’t fix',
}

export const SEVERITIES: ReviewSeverity[] = ['blocking', 'consider', 'nit']

export const REDRAFT_PROMPT =
  'Redraft my comment from our conversation: call propose_draft for this thread with the text (and severity) you would post. Don’t change anything else.'

/** An untouched finding shows as one line until opened. */
export function isFolded(t: ReviewThread, hasDraft: boolean): boolean {
  return t.origin.kind === 'finding' && t.status === 'open' && !hasDraft && splitMessages(t).conversation.length === 0 && !t.proposal
}

export function threadStatusLabel(t: ReviewThread, hasDraft: boolean): string {
  if (t.status === 'done') {
    return `done${t.closeReason ? ` · ${REASON_LABEL[t.closeReason]}` : ''} · ${hasDraft ? 'your comment will be posted' : 'nothing will be posted'}`
  }
  return hasDraft ? 'open · comment drafted' : 'open'
}

/** The question chips a thread offers, minus any already asked in it. */
export function threadChips(t: ReviewThread): { label: string; body: string }[] {
  const out: { label: string; body: string }[] = []
  const o = t.origin
  if (o.kind === 'github' || (o.kind === 'finding' && o.source === 'author')) {
    out.push({ label: 'Fact-check this', body: 'Fact-check this against the code: does it hold?' })
  }
  if (o.kind === 'finding' && o.source !== 'author') {
    out.push({ label: 'Is this real?', body: 'Is this a real problem?' })
    out.push({ label: 'Right severity?', body: o.severity ? `Is ${o.severity} the right severity?` : 'What severity is this, if any?' })
  }
  if (t.anchor.kind === 'line') out.push({ label: 'What depends on this?', body: 'What depends on this code, and what breaks if it is wrong?' })
  else out.push({ label: 'What is riskiest here?', body: 'What is the riskiest change here, and why?' })
  const asked = new Set(splitMessages(t).conversation.filter((m) => m.author === 'user').map((m) => m.body))
  return out.filter((c) => !asked.has(c.body))
}

/** The draft comment a thread starts: anchored like the thread, a reply on another reviewer's. */
export function threadDraft(t: ReviewThread, body: string, severity?: ReviewSeverity): Omit<PrReviewComment, 'id'> {
  const a = t.anchor
  const o = t.origin
  const source: PrReviewCommentSource = o.kind === 'finding' && o.source !== 'author' ? o.source : 'you'
  return {
    source,
    file: a.kind === 'line' ? a.path : '',
    text: body,
    threadId: t.id,
    ...(a.kind === 'line'
      ? {
          line: a.startLine === a.endLine ? String(a.startLine) : `${a.startLine}-${a.endLine}`,
          side: a.side,
          snippet: truncateSnippet(a.snippet),
          sha: a.headSha,
        }
      : {}),
    ...(o.kind === 'github' ? { inReplyTo: { threadNodeId: o.threadNodeId, rootCommentId: o.rootCommentId } } : {}),
    ...(severity && o.kind !== 'github' ? { severity } : {}),
  }
}

/** Where the thread's draft is posted, as its box heads it. */
export function draftWhere(t: ReviewThread): string {
  if (t.origin.kind === 'github') return `Reply on GitHub to @${t.origin.author}`
  const a = t.anchor
  if (a.kind === 'line') return `Your comment on #${a.pr} · ${a.path.split('/').pop()}:${a.endLine}`
  if (a.kind === 'pr') return `Your comment on #${a.pr}`
  return 'Your comment on'
}

// ── Submitting ──────────────────────────────────────────────────────────────

/** Request changes when a blocking draft exists, Comment when any do, Approve otherwise. */
export function defaultVerdict(comments: readonly PrReviewComment[]): ReviewVerdict {
  if (comments.some((c) => c.severity === 'blocking')) return 'request_changes'
  return comments.length ? 'comment' : 'approve'
}

/** A layer's comments that main posts: those of this review's threads. */
export function postedComments(draft: PrReviewDraft, threadIds: ReadonlySet<string>): PrReviewComment[] {
  return draft.comments.filter((c) => c.threadId !== undefined && threadIds.has(c.threadId))
}

/** Why a layer can't be posted yet: its diff isn't on screen at its current head, or only part of it is. */
export type UnreadReason = 'not-loaded' | 'truncated'

export function unreadReason(layer: ReviewLayerInfo, diff: ReviewLayerDiff | undefined): UnreadReason | null {
  if (!diff || diff.headSha !== layer.headSha) return 'not-loaded'
  // A diff cut to fit a socket was not read in full. The cut ends with the
  // marker; a PR that merely quotes it (a change to ipc-types.ts) is not cut.
  return diff.diff.trimEnd().endsWith(DIFF_TRUNCATED_MARKER) ? 'truncated' : null
}

/**
 * The head the user is reading, which main checks the layer against and pins
 * the review to. Null unless the whole diff is on screen at the layer's
 * current head: a diff that never loaded, one still being reloaded after a
 * push, or one cut short was not read at the head that would be posted.
 */
export function readHeadOf(layer: ReviewLayerInfo, diff: ReviewLayerDiff | undefined): string | null {
  return diff && unreadReason(layer, diff) === null ? diff.headSha : null
}

export interface LayerPreview {
  comments: PrReviewComment[]
  replies: number
  folded: number
  moved: number
  unverified: number
  unchecked: boolean
}

/**
 * What submitting the layer posts, from the same pure builder main posts with
 * (`ConfirmReviewModal` uses it too), so the preview can't drift.
 */
export function layerPreview(layer: ReviewLayerInfo, draft: PrReviewDraft, comments: PrReviewComment[], diff: ReviewLayerDiff | undefined): LayerPreview {
  const lineDraft = { ...draft, comments: comments.filter((c) => !c.inReplyTo) }
  const head = readHeadOf(layer, diff) ?? layer.headSha
  const base = diff?.base ?? layer.base
  const isolatedBase = base?.kind === 'polluted' && base.isolated
  // Only GitHub's own diff says which lines GitHub takes; an isolated one doesn't.
  const commentable = diff && !isolatedBase ? commentableLines(diff.diff) : undefined
  const payload = buildReviewPayload(anchorsForHead(lineDraft, head), { isolatedBase, commentable })
  const counts = anchorCounts(lineDraft, head)
  return {
    comments,
    replies: comments.length - lineDraft.comments.length,
    folded: lineDraft.comments.length - payload.comments.length,
    moved: counts.moved,
    unverified: counts.unverified,
    unchecked: !commentable && payload.comments.length > 0,
  }
}

/** Where a comment sits, as the submit preview and its markdown name it. */
export function commentWhere(c: PrReviewComment): string {
  if (c.inReplyTo) return 'reply'
  if (!c.file) return 'PR comment'
  return c.line ? `${c.file}:${c.line}` : c.file
}

const VERDICT_TEXT: Record<ReviewVerdict, string> = { approve: 'Approve', comment: 'Comment', request_changes: 'Request changes' }

/** The review about to be submitted as markdown, for a requester that is gone or a review kept off GitHub. */
export function draftsMarkdown(layers: readonly { number: number; title: string; verdict: ReviewVerdict; summary: string; comments: PrReviewComment[] }[]): string {
  return layers
    .map((l) => {
      const summary = l.summary.trim()
      const comments = l.comments.map((c) => `- \`${commentWhere(c)}\`${c.severity ? ` **${c.severity}:**` : ''} ${c.text.trim()}`)
      return [`## #${l.number} ${l.title} — ${VERDICT_TEXT[l.verdict]}`, ...(summary ? ['', summary] : []), ...(comments.length ? ['', ...comments] : [])].join('\n')
    })
    .join('\n\n')
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

/** A submitted review as markdown, from what the submission recorded (the drafts are gone by then). */
export function reportMarkdown(report: readonly ReviewReportLayer[]): string {
  return report
    .map((layer) => {
      const comments = layer.comments.map((c) => {
        const where = c.reply ? 'reply' : c.path ? `${c.path}${c.line ? `:${c.startLine ? `${c.startLine}-` : ''}${c.line}` : ''}` : 'PR comment'
        return `- \`${where}\`${c.severity ? ` **${c.severity}:**` : ''} ${c.body.trim()}`
      })
      return [`## #${layer.number} — ${VERDICT_TEXT[layer.verdict]}`, ...(layer.summary.trim() ? ['', layer.summary.trim()] : []), ...(comments.length ? ['', ...comments] : [])].join('\n')
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
