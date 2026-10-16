import { parseUnifiedDiff, type DiffFile } from '../shared/parseDiff'
import { parseLineRange } from '../shared/screenprs'
import type { ConventionalCommentLabel } from '../shared/ipc-types'
import {
  fitReviewBody,
  newReviewMessageId,
  type ReviewChange,
  type ReviewFindingSource,
  type ReviewSeverity,
  type ReviewThread,
  type ReviewThreadAnchor,
} from '../shared/review-room'
import { getDb, transaction } from './db'
import {
  addMainReviewThread,
  appendReviewMessage,
  getReview,
  removeMainReviewThread,
  threadsForReview,
  updateMainReviewThread,
} from './review-room-store'

const CONTEXT_LINES = 3

export interface FindingToMaterialise {
  /**
   * The tool's id for the finding. Only matches a finding that has no snippet to
   * place it by (PR-level, or lines outside the diff); a re-run may mint new ones.
   */
  key: string
  file: string
  line?: string
  title: string
  detail?: string
  severity?: ReviewSeverity
  lens?: string
  preExisting?: boolean
}

export interface MaterialiseFindingsInput {
  reviewId: string
  pr: number
  headSha: string
  source: ReviewFindingSource
  diff: string
  findings: FindingToMaterialise[]
  /** Thread ids currently linked by a draft. The draft store remains authoritative. */
  draftThreadIds?: ReadonlySet<string>
}

export interface MaterialiseFindingsResult {
  changes: ReviewChange[]
  threadIds: string[]
}

interface NewSideLine {
  text: string
  line: number
  changed: boolean
  hunk: number
}

function newSide(file: DiffFile): NewSideLine[] {
  const out: NewSideLine[] = []
  let hunk = -1
  for (const row of file.rows) {
    if (row.kind === 'hunk') {
      hunk++
      continue
    }
    if (row.kind === 'del' || row.newNo === undefined) continue
    out.push({
      text: row.text,
      line: row.newNo,
      changed: row.kind === 'add',
      hunk,
    })
  }
  return out
}

function lineRows(file: DiffFile, start: number, end: number): NewSideLine[] {
  return newSide(file).filter((row) => row.line >= start && row.line <= end)
}

function contextNear(lines: NewSideLine[], selected: NewSideLine[], direction: 'before' | 'after'): string {
  if (!selected.length) return ''
  const hunk = selected[0]!.hunk
  const first = lines.indexOf(selected[0]!)
  const last = lines.indexOf(selected[selected.length - 1]!)
  const context =
    direction === 'before' ? lines.slice(Math.max(0, first - CONTEXT_LINES), first) : lines.slice(last + 1, last + 1 + CONTEXT_LINES)
  return context
    .filter((row) => row.hunk === hunk)
    .map((row) => row.text)
    .join('\n')
}

function findingAnchor(pr: number, headSha: string, finding: FindingToMaterialise, files: DiffFile[]): ReviewThreadAnchor {
  const file = files.find((candidate) => candidate.path === finding.file || candidate.oldPath === finding.file)
  const range = parseLineRange(finding.line)
  if (!file || !range) return { kind: 'pr', pr }
  const lines = newSide(file)
  const selected = lineRows(file, range.start, range.end)
  if (!selected.length) {
    return {
      kind: 'line',
      pr,
      headSha,
      path: file.path,
      side: 'RIGHT',
      startLine: range.start,
      endLine: range.end,
      snippet: '',
      before: '',
      after: '',
    }
  }
  return {
    kind: 'line',
    pr,
    headSha,
    path: file.path,
    side: 'RIGHT',
    startLine: selected[0]!.line,
    endLine: selected[selected.length - 1]!.line,
    snippet: selected.map((row) => row.text).join('\n'),
    before: contextNear(lines, selected, 'before'),
    after: contextNear(lines, selected, 'after'),
  }
}

/** Cited lines that are context rows of the layer's diff, or a file outside it. A finding citing no line is the PR's own. */
function preExisting(finding: FindingToMaterialise, anchor: ReviewThreadAnchor, files: DiffFile[]): boolean {
  if (finding.preExisting) return true
  if (!finding.file.trim()) return false
  if (!files.some((candidate) => candidate.path === finding.file || candidate.oldPath === finding.file)) return true
  if (anchor.kind !== 'line') return false
  const file = files.find((candidate) => candidate.path === anchor.path)
  if (!file) return true
  const selected = lineRows(file, anchor.startLine, anchor.endLine)
  return !selected.some((row) => row.changed)
}

function split(value: string): string[] {
  return value === '' ? [] : value.split(/\r?\n/)
}

function matchesAt(haystack: readonly string[], needle: readonly string[], at: number): boolean {
  if (!needle.length || at < 0 || at + needle.length > haystack.length) return false
  return needle.every((line, index) => haystack[at + index] === line)
}

function uniqueIndex(haystack: readonly string[], needle: readonly string[]): number | null {
  let found: number | null = null
  for (let index = 0; index + needle.length <= haystack.length; index++) {
    if (!matchesAt(haystack, needle, index)) continue
    if (found !== null) return null
    found = index
  }
  return found
}

function uniquelyLocates(
  old: Extract<ReviewThreadAnchor, { kind: 'line' }>,
  next: Extract<ReviewThreadAnchor, { kind: 'line' }>,
  file: DiffFile
): boolean {
  const rows = newSide(file)
  const text = rows.map((row) => row.text)
  const expected = rows.findIndex((row) => row.line === next.startLine)
  if (expected < 0) return false
  const before = split(old.before)
  const snippet = split(old.snippet)
  const after = split(old.after)
  if (before.length || after.length) {
    const located = uniqueIndex(text, [...before, ...snippet, ...after])
    if (located !== null) return located + before.length === expected
  }
  const located = uniqueIndex(text, snippet)
  return located !== null && located === expected
}

function wordSet(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
}

function titleSimilarity(a: string, b: string): number {
  const left = wordSet(a)
  const right = wordSet(b)
  if (!left.size || !right.size) return 0
  let common = 0
  for (const word of left) if (right.has(word)) common++
  return common / (left.size + right.size - common)
}

function findingBody(finding: FindingToMaterialise): string {
  return fitReviewBody(finding.detail?.trim() ? `${finding.title}\n\n${finding.detail}` : finding.title)
}

function itemTitle(thread: ReviewThread): string {
  return thread.messages[0]?.body.split('\n', 1)[0] ?? ''
}

/** A reworded re-run still shares most of its title's words. */
const SAME_TITLE = 0.5

/** Without a snippet: the same key, else the one clearly most similar title. */
function matchWithoutSnippet(threads: ReviewThread[], finding: FindingToMaterialise): ReviewThread | null {
  const byKey = threads.find((thread) => thread.origin.kind === 'finding' && thread.origin.key === finding.key)
  if (byKey) return byKey
  const scored = threads
    .map((thread) => ({ thread, score: titleSimilarity(itemTitle(thread), finding.title) }))
    .filter((entry) => entry.score >= SAME_TITLE)
    .sort((a, b) => b.score - a.score)
  if (!scored.length || (scored.length > 1 && scored[1]!.score === scored[0]!.score)) return null
  return scored[0]!.thread
}

function matchingThread(
  candidates: ReviewThread[],
  claimed: ReadonlySet<string>,
  anchor: ReviewThreadAnchor,
  finding: FindingToMaterialise,
  files: DiffFile[]
): ReviewThread | null {
  if (anchor.kind !== 'line') {
    if (anchor.kind !== 'pr') return null
    return matchWithoutSnippet(
      candidates.filter((thread) => !claimed.has(thread.id) && thread.anchor.kind === 'pr' && thread.anchor.pr === anchor.pr),
      finding,
    )
  }
  const file = files.find((candidate) => candidate.path === anchor.path)
  if (!file) return null
  const samePath = candidates.filter(
    (thread) => !claimed.has(thread.id) && thread.anchor.kind === 'line' && thread.anchor.pr === anchor.pr && thread.anchor.path === anchor.path,
  )
  if (!anchor.snippet) {
    return matchWithoutSnippet(samePath.filter((thread) => thread.anchor.kind === 'line' && !thread.anchor.snippet), finding)
  }
  const matches = samePath.filter((thread) => thread.anchor.kind === 'line' && !!thread.anchor.snippet && uniquelyLocates(thread.anchor, anchor, file))
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]!
  return [...matches].sort((a, b) => titleSimilarity(itemTitle(b), finding.title) - titleSimilarity(itemTitle(a), finding.title))[0]!
}

function hasConversation(thread: ReviewThread): boolean {
  return thread.messages.some((message, index) => index > 0 || message.author !== 'tool')
}

/**
 * Reconcile one source's latest result for one PR into review threads.
 * Matching is based on file + uniquely placed snippet; title similarity only
 * chooses among otherwise valid matches.
 */
export function materialiseFindings(input: MaterialiseFindingsInput, now = new Date()): MaterialiseFindingsResult {
  const review = getReview(input.reviewId)
  if (!review || review.status !== 'open') throw new Error('Review is not open')
  if (review.layers.find((layer) => layer.number === input.pr)?.headSha !== input.headSha) {
    throw new Error(`Findings for #${input.pr} are for a head this review no longer has`)
  }
  // All or nothing: a half-reconciled source would leave duplicates and unbroadcast changes.
  return transaction(getDb(), () => reconcile(input, now))
}

function reconcile(input: MaterialiseFindingsInput, now: Date): MaterialiseFindingsResult {
  const files = parseUnifiedDiff(input.diff)
  const candidates = threadsForReview(input.reviewId).filter(
    (thread) =>
      thread.origin.kind === 'finding' &&
      thread.origin.source === input.source &&
      thread.anchor.kind !== 'stack' &&
      thread.anchor.pr === input.pr
  )
  const claimed = new Set<string>()
  const changes: ReviewChange[] = []
  const threadIds: string[] = []

  for (const finding of input.findings) {
    const anchor = findingAnchor(input.pr, input.headSha, finding, files)
    const existing = matchingThread(candidates, claimed, anchor, finding, files)
    const origin = {
      kind: 'finding' as const,
      source: input.source,
      key: finding.key,
      ...(finding.severity ? { severity: finding.severity } : {}),
      ...(finding.lens ? { lens: finding.lens } : {}),
      preExisting: preExisting(finding, anchor, files),
    }
    const body = findingBody(finding)
    if (!existing) {
      const change = addMainReviewThread({ reviewId: input.reviewId, anchor, origin, author: 'tool', body }, now)
      changes.push(change)
      threadIds.push(change.threadId)
      continue
    }
    claimed.add(existing.id)
    threadIds.push(existing.id)
    const change = updateMainReviewThread(existing.id, { anchor, origin, outdated: false, itemBody: body }, now)
    if (change) changes.push(change)
    if (existing.status === 'done' && existing.closeReason) {
      const reportedBody = fitReviewBody(`Reported again: ${body}`)
      if (existing.messages.slice(1).at(-1)?.body !== reportedBody) {
        const reported = appendReviewMessage(existing.id, 'tool', reportedBody, { id: newReviewMessageId() }, now)
        if (reported) changes.push(reported)
      }
    }
  }

  for (const thread of candidates) {
    if (claimed.has(thread.id)) continue
    const keep =
      thread.closeReason !== undefined ||
      hasConversation(thread) ||
      input.draftThreadIds?.has(thread.id) === true ||
      thread.proposal !== undefined
    if (keep) {
      const change = updateMainReviewThread(thread.id, { outdated: true }, now)
      if (change) changes.push(change)
    } else {
      const change = removeMainReviewThread(thread.id, now)
      if (change) changes.push(change)
    }
  }

  return { changes, threadIds }
}

/** Triage emits issue, suggestion and question; a question proposes no severity. */
export function triageSeverity(label: ConventionalCommentLabel): ReviewSeverity | undefined {
  if (label === 'issue') return 'consider'
  if (label === 'nitpick' || label === 'suggestion') return 'nit'
  return undefined
}

export function deepSeverity(severity: string): ReviewSeverity | undefined {
  if (severity === 'blocking') return 'blocking'
  if (severity === 'concern') return 'consider'
  if (severity === 'note') return 'nit'
  return undefined
}
