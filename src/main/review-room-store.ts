import type { DeliveryState, HeldReason } from '../shared/agent-threads'
import {
  isReviewId,
  isReviewMessageId,
  isReviewThreadId,
  newReviewId,
  newReviewMessageId,
  newReviewThreadId,
  REVIEW_MAX_BODY,
  type Review,
  type ReviewAgent,
  type ReviewCloseReason,
  type ReviewCompanion,
  type ReviewMessage,
  type ReviewOp,
  type ReviewPrRef,
  type ReviewRecordChange,
  type ReviewSeverity,
  type ReviewSnapshot,
  type ReviewStatus,
  type ReviewSubmission,
  type ReviewThread,
  type ReviewThreadAnchor,
  type ReviewThreadOrigin,
  type ReviewThreadChange,
  type ReviewThreadStatus,
} from '../shared/review-room'
import { isPrUrl } from '../shared/screenprs'
import { getDb, transaction, type Db } from './db'

let rev = Date.now()

interface ReviewRow {
  id: string
  repo: string
  layers: string
  status: string
  requester_session_id: string | null
  requester_window_id: number | null
  companion: string | null
  companion_agent: string
  last_seen_head: string
  read_steps: string
  author_briefing: string | null
  round: number
  previous_review_id: string | null
  submissions: string
  created_at: string
  updated_at: string
}

interface ThreadRow {
  id: string
  review_id: string
  anchor: string
  origin: string
  status: string
  outdated: number
  close_reason: string | null
  carried_from: string | null
  read_seq: number
  ask_author_open: number
  proposal: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  thread_id: string
  seq: number
  author: string
  body: string
  at: string
  read_files: string | null
  delivery: string | null
  held_reason: string | null
  failed_reason: string | null
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown
}

function json<T>(raw: string): T {
  return parseJson(raw) as T
}

function toMessage(row: MessageRow): ReviewMessage {
  const message: ReviewMessage = {
    id: row.id,
    seq: row.seq,
    author: row.author as ReviewMessage['author'],
    body: row.body,
    at: row.at,
  }
  if (row.read_files) message.readFiles = json<string[]>(row.read_files)
  if (row.delivery) message.delivery = row.delivery as DeliveryState
  if (row.held_reason) message.heldReason = row.held_reason as HeldReason
  if (row.failed_reason) message.failedReason = row.failed_reason
  return message
}

function messagesOf(threadId: string, d = getDb()): ReviewMessage[] {
  const rows = d.prepare('SELECT * FROM review_messages WHERE thread_id = ? ORDER BY seq').all(threadId) as unknown as MessageRow[]
  return rows.map(toMessage)
}

function toThread(row: ThreadRow, messages: ReviewMessage[]): ReviewThread {
  const thread: ReviewThread = {
    id: row.id,
    reviewId: row.review_id,
    anchor: json<ReviewThreadAnchor>(row.anchor),
    origin: json<ReviewThreadOrigin>(row.origin),
    status: row.status as ReviewThreadStatus,
    outdated: row.outdated === 1,
    readSeq: row.read_seq,
    askAuthorOpen: row.ask_author_open === 1,
    messages,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.close_reason) thread.closeReason = row.close_reason as ReviewCloseReason
  if (row.carried_from) thread.carriedFrom = row.carried_from
  if (row.proposal) thread.proposal = json<NonNullable<ReviewThread['proposal']>>(row.proposal)
  return thread
}

function toReview(row: ReviewRow): Review {
  const review: Review = {
    id: row.id,
    repo: row.repo,
    layers: json<ReviewPrRef[]>(row.layers),
    status: row.status as ReviewStatus,
    companionAgent: json<ReviewAgent>(row.companion_agent),
    lastSeenHead: json<Record<string, string>>(row.last_seen_head),
    readSteps: json<string[]>(row.read_steps),
    round: row.round,
    submissions: json<ReviewSubmission[]>(row.submissions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.requester_session_id) review.requesterSessionId = row.requester_session_id
  if (row.requester_window_id !== null) review.requesterWindowId = row.requester_window_id
  if (row.companion) review.companion = json<ReviewCompanion>(row.companion)
  if (row.author_briefing) review.authorBriefing = parseJson(row.author_briefing)
  if (row.previous_review_id) review.previousReviewId = row.previous_review_id
  return review
}

export function getReview(id: string): Review | null {
  const row = getDb().prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined
  return row ? toReview(row) : null
}

export function getReviewThread(id: string): ReviewThread | null {
  const row = getDb().prepare('SELECT * FROM review_threads WHERE id = ?').get(id) as ThreadRow | undefined
  return row ? toThread(row, messagesOf(id)) : null
}

export function threadsForReview(reviewId: string): ReviewThread[] {
  const rows = getDb()
    .prepare('SELECT * FROM review_threads WHERE review_id = ? ORDER BY created_at, id')
    .all(reviewId) as unknown as ThreadRow[]
  return rows.map((row) => toThread(row, messagesOf(row.id)))
}

export function loadReviews(): ReviewSnapshot {
  const d = getDb()
  const reviews = (d.prepare('SELECT * FROM reviews ORDER BY created_at, id').all() as unknown as ReviewRow[]).map(toReview)
  const threadRows = d.prepare('SELECT * FROM review_threads ORDER BY created_at, id').all() as unknown as ThreadRow[]
  const messageRows = d.prepare('SELECT * FROM review_messages ORDER BY thread_id, seq').all() as unknown as MessageRow[]
  const messages = new Map<string, ReviewMessage[]>()
  for (const row of messageRows) {
    const list = messages.get(row.thread_id) ?? []
    list.push(toMessage(row))
    messages.set(row.thread_id, list)
  }
  return {
    reviews,
    threads: threadRows.map((row) => toThread(row, messages.get(row.id) ?? [])),
    rev,
  }
}

function changedReview(reviewId: string): ReviewRecordChange {
  rev++
  return { reviewId, review: getReview(reviewId), rev }
}

function changedThread(reviewId: string, threadId: string): ReviewThreadChange {
  rev++
  return { reviewId, threadId, thread: getReviewThread(threadId), rev }
}

function exists(d: Db, table: 'reviews' | 'review_threads' | 'review_messages', id: string): boolean {
  return d.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined
}

function tombstoned(d: Db, id: string): boolean {
  return d.prepare('SELECT 1 FROM review_tombstones WHERE id = ?').get(id) !== undefined
}

function validLayer(layer: ReviewPrRef): boolean {
  return isPrUrl(layer.url) && Number.isSafeInteger(layer.number) && layer.number > 0 && !!layer.headSha && layer.headSha.length <= 128
}

function anchorBelongsToReview(review: Review, anchor: ReviewThreadAnchor): boolean {
  if (anchor.kind === 'stack') return true
  const layer = review.layers.find((candidate) => candidate.number === anchor.pr)
  return !!layer && (anchor.kind !== 'line' || layer.headSha === anchor.headSha)
}

function validAgent(agent: ReviewAgent): boolean {
  return !!agent.provider && agent.provider.length <= 128 && !!agent.model && agent.model.length <= 256
}

function validSeverity(severity: unknown): severity is ReviewSeverity {
  return severity === 'blocking' || severity === 'consider' || severity === 'nit'
}

export interface CreateReviewInput {
  id?: string
  repo: string
  layers: ReviewPrRef[]
  companionAgent: ReviewAgent
  requesterSessionId?: string
  requesterWindowId?: number
  authorBriefing?: unknown
  round?: number
  previousReviewId?: string
}

/** Main-only review creation. */
export function createReview(input: CreateReviewInput, now = new Date()): ReviewRecordChange {
  const id = input.id ?? newReviewId()
  if (!isReviewId(id) || !input.repo || input.repo.length > 1024) throw new Error('Malformed review')
  if (!input.layers.length || input.layers.length > 100 || !input.layers.every(validLayer)) throw new Error('Malformed review layers')
  if (!validAgent(input.companionAgent)) throw new Error('Malformed companion agent')
  if (input.requesterSessionId !== undefined && (!input.requesterSessionId || input.requesterSessionId.length > 256)) {
    throw new Error('Malformed requester session')
  }
  if (input.requesterWindowId !== undefined && (!Number.isSafeInteger(input.requesterWindowId) || input.requesterWindowId < 1)) {
    throw new Error('Malformed requester window')
  }
  if (input.previousReviewId !== undefined && !isReviewId(input.previousReviewId)) throw new Error('Malformed previous review id')
  const round = input.round ?? 1
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('Malformed review round')
  const at = now.toISOString()
  const d = getDb()
  return transaction(d, () => {
    if (tombstoned(d, id) || exists(d, 'reviews', id)) throw new Error('Review id already used')
    d.prepare(
      `INSERT INTO reviews
       (id, repo, layers, status, requester_session_id, requester_window_id, companion, companion_agent,
        last_seen_head, read_steps, author_briefing, round, previous_review_id, submissions, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, NULL, ?, '{}', '[]', ?, ?, ?, '[]', ?, ?)`
    ).run(
      id,
      input.repo,
      JSON.stringify(input.layers),
      input.requesterSessionId ?? null,
      input.requesterWindowId ?? null,
      JSON.stringify(input.companionAgent),
      input.authorBriefing === undefined ? null : JSON.stringify(input.authorBriefing),
      round,
      input.previousReviewId ?? null,
      at,
      at
    )
    return changedReview(id)
  })
}

function insertMessage(d: Db, threadId: string, message: Omit<ReviewMessage, 'seq'>): void {
  const { seq } = d.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM review_messages WHERE thread_id = ?').get(threadId) as {
    seq: number
  }
  d.prepare(
    `INSERT INTO review_messages
     (id, thread_id, seq, author, body, at, read_files, delivery, held_reason, failed_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    message.id,
    threadId,
    seq,
    message.author,
    message.body,
    message.at,
    message.readFiles ? JSON.stringify(message.readFiles) : null,
    message.delivery ?? null,
    message.heldReason ?? null,
    message.failedReason ?? null
  )
}

function removeThread(d: Db, reviewId: string, threadId: string, at: string): ReviewThreadChange | null {
  const messageIds = d.prepare('SELECT id FROM review_messages WHERE thread_id = ?').all(threadId) as Array<{ id: string }>
  const removed = d.prepare('DELETE FROM review_threads WHERE id = ? AND review_id = ?').run(threadId, reviewId)
  if (!removed.changes) return null
  const stone = d.prepare('INSERT OR IGNORE INTO review_tombstones (id, at) VALUES (?, ?)')
  stone.run(threadId, at)
  for (const message of messageIds) stone.run(message.id, at)
  rev++
  return { reviewId, threadId, thread: null, rev }
}

export interface ReviewOpResult {
  change: ReviewThreadChange | null
  queued?: {
    reviewId: string
    threadId: string
    messageId: string
    sessionId?: string
  }
}

export function applyReviewOp(reviewId: string, op: ReviewOp, now = new Date()): ReviewOpResult {
  if (!isReviewId(reviewId)) throw new Error('Malformed review id')
  const at = now.toISOString()
  const d = getDb()
  return transaction(d, (): ReviewOpResult => {
    const review = getReview(reviewId)
    if (!review || review.status !== 'open') throw new Error('Review is not open')
    switch (op.kind) {
      case 'add-thread': {
        if (!anchorBelongsToReview(review, op.thread.anchor)) throw new Error('Thread anchor is not in this review')
        if (
          tombstoned(d, op.thread.id) ||
          tombstoned(d, op.message.id) ||
          exists(d, 'review_threads', op.thread.id) ||
          exists(d, 'review_messages', op.message.id)
        )
          return { change: null }
        d.prepare(
          `INSERT INTO review_threads
           (id, review_id, anchor, origin, status, outdated, close_reason, carried_from, read_seq,
            ask_author_open, proposal, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', 0, NULL, NULL, 0, 0, NULL, ?, ?)`
        ).run(op.thread.id, reviewId, JSON.stringify(op.thread.anchor), JSON.stringify({ kind: 'user' }), at, at)
        insertMessage(d, op.thread.id, {
          id: op.message.id,
          author: 'user',
          body: op.message.body,
          at,
          delivery: 'held',
          heldReason: 'not-running',
        })
        return {
          change: changedThread(reviewId, op.thread.id),
          queued: {
            reviewId,
            threadId: op.thread.id,
            messageId: op.message.id,
            ...(review.companion ? { sessionId: review.companion.sessionId } : {}),
          },
        }
      }
      case 'append': {
        const row = d.prepare('SELECT review_id FROM review_threads WHERE id = ?').get(op.threadId) as { review_id: string } | undefined
        if (!row || row.review_id !== reviewId || tombstoned(d, op.message.id) || exists(d, 'review_messages', op.message.id))
          return { change: null }
        insertMessage(d, op.threadId, {
          id: op.message.id,
          author: 'user',
          body: op.message.body,
          at,
          delivery: 'held',
          heldReason: 'not-running',
        })
        d.prepare(`UPDATE review_threads SET status = 'open', close_reason = NULL, updated_at = ? WHERE id = ?`).run(at, op.threadId)
        return {
          change: changedThread(reviewId, op.threadId),
          queued: {
            reviewId,
            threadId: op.threadId,
            messageId: op.message.id,
            ...(review.companion ? { sessionId: review.companion.sessionId } : {}),
          },
        }
      }
      case 'set-status': {
        const reason = op.status === 'done' ? op.closeReason ?? null : null
        const result = d
          .prepare(
            `UPDATE review_threads SET status = ?, close_reason = ?, updated_at = ?
             WHERE id = ? AND review_id = ? AND (status != ? OR close_reason IS NOT ?)`
          )
          .run(op.status, reason, at, op.threadId, reviewId, op.status, reason)
        return {
          change: result.changes ? changedThread(reviewId, op.threadId) : null,
        }
      }
      case 'mark-read': {
        const max = d.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM review_messages WHERE thread_id = ?').get(op.threadId) as {
          seq: number
        }
        const next = Math.min(op.seq, max.seq)
        const result = d
          .prepare('UPDATE review_threads SET read_seq = ? WHERE id = ? AND review_id = ? AND read_seq < ?')
          .run(next, op.threadId, reviewId, next)
        return {
          change: result.changes ? changedThread(reviewId, op.threadId) : null,
        }
      }
      case 'remove-thread':
        return { change: removeThread(d, reviewId, op.threadId, at) }
    }
  })
}

export interface ClaimCompanionResult {
  won: boolean
  companion?: ReviewCompanion
  change: ReviewRecordChange | null
}

/** Atomically assigns the single companion. Replaying the winning request is idempotent. */
export function claimCompanion(
  reviewId: string,
  windowId: number,
  requestId: string,
  sessionId?: string,
  agent?: ReviewAgent,
  now = new Date()
): ClaimCompanionResult {
  if (
    !isReviewId(reviewId) ||
    !Number.isSafeInteger(windowId) ||
    windowId < 1 ||
    !requestId || requestId.length > 256 ||
    (sessionId !== undefined && (!sessionId || sessionId.length > 256)) ||
    (agent !== undefined && !validAgent(agent)) ||
    (sessionId === undefined) !== (agent === undefined)
  )
    throw new Error('Malformed companion claim')
  const d = getDb()
  return transaction(d, () => {
    const current = getReview(reviewId)
    if (!current || current.status !== 'open') return { won: false, change: null }
    if (current.companion) {
      return {
        won: current.companion.claimRequestId === requestId,
        companion: current.companion,
        change: null,
      }
    }
    const chosenAgent = agent ?? current.companionAgent
    const companion: ReviewCompanion = {
      sessionId: sessionId ?? `agent-${chosenAgent.provider}-${crypto.randomUUID()}`,
      windowId,
      agent: chosenAgent,
      claimRequestId: requestId,
    }
    const result = d
      .prepare(
        `UPDATE reviews SET companion = ?, companion_session_id = ?, updated_at = ?
         WHERE id = ? AND status = 'open' AND companion IS NULL`
      )
      .run(JSON.stringify(companion), companion.sessionId, now.toISOString(), reviewId)
    return result.changes ? { won: true, companion, change: changedReview(reviewId) } : { won: false, change: null }
  })
}

export function clearCompanion(reviewId: string, sessionId: string, now = new Date()): ReviewRecordChange | null {
  const d = getDb()
  return transaction(d, () => {
    const review = getReview(reviewId)
    if (!review?.companion || review.companion.sessionId !== sessionId) return null
    const result = d
      .prepare('UPDATE reviews SET companion = NULL, companion_session_id = NULL, updated_at = ? WHERE id = ? AND companion = ?')
      .run(now.toISOString(), reviewId, JSON.stringify(review.companion))
    return result.changes ? changedReview(reviewId) : null
  })
}

export function appendReviewMessage(
  threadId: string,
  author: Exclude<ReviewMessage['author'], 'user'>,
  body: string,
  options: { id?: string; readFiles?: string[]; closeAskAuthor?: boolean } = {},
  now = new Date()
): ReviewThreadChange | null {
  const id = options.id ?? newReviewMessageId()
  if (!isReviewThreadId(threadId) || !isReviewMessageId(id) || !body.trim() || body.length > REVIEW_MAX_BODY)
    throw new Error('Malformed review message')
  const d = getDb()
  return transaction(d, () => {
    const row = d.prepare('SELECT review_id, ask_author_open FROM review_threads WHERE id = ?').get(threadId) as
      | { review_id: string; ask_author_open: number }
      | undefined
    if (!row || tombstoned(d, id) || exists(d, 'review_messages', id)) return null
    if (options.closeAskAuthor && row.ask_author_open !== 1) return null
    insertMessage(d, threadId, {
      id,
      author,
      body,
      at: now.toISOString(),
      ...(options.readFiles ? { readFiles: options.readFiles } : {}),
    })
    d.prepare('UPDATE review_threads SET updated_at = ?, ask_author_open = ? WHERE id = ?').run(
      now.toISOString(),
      options.closeAskAuthor ? 0 : row.ask_author_open,
      threadId,
    )
    return changedThread(row.review_id, threadId)
  })
}

export function setReviewProposal(threadId: string, text: string | null, severity?: ReviewSeverity, now = new Date()): ReviewThreadChange | null {
  if (
    !isReviewThreadId(threadId) ||
    (text !== null && (!text.trim() || text.length > 64 * 1024)) ||
    (severity !== undefined && !validSeverity(severity))
  )
    throw new Error('Malformed review proposal')
  const d = getDb()
  return transaction(d, () => {
    const row = d.prepare('SELECT review_id, proposal FROM review_threads WHERE id = ?').get(threadId) as
      | { review_id: string; proposal: string | null }
      | undefined
    if (!row) return null
    const proposal = text === null ? null : JSON.stringify({ text, ...(severity ? { severity } : {}) })
    if (proposal === row.proposal) return null
    d.prepare('UPDATE review_threads SET proposal = ?, updated_at = ? WHERE id = ?').run(proposal, now.toISOString(), threadId)
    return changedThread(row.review_id, threadId)
  })
}

export interface ReviewDeliveryPatch {
  delivery: DeliveryState
  heldReason?: HeldReason
  failedReason?: string
}

export function setReviewDelivery(messageIds: Iterable<string>, patch: ReviewDeliveryPatch): ReviewThreadChange[] {
  const d = getDb()
  return transaction(d, () => {
    const threads = new Map<string, string>()
    const statement = d.prepare(
      `UPDATE review_messages SET delivery = ?, held_reason = ?, failed_reason = ?
       WHERE id = ? AND author = 'user'
         AND (delivery IS NOT ? OR held_reason IS NOT ? OR failed_reason IS NOT ?)
       RETURNING thread_id`
    )
    const held = patch.heldReason ?? null
    const failed = patch.failedReason ?? null
    for (const id of messageIds) {
      const row = statement.get(patch.delivery, held, failed, id, patch.delivery, held, failed) as { thread_id: string } | undefined
      if (!row) continue
      const thread = d.prepare('SELECT review_id FROM review_threads WHERE id = ?').get(row.thread_id) as { review_id: string }
      threads.set(row.thread_id, thread.review_id)
    }
    return [...threads].map(([threadId, reviewId]) => changedThread(reviewId, threadId))
  })
}

export interface PendingReviewMessage {
  review: Review
  thread: ReviewThread
  message: ReviewMessage
}

const IN_STATES = (count: number): string => Array.from({ length: count }, () => '?').join(', ')

/**
 * The user messages of `sessionId`'s companion reviews in `states`. Indexed:
 * the delivery core asks this on every hook, status change and keystroke.
 */
export function reviewMessagesInState(sessionId: string, states: readonly DeliveryState[]): PendingReviewMessage[] {
  if (!states.length) return []
  const d = getDb()
  const rows = d
    .prepare(
      `SELECT m.thread_id AS thread_id, m.id AS message_id FROM reviews r
       JOIN review_threads t ON t.review_id = r.id
       JOIN review_messages m ON m.thread_id = t.id
       WHERE r.companion_session_id = ? AND m.author = 'user' AND m.delivery IN (${IN_STATES(states.length)})`
    )
    .all(sessionId, ...states) as Array<{ thread_id: string; message_id: string }>
  const out: PendingReviewMessage[] = []
  const threads = new Map<string, ReviewThread | null>()
  const reviews = new Map<string, Review | null>()
  for (const row of rows) {
    if (!threads.has(row.thread_id)) threads.set(row.thread_id, getReviewThread(row.thread_id))
    const thread = threads.get(row.thread_id)
    if (!thread) continue
    if (!reviews.has(thread.reviewId)) reviews.set(thread.reviewId, getReview(thread.reviewId))
    const review = reviews.get(thread.reviewId)
    const message = thread.messages.find((candidate) => candidate.id === row.message_id)
    if (review && message) out.push({ review, thread, message })
  }
  return out.sort((a, b) => a.message.at.localeCompare(b.message.at))
}

export function reviewSessionsWithMessagesIn(states: readonly DeliveryState[]): string[] {
  if (!states.length) return []
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT r.companion_session_id AS session_id FROM review_messages m
       JOIN review_threads t ON t.id = m.thread_id
       JOIN reviews r ON r.id = t.review_id
       WHERE m.author = 'user' AND m.delivery IN (${IN_STATES(states.length)}) AND r.companion_session_id IS NOT NULL`
    )
    .all(...states) as Array<{ session_id: string }>
  return rows.map((row) => row.session_id)
}

export function reviewHasMessagesInState(sessionId: string, states: readonly DeliveryState[]): boolean {
  if (!states.length) return false
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM reviews r
         JOIN review_threads t ON t.review_id = r.id
         JOIN review_messages m ON m.thread_id = t.id
         WHERE r.companion_session_id = ? AND m.author = 'user' AND m.delivery IN (${IN_STATES(states.length)})
         LIMIT 1`
      )
      .get(sessionId, ...states) !== undefined
  )
}

export function reviewsForSession(sessionId: string): Review[] {
  const rows = getDb()
    .prepare('SELECT * FROM reviews WHERE companion_session_id = ? OR requester_session_id = ? ORDER BY created_at, id')
    .all(sessionId, sessionId) as unknown as ReviewRow[]
  return rows.map(toReview)
}

export function isReviewCompanionSession(sessionId: string): boolean {
  return getDb().prepare('SELECT 1 FROM reviews WHERE companion_session_id = ? LIMIT 1').get(sessionId) !== undefined
}

export function closeAskAuthor(threadId: string, now = new Date()): ReviewThreadChange | null {
  const thread = getReviewThread(threadId)
  if (!thread?.askAuthorOpen) return null
  const result = getDb().prepare(
    'UPDATE review_threads SET ask_author_open = 0, updated_at = ? WHERE id = ? AND ask_author_open = 1',
  ).run(now.toISOString(), threadId)
  return result.changes ? changedThread(thread.reviewId, threadId) : null
}

export function setReviewStatus(
  reviewId: string,
  status: ReviewStatus,
  submissions?: ReviewSubmission[],
  now = new Date()
): ReviewRecordChange | null {
  const d = getDb()
  return transaction(d, () => {
    const review = getReview(reviewId)
    if (!review) return null
    const nextSubmissions = submissions ?? review.submissions
    if (review.status === status && submissions === undefined) return null
    d.prepare('UPDATE reviews SET status = ?, submissions = ?, updated_at = ? WHERE id = ?').run(
      status,
      JSON.stringify(nextSubmissions),
      now.toISOString(),
      reviewId
    )
    return changedReview(reviewId)
  })
}

/**
 * A carried message is history. One still in flight was asked of the previous
 * round's companion, so it must not be typed into the next one or wait for a
 * confirmation that can never come.
 */
function carriedDelivery(message: ReviewMessage, round: number): Pick<ReviewMessage, 'delivery' | 'heldReason' | 'failedReason'> {
  if (!message.delivery) return {}
  if (message.delivery === 'held' || message.delivery === 'sending' || message.delivery === 'delivered') {
    return { delivery: 'unanswered', failedReason: `Asked in round ${round} and not answered there` }
  }
  return {
    delivery: message.delivery,
    ...(message.heldReason ? { heldReason: message.heldReason } : {}),
    ...(message.failedReason ? { failedReason: message.failedReason } : {}),
  }
}

/**
 * A layer's head moved (a push). Only the recorded head changes: findings for
 * the new head can then be materialised, and the threads still on the old one
 * are re-resolved by the caller (§8), never silently relabelled.
 */
export function setReviewLayerHead(reviewId: string, pr: number, headSha: string, now = new Date()): ReviewRecordChange | null {
  if (!headSha || headSha.length > 128) throw new Error('Malformed head')
  const d = getDb()
  return transaction(d, () => {
    const review = getReview(reviewId)
    if (!review || review.status !== 'open') return null
    const layer = review.layers.find((candidate) => candidate.number === pr)
    if (!layer || layer.headSha === headSha) return null
    const layers = review.layers.map((candidate) => (candidate.number === pr ? { ...candidate, headSha } : candidate))
    d.prepare('UPDATE reviews SET layers = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(layers), now.toISOString(), reviewId)
    return changedReview(reviewId)
  })
}

export type CarryAnchor = (anchor: ReviewThreadAnchor, from: Review, to: Review) => ReviewThreadAnchor | null

/** Copy the threads that remain useful into a new review round. */
export function carryReviewThreads(previousReviewId: string, reviewId: string, reanchor: CarryAnchor, now = new Date()): ReviewThreadChange[] {
  const from = getReview(previousReviewId)
  const to = getReview(reviewId)
  if (!from || !to || to.previousReviewId !== from.id || to.round !== from.round + 1) throw new Error('Reviews are not consecutive rounds')
  const d = getDb()
  return transaction(d, () => {
    const changes: ReviewThreadChange[] = []
    const at = now.toISOString()
    for (const old of threadsForReview(from.id)) {
      if (old.status === 'done' && !old.closeReason) continue
      const placed = reanchor(old.anchor, from, to)
      const id = newReviewThreadId()
      const anchor = placed ?? old.anchor
      d.prepare(
        `INSERT INTO review_threads
         (id, review_id, anchor, origin, status, outdated, close_reason, carried_from, read_seq,
          ask_author_open, proposal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        to.id,
        JSON.stringify(anchor),
        JSON.stringify(old.origin),
        old.status,
        placed ? (old.outdated ? 1 : 0) : 1,
        old.closeReason ?? null,
        old.id,
        old.readSeq,
        0,
        old.proposal ? JSON.stringify(old.proposal) : null,
        at,
        at
      )
      for (const message of old.messages) {
        insertMessage(d, id, {
          id: newReviewMessageId(),
          author: message.author,
          body: message.body,
          at: message.at,
          ...(message.readFiles ? { readFiles: message.readFiles } : {}),
          ...carriedDelivery(message, from.round),
        })
      }
      changes.push(changedThread(to.id, id))
    }
    return changes
  })
}

export interface MainThreadInput {
  id?: string
  reviewId: string
  anchor: ReviewThreadAnchor
  origin: ReviewThreadOrigin
  author: ReviewMessage['author']
  body: string
  messageId?: string
  status?: ReviewThreadStatus
  outdated?: boolean
  closeReason?: ReviewCloseReason
  carriedFrom?: string
}

/** Main-only insertion for findings and imported GitHub threads. */
export function addMainReviewThread(input: MainThreadInput, now = new Date()): ReviewThreadChange {
  const id = input.id ?? newReviewThreadId()
  const messageId = input.messageId ?? newReviewMessageId()
  const review = getReview(input.reviewId)
  if (
    !isReviewThreadId(id) || !isReviewMessageId(messageId) || !review ||
    review.status !== 'open' || !anchorBelongsToReview(review, input.anchor)
  ) throw new Error('Malformed main review thread')
  const at = now.toISOString()
  const d = getDb()
  return transaction(d, () => {
    if (
      tombstoned(d, id) ||
      tombstoned(d, messageId) ||
      exists(d, 'review_threads', id) ||
      exists(d, 'review_messages', messageId)
    )
      throw new Error('Review thread id already used')
    d.prepare(
      `INSERT INTO review_threads
       (id, review_id, anchor, origin, status, outdated, close_reason, carried_from, read_seq,
        ask_author_open, proposal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)`
    ).run(
      id,
      input.reviewId,
      JSON.stringify(input.anchor),
      JSON.stringify(input.origin),
      input.status ?? 'open',
      input.outdated ? 1 : 0,
      input.closeReason ?? null,
      input.carriedFrom ?? null,
      at,
      at
    )
    insertMessage(d, id, {
      id: messageId,
      author: input.author,
      body: input.body,
      at,
    })
    return changedThread(input.reviewId, id)
  })
}

export function updateMainReviewThread(
  threadId: string,
  patch: Partial<Pick<ReviewThread, 'anchor' | 'origin' | 'outdated'>> & {
    itemBody?: string
  },
  now = new Date()
): ReviewThreadChange | null {
  const thread = getReviewThread(threadId)
  if (!thread) return null
  if (patch.anchor) {
    const review = getReview(thread.reviewId)
    if (!review || !anchorBelongsToReview(review, patch.anchor)) throw new Error('Thread anchor is not in this review')
  }
  const anchor = patch.anchor ?? thread.anchor
  const origin = patch.origin ?? thread.origin
  const outdated = patch.outdated ?? thread.outdated
  const itemBody = patch.itemBody
  const bodyChanged = itemBody !== undefined && thread.messages[0]?.body !== itemBody
  if (
    JSON.stringify(anchor) === JSON.stringify(thread.anchor) &&
    JSON.stringify(origin) === JSON.stringify(thread.origin) &&
    outdated === thread.outdated &&
    !bodyChanged
  ) {
    return null
  }
  const d = getDb()
  return transaction(d, () => {
    d.prepare('UPDATE review_threads SET anchor = ?, origin = ?, outdated = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(anchor),
      JSON.stringify(origin),
      outdated ? 1 : 0,
      now.toISOString(),
      threadId
    )
    if (bodyChanged && itemBody !== undefined && thread.messages[0])
      d.prepare('UPDATE review_messages SET body = ? WHERE id = ?').run(itemBody, thread.messages[0].id)
    return changedThread(thread.reviewId, threadId)
  })
}

export function removeMainReviewThread(threadId: string, now = new Date()): ReviewThreadChange | null {
  const thread = getReviewThread(threadId)
  if (!thread) return null
  return transaction(getDb(), () => removeThread(getDb(), thread.reviewId, thread.id, now.toISOString()))
}

/** Test seam. */
export function resetReviewsRev(value = 1): void {
  rev = value
}
