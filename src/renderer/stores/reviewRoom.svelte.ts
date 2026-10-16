/**
 * Mirror of the reviews and review threads main owns (`review:load` +
 * `review:changed`), applied by revision like the agent-threads mirror: every
 * change goes to main as an op and comes back as a change, and the mirror is
 * never edited locally. Main also answers what the room shows beside the
 * threads (layers, per-layer diffs, "since you last looked"), cached here so
 * the room's parts and the submit dialog share one fetch.
 */
import { untrack } from 'svelte'
import {
  newReviewMessageId,
  newReviewThreadId,
  type Review,
  type ReviewChange,
  type ReviewCloseReason,
  type ReviewOp,
  type ReviewSnapshot,
  type ReviewThread,
  type ReviewThreadAnchor,
} from '../../shared/review-room'
import type { ReviewLayerDiff, ReviewLayerInfo, ReviewOpenResult, ReviewRequesterInfo, ReviewSinceStatus } from '../../shared/review-room-ipc'
import { truncateSnippet } from '../../shared/review-drafts'
import { hasUnreadMessages, newestSeq } from '../lib/review-room'
import { screenPrsStore } from './screenprs.svelte'

export type OpenState =
  | { status: 'loading' }
  | { status: 'ready'; reviewId: string }
  | { status: 'error'; error: string }

let _reviews = $state<Map<string, Review>>(new Map())
let _threads = $state<Map<string, ReviewThread>>(new Map())
/** Newest revision seen per id, removals included, so a stale change or load never resurrects one. */
const _reviewRevs = new Map<string, number>()
const _threadRevs = new Map<string, number>()

let _open = $state<Map<string, OpenState>>(new Map())
let _layers = $state<Map<string, ReviewLayerInfo[]>>(new Map())
let _diffs = $state<Map<string, ReviewLayerDiff>>(new Map())
let _since = $state<Map<string, ReviewSinceStatus>>(new Map())
/** Unsent ask text per thread (and per new-thread composer key), so a remount keeps it. */
let _askDrafts = $state<Record<string, string>>({})
/** The requesting session per review, as main last answered (`null`: none). */
let _requesters = $state<Map<string, ReviewRequesterInfo | null>>(new Map())

const layerKey = (reviewId: string, url: string): string => `${reviewId}|${url}`

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function receive(change: ReviewChange): void {
  if ('threadId' in change) {
    if (change.rev < (_threadRevs.get(change.threadId) ?? -Infinity)) return
    _threadRevs.set(change.threadId, change.rev)
    const next = new Map(_threads)
    if (change.thread) next.set(change.threadId, change.thread)
    else next.delete(change.threadId)
    _threads = next
    return
  }
  if (change.rev < (_reviewRevs.get(change.reviewId) ?? -Infinity)) return
  _reviewRevs.set(change.reviewId, change.rev)
  // A pushed head reaches the record first; the layer's title and figures follow from main.
  const infos = _layers.get(change.reviewId)
  if (change.review && infos?.some((i) => change.review?.layers.some((l) => l.url === i.url && l.headSha !== i.headSha))) {
    void reviewRoom.refreshLayers(change.reviewId)
  }
  const next = new Map(_reviews)
  if (change.review) next.set(change.reviewId, change.review)
  else next.delete(change.reviewId)
  _reviews = next
}

function merge<T>(current: Map<string, T>, revs: Map<string, number>, incoming: readonly T[], idOf: (v: T) => string, rev: number): Map<string, T> {
  const next = new Map<string, T>()
  // Changes newer than the snapshot already reached the mirror; keep them.
  for (const [id, v] of current) if ((revs.get(id) ?? -Infinity) > rev) next.set(id, v)
  for (const v of incoming) {
    const id = idOf(v)
    if ((revs.get(id) ?? -Infinity) > rev) continue
    revs.set(id, rev)
    next.set(id, v)
  }
  return next
}

function receiveSnapshot({ reviews, threads, rev }: ReviewSnapshot): void {
  _reviews = merge(_reviews, _reviewRevs, reviews, (r) => r.id, rev)
  _threads = merge(_threads, _threadRevs, threads, (t) => t.id, rev)
}

function setIn<T>(map: Map<string, T>, key: string, value: T): Map<string, T> {
  const next = new Map(map)
  next.set(key, value)
  return next
}

async function sendOp(reviewId: string, op: ReviewOp): Promise<void> {
  const change = await window.api.invoke('review:op', { reviewId, op })
  if (change) receive(change)
}

export const reviewRoom = {
  review(reviewId: string): Review | undefined {
    return _reviews.get(reviewId)
  },
  thread(threadId: string): ReviewThread | undefined {
    return _threads.get(threadId)
  },
  /** Open reviews an agent asked for (`request_review`), newest first: the queue's Requested group. */
  requested(): Review[] {
    return [..._reviews.values()]
      .filter((r) => r.status === 'open' && !!r.requesterSessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },
  /** The Screen PRs badge: PRs needing attention plus requested reviews, each PR once. */
  screenPrsAttention(): number {
    const urls = new Set(screenPrsStore.attentionUrls())
    for (const review of reviewRoom.requested()) {
      const top = review.layers[review.layers.length - 1]
      if (top) urls.add(top.url)
    }
    return urls.size
  },
  /** A review's threads, oldest first. */
  threadsFor(reviewId: string): ReviewThread[] {
    return [..._threads.values()].filter((t) => t.reviewId === reviewId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },

  async load(): Promise<void> {
    try {
      receiveSnapshot(await window.api.invoke('review:load'))
    } catch (err) {
      console.warn('[review] loading reviews failed:', err)
    }
  },

  // ── Opening a PR's stack ──
  openState(url: string): OpenState | undefined {
    return _open.get(url)
  },
  /** Open (or reuse) the review of `url`'s stack. Never throws: the outcome is `openState(url)`. */
  async open(url: string): Promise<ReviewOpenResult | null> {
    // Untracked: the view calls this from an effect, which must not come to depend on the state it sets.
    untrack(() => {
      const prior = _open.get(url)
      if (!prior || prior.status === 'error') _open = setIn(_open, url, { status: 'loading' })
    })
    try {
      const result = await window.api.invoke('review:open', url)
      _layers = setIn(_layers, result.reviewId, result.layers)
      _open = setIn(_open, url, { status: 'ready', reviewId: result.reviewId })
      return result
    } catch (err) {
      _open = setIn(_open, url, { status: 'error', error: message(err) })
      return null
    }
  },
  /**
   * Bottom → top, as main resolved the stack, at the heads the review records:
   * those arrive with `review:changed`, ahead of the rest of the layer's info.
   */
  layers(reviewId: string): ReviewLayerInfo[] {
    const infos = _layers.get(reviewId) ?? []
    const heads = new Map((_reviews.get(reviewId)?.layers ?? []).map((l) => [l.url, l.headSha]))
    return infos.map((l) => {
      const head = heads.get(l.url)
      return head && head !== l.headSha ? { ...l, headSha: head } : l
    })
  },
  async refreshLayers(reviewId: string): Promise<void> {
    try {
      _layers = setIn(_layers, reviewId, await window.api.invoke('review:layers', reviewId))
    } catch (err) {
      console.warn('[review] refreshing layers failed:', err)
    }
  },

  layerDiff(reviewId: string, url: string): ReviewLayerDiff | undefined {
    return _diffs.get(layerKey(reviewId, url))
  },
  /** Rejects with main's reason, so the layer can say why it has no diff. */
  async loadLayerDiff(reviewId: string, url: string): Promise<ReviewLayerDiff> {
    const diff = await window.api.invoke('review:layer-diff', reviewId, url)
    _diffs = setIn(_diffs, layerKey(reviewId, url), diff)
    return diff
  },

  since(reviewId: string, url: string): ReviewSinceStatus | undefined {
    return _since.get(layerKey(reviewId, url))
  },
  async loadSince(reviewId: string, url: string): Promise<void> {
    let status: ReviewSinceStatus
    try {
      status = await window.api.invoke('review:since', reviewId, url)
    } catch (err) {
      status = { kind: 'unknown', error: message(err) }
    }
    _since = setIn(_since, layerKey(reviewId, url), status)
  },
  sinceDiff(reviewId: string, url: string): Promise<string> {
    return window.api.invoke('review:since-diff', reviewId, url)
  },
  /** "Got it": the head on screen becomes the one last looked at. */
  async ackHead(reviewId: string, url: string): Promise<void> {
    await window.api.invoke('review:ack-head', reviewId, url)
    _since = setIn(_since, layerKey(reviewId, url), { kind: 'identical' })
  },
  markStep(reviewId: string, stepId: string, read: boolean): Promise<void> {
    return window.api.invoke('review:mark-step', reviewId, stepId, read)
  },

  // ── Threads ──
  /** Rejects if main refused it, so a composer can keep the text. */
  op(reviewId: string, op: ReviewOp): Promise<void> {
    return sendOp(reviewId, op)
  },
  /** A thread started with a question for the companion, or (no body) with the user's own draft. Resolves to its id. */
  async addThread(reviewId: string, anchor: ReviewThreadAnchor, body?: string): Promise<string> {
    const id = newReviewThreadId()
    const thread = { id, anchor: $state.snapshot(anchor) as ReviewThreadAnchor }
    await sendOp(reviewId, body === undefined ? { kind: 'add-thread', thread } : { kind: 'add-thread', thread, message: { id: newReviewMessageId(), body } })
    return id
  },
  /**
   * A thread that starts as the user's own comment: the thread first, so the
   * draft's `threadId` names one main holds, then the draft on `draftUrl`.
   */
  async addDraftThread(reviewId: string, anchor: ReviewThreadAnchor, draftUrl: string, text: string): Promise<string> {
    const id = await reviewRoom.addThread(reviewId, anchor)
    screenPrsStore.addComment(draftUrl, {
      source: 'you',
      file: anchor.kind === 'line' ? anchor.path : '',
      text,
      threadId: id,
      ...(anchor.kind === 'line'
        ? {
            line: anchor.startLine === anchor.endLine ? String(anchor.startLine) : `${anchor.startLine}-${anchor.endLine}`,
            side: anchor.side,
            snippet: truncateSnippet(anchor.snippet),
            sha: anchor.headSha,
          }
        : {}),
    })
    return id
  },
  ask(reviewId: string, threadId: string, body: string): Promise<void> {
    return sendOp(reviewId, { kind: 'append', threadId, message: { id: newReviewMessageId(), body } })
  },
  /** Ask author: the question goes to the session that requested the review. */
  askAuthor(reviewId: string, threadId: string, body: string): Promise<void> {
    return sendOp(reviewId, { kind: 'ask-author', threadId, message: { id: newReviewMessageId(), body } })
  },
  requester(reviewId: string): ReviewRequesterInfo | null | undefined {
    return _requesters.get(reviewId)
  },
  async loadRequester(reviewId: string): Promise<void> {
    try {
      _requesters = setIn(_requesters, reviewId, await window.api.invoke('review:requester-info', reviewId))
    } catch (err) {
      console.warn('[review] loading the requester failed:', err)
    }
  },
  setStatus(reviewId: string, threadId: string, status: 'open' | 'done', closeReason?: ReviewCloseReason): Promise<void> {
    if (status === 'open') return sendOp(reviewId, { kind: 'set-status', threadId, status })
    return sendOp(reviewId, { kind: 'set-status', threadId, status, ...(closeReason ? { closeReason } : {}) })
  },
  remove(reviewId: string, threadId: string): Promise<void> {
    return sendOp(reviewId, { kind: 'remove-thread', threadId })
  },
  clearProposal(reviewId: string, threadId: string): Promise<void> {
    return sendOp(reviewId, { kind: 'clear-proposal', threadId })
  },
  /** Everything in the thread is seen. A no-op while nothing is unread, so it can run on every render. */
  markRead(threadId: string): void {
    const t = _threads.get(threadId)
    if (!t || !hasUnreadMessages(t)) return
    sendOp(t.reviewId, { kind: 'mark-read', threadId, seq: newestSeq(t) }).catch((err: unknown) => console.warn('[review] mark-read failed:', err))
  },
  moveDraft(threadId: string, toUrl: string): Promise<void> {
    return window.api.invoke('review:move-draft', threadId, toUrl)
  },

  askDraft(key: string): string {
    return _askDrafts[key] ?? ''
  },
  setAskDraft(key: string, text: string): void {
    if (text) _askDrafts[key] = text
    else delete _askDrafts[key]
  },
}

/** Subscribe to `review:changed` and load the reviews. Call once at app start; returns an unsub. */
export function initReviewRoomListeners(): () => void {
  const unsub = window.api.on('review:changed', (change) => receive(change))
  void reviewRoom.load()
  return unsub
}

export function _resetReviewRoomForTests(): void {
  _reviews = new Map()
  _threads = new Map()
  _reviewRevs.clear()
  _threadRevs.clear()
  _open = new Map()
  _layers = new Map()
  _diffs = new Map()
  _since = new Map()
  _askDrafts = {}
  _requesters = new Map()
}

/** Tests only: what `review:changed` would deliver. */
export function _receiveReviewChange(change: ReviewChange): void {
  receive(change)
}
