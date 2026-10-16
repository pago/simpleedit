import type { DeliveryState, HeldReason } from './agent-threads'

export type ReviewStatus = 'open' | 'submitted' | 'discarded'
export type ReviewThreadStatus = 'open' | 'done'
export type ReviewCloseReason = 'fixed' | 'not-a-problem' | 'intentional' | 'wont-fix'
export type ReviewSeverity = 'blocking' | 'consider' | 'nit'
export type ReviewFindingSource = 'triage' | 'overview' | 'deep' | 'author'

export interface ReviewPrRef {
  url: string
  number: number
  headSha: string
}

export interface ReviewAgent {
  provider: string
  model: string
}

export interface ReviewCompanion {
  sessionId: string
  windowId: number
  agent: ReviewAgent
  claimRequestId: string
}

/** A draft comment that landed in the layer's pending review. */
export interface ReviewSubmissionItem {
  draftId: string
  /** `draftRev` of the draft comment as it was sent; a different one on retry means update it. */
  draftRev: string
  nodeId: string
  /** The REST id (`fullDatabaseId`, beyond Int32, so a string). */
  databaseId?: string
}

/**
 * One layer's posting progress, persisted as it goes so a retry resumes the
 * same pending review. The fields after `state` are absent on rows written
 * before GraphQL posting.
 */
export interface ReviewLayerSubmission {
  prUrl: string
  verdict: 'approve' | 'comment' | 'request_changes'
  reviewNodeId?: string
  /** Once posted: every draft comment id the review carried (lines, replies and folds), for `clear-posted`. */
  postedCommentIds: string[]
  state: 'pending' | 'posted' | 'failed' | 'unknown'
  /** The head the user read, which the review is pinned to. */
  readHead?: string
  /**
   * Written into the pending review's body before it is created, so a retry
   * after a timed-out create can recognise the review as its own.
   */
  claimToken?: string
  items?: ReviewSubmissionItem[]
  /** Draft ids GitHub refused on a line (or as a reply), now bound for the review body. */
  folded?: string[]
  reviewUrl?: string
  /** The pending review was one the user started on GitHub: discarding removes only SimpleEdit's comments from it. */
  adopted?: boolean
  /**
   * What the submit carried (each draft comment's `commentRev`), recorded just
   * before it is sent. A retry that finds the review already submitted clears
   * only these, so a comment edited since stays in the draft.
   */
  sent?: { comments: Array<{ draftId: string; rev: string }>; summary: string; verdict: 'approve' | 'comment' | 'request_changes' }
}

export interface ReviewSubmission {
  at: string
  destination: { session: boolean; github: boolean }
  layers: ReviewLayerSubmission[]
}

export interface Review {
  id: string
  repo: string
  layers: ReviewPrRef[]
  status: ReviewStatus
  requesterSessionId?: string
  requesterWindowId?: number
  companion?: ReviewCompanion
  companionAgent: ReviewAgent
  lastSeenHead: Record<string, string>
  readSteps: string[]
  round: number
  previousReviewId?: string
  submissions: ReviewSubmission[]
  createdAt: string
  updatedAt: string
}

export type ReviewThreadAnchor =
  | { kind: 'stack' }
  | { kind: 'pr'; pr: number }
  | {
      kind: 'line'
      pr: number
      headSha: string
      path: string
      side: 'LEFT' | 'RIGHT'
      startLine: number
      endLine: number
      snippet: string
      before: string
      after: string
    }

export type ReviewThreadOrigin =
  | {
      kind: 'finding'
      source: ReviewFindingSource
      key: string
      severity?: ReviewSeverity
      lens?: string
      preExisting: boolean
    }
  | {
      kind: 'github'
      threadNodeId: string
      rootCommentId: string
      author: string
      isResolved: boolean
    }
  | { kind: 'user' }

export interface ReviewMessage {
  id: string
  seq: number
  author: 'user' | 'companion' | 'author' | 'reviewer' | 'tool'
  body: string
  at: string
  readFiles?: string[]
  delivery?: DeliveryState
  heldReason?: HeldReason
  failedReason?: string
}

export interface ReviewThread {
  id: string
  reviewId: string
  anchor: ReviewThreadAnchor
  origin: ReviewThreadOrigin
  status: ReviewThreadStatus
  outdated: boolean
  closeReason?: ReviewCloseReason
  carriedFrom?: string
  readSeq: number
  askAuthorOpen: boolean
  messages: ReviewMessage[]
  proposal?: { text: string; severity?: ReviewSeverity }
  createdAt: string
  updatedAt: string
}

export type ReviewOp =
  | {
      kind: 'add-thread'
      thread: { id: string; anchor: ReviewThreadAnchor }
      /** Absent: a thread that only carries a draft, so nothing is asked of the companion. */
      message?: { id: string; body: string }
    }
  | { kind: 'append'; threadId: string; message: { id: string; body: string } }
  | {
      kind: 'set-status'
      threadId: string
      status: ReviewThreadStatus
      closeReason?: ReviewCloseReason
    }
  | { kind: 'remove-thread'; threadId: string }
  | { kind: 'mark-read'; threadId: string; seq: number }
  | { kind: 'clear-proposal'; threadId: string }

export interface ReviewSnapshot {
  reviews: Review[]
  threads: ReviewThread[]
  rev: number
}

/**
 * A thread's draft link is not part of it: `draft.threadId` in the review-draft
 * store is the only record, so clients read it from their draft mirror.
 */
export type ReviewChange = ReviewRecordChange | ReviewThreadChange

export interface ReviewRecordChange {
  reviewId: string
  review: Review | null
  rev: number
}

export interface ReviewThreadChange {
  reviewId: string
  threadId: string
  thread: ReviewThread | null
  rev: number
}

const REVIEW_ID = /^r_[A-Za-z0-9-]{6,64}$/
const THREAD_ID = /^rt_[A-Za-z0-9-]{6,64}$/
const MESSAGE_ID = /^rm_[A-Za-z0-9-]{6,64}$/
const MAX_ID = 67
export const REVIEW_MAX_BODY = 64 * 1024
const MAX_BODY = REVIEW_MAX_BODY
const MAX_PATH = 4096
const MAX_SNIPPET = 8 * 1024

type Fields = Record<string, unknown>

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function isSafePath(value: unknown): value is string {
  return isString(value, MAX_PATH) && !!value && !value.startsWith('/') && !value.split('/').includes('..')
}

export function isReviewId(value: unknown): value is string {
  return typeof value === 'string' && REVIEW_ID.test(value)
}

export function isReviewThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID.test(value)
}

export function isReviewMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID.test(value)
}

export function newReviewId(): string {
  return `r_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function newReviewThreadId(): string {
  return `rt_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function newReviewMessageId(): string {
  return `rm_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function parseReviewThreadAnchor(raw: unknown): ReviewThreadAnchor | null {
  if (!isObject(raw)) return null
  if (raw.kind === 'stack') return { kind: 'stack' }
  if (raw.kind === 'pr' && isLine(raw.pr)) return { kind: 'pr', pr: raw.pr }
  if (raw.kind !== 'line' || !isLine(raw.pr) || !isString(raw.headSha, 128) || !raw.headSha) return null
  if (!isSafePath(raw.path) || (raw.side !== 'LEFT' && raw.side !== 'RIGHT')) return null
  if (!isLine(raw.startLine) || !isLine(raw.endLine) || raw.endLine < raw.startLine) return null
  if (!isString(raw.snippet, MAX_SNIPPET) || !isString(raw.before, MAX_SNIPPET) || !isString(raw.after, MAX_SNIPPET)) return null
  return {
    kind: 'line',
    pr: raw.pr,
    headSha: raw.headSha,
    path: raw.path,
    side: raw.side,
    startLine: raw.startLine,
    endLine: raw.endLine,
    snippet: raw.snippet,
    before: raw.before,
    after: raw.after,
  }
}

function parseNewMessage(raw: unknown): { id: string; body: string } | null {
  if (!isObject(raw) || !isReviewMessageId(raw.id) || !isString(raw.body, MAX_BODY) || !raw.body.trim()) return null
  return { id: raw.id, body: raw.body }
}

function isCloseReason(value: unknown): value is ReviewCloseReason {
  return value === 'fixed' || value === 'not-a-problem' || value === 'intentional' || value === 'wont-fix'
}

/** Validate and rebuild an untrusted renderer/phone operation. */
export function parseReviewOp(raw: unknown): ReviewOp {
  if (!isObject(raw)) throw new Error('Malformed review op')
  switch (raw.kind) {
    case 'add-thread': {
      const thread = raw.thread
      const message = raw.message === undefined ? undefined : parseNewMessage(raw.message)
      if (!isObject(thread) || !isReviewThreadId(thread.id) || message === null) break
      const anchor = parseReviewThreadAnchor(thread.anchor)
      if (!anchor) break
      return { kind: raw.kind, thread: { id: thread.id, anchor }, ...(message ? { message } : {}) }
    }
    case 'append': {
      const message = parseNewMessage(raw.message)
      if (!isReviewThreadId(raw.threadId) || !message) break
      return { kind: raw.kind, threadId: raw.threadId, message }
    }
    case 'set-status': {
      if (!isReviewThreadId(raw.threadId) || (raw.status !== 'open' && raw.status !== 'done')) break
      if (raw.status === 'open') {
        if (raw.closeReason !== undefined) break
        return { kind: raw.kind, threadId: raw.threadId, status: raw.status }
      }
      if (raw.closeReason !== undefined && !isCloseReason(raw.closeReason)) break
      return {
        kind: raw.kind,
        threadId: raw.threadId,
        status: raw.status,
        ...(raw.closeReason === undefined ? {} : { closeReason: raw.closeReason }),
      }
    }
    case 'remove-thread':
      if (isReviewThreadId(raw.threadId)) return { kind: raw.kind, threadId: raw.threadId }
      break
    case 'mark-read':
      if (isReviewThreadId(raw.threadId) && typeof raw.seq === 'number' && Number.isSafeInteger(raw.seq) && raw.seq >= 0) {
        return { kind: raw.kind, threadId: raw.threadId, seq: raw.seq }
      }
      break
    case 'clear-proposal':
      if (isReviewThreadId(raw.threadId)) return { kind: raw.kind, threadId: raw.threadId }
      break
  }
  throw new Error('Malformed review op')
}

export function parseReviewOpRequest(raw: unknown): {
  reviewId: string
  op: ReviewOp
} {
  if (!isObject(raw) || !isReviewId(raw.reviewId)) throw new Error('Malformed review op request')
  return { reviewId: raw.reviewId, op: parseReviewOp(raw.op) }
}

export function parseReviewId(raw: unknown): string {
  if (!isReviewId(raw) || raw.length > MAX_ID) throw new Error('Malformed review id')
  return raw
}

/** Fits an agent's or GitHub's text into a review message, saying so when it was cut. */
export function fitReviewBody(body: string): string {
  if (body.length <= REVIEW_MAX_BODY) return body
  const note = '\n\n[SimpleEdit cut this message at its size limit.]'
  return `${body.slice(0, REVIEW_MAX_BODY - note.length)}${note}`
}
