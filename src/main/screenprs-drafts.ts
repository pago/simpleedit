/**
 * Persisted review drafts, one per PR url, owned by main so the desktop and
 * the phone edit the same draft across reloads, restarts and devices.
 *
 * Keyed by url, not head: each comment carries its own `sha`, and
 * `anchorsForHead` deals with a head that moved. Unlike the triage cache this
 * is the user's typed work and cannot be rebuilt, so every write is atomic.
 */
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { configDir } from './config-dir'
import { isPrUrl, type PrReviewComment, type PrReviewDraft } from '../shared/screenprs'
import { applyDraftOp, isEmptyDraft, parseReviewDraft, type DraftOpResult, type DraftsSnapshot, type PrReviewDraftOp } from '../shared/review-drafts'
import { getReview, getReviewThread } from './review-room-store'

export interface StoredDraft {
  /** Null once the draft is empty but `removed` still has to be kept. */
  draft: PrReviewDraft | null
  /** ISO timestamp of the last op — used for age-based pruning. */
  at: string
  /**
   * Ids of comments that left this draft, newest last. A phone whose socket
   * dropped after sending an add replays it on reconnect, and by then the
   * comment may have been removed or posted; replayed, it would come back and
   * could post twice. Ids are minted per add and never reused, so an add for
   * one of these is always such a replay. Never sent to clients.
   */
  removed?: string[]
}

type Drafts = Record<string, StoredDraft>

export interface ThreadDraftLink {
  url: string
  commentId: string
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MAX_REMOVED = 500
const MAX_ID = 1024

let mem: Drafts | null = null
/**
 * Bumped on every change and sent with every draft that leaves main, so a
 * client holding several answers can tell which is newest: the reply to its
 * own op and another client's broadcast can arrive in either order. Seeded
 * from the clock rather than 0 so it keeps rising across an app restart — a
 * phone page outlives main, and would otherwise discard every state the new
 * main sends as older than what it saw from the old one.
 */
let rev = Date.now()

function filePath(): string {
  return join(configDir(), 'screenprs-drafts.json')
}

/** Drop drafts untouched for MAX_AGE_MS. Pure — exported for tests. */
export function prune(drafts: Drafts, now: number): Drafts {
  const out: Drafts = {}
  for (const [url, d] of Object.entries(drafts)) {
    if (now - new Date(d.at).getTime() <= MAX_AGE_MS) out[url] = d
  }
  return out
}

/**
 * The drafts in a parsed file, with whatever doesn't hold up dropped — a bad
 * comment on its own, so one bad entry doesn't take the rest of the draft
 * with it. Pure — exported for tests.
 */
export function sanitize(raw: unknown): Drafts {
  const out: Drafts = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [url, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPrUrl(url) || typeof entry !== 'object' || entry === null) continue
    const { draft, at, removed } = entry as Record<string, unknown>
    const clean = parseReviewDraft(draft)
    const ids = Array.isArray(removed)
      ? removed.filter((id): id is string => typeof id === 'string' && id.length <= MAX_ID).slice(-MAX_REMOVED)
      : []
    if ((!clean && ids.length === 0) || typeof at !== 'string') continue
    out[url] = ids.length ? { draft: clean, at, removed: ids } : { draft: clean, at }
  }
  return out
}

/** Keep one draft comment per Review Room thread; newest draft op wins. */
export function dedupeThreadDrafts(drafts: Drafts): { drafts: Drafts; changed: boolean } {
  const winner = new Map<string, { url: string; index: number; at: string }>()
  for (const [url, stored] of Object.entries(drafts)) {
    for (const [index, comment] of (stored.draft?.comments ?? []).entries()) {
      if (!comment.threadId) continue
      const before = winner.get(comment.threadId)
      if (!before || stored.at > before.at || (stored.at === before.at && (url > before.url || index > before.index))) {
        winner.set(comment.threadId, { url, index, at: stored.at })
      }
    }
  }
  let changed = false
  const next: Drafts = {}
  for (const [url, stored] of Object.entries(drafts)) {
    const removed: string[] = []
    const comments = (stored.draft?.comments ?? []).filter((comment, index) => {
      if (!comment.threadId) return true
      const keep = winner.get(comment.threadId)
      const kept = keep?.url === url && keep.index === index
      if (!kept) removed.push(comment.id)
      return kept
    })
    if (removed.length === 0) {
      next[url] = stored
      continue
    }
    changed = true
    const draft = stored.draft ? { ...stored.draft, comments } : null
    next[url] = {
      draft: draft && !isEmptyDraft(draft) ? draft : null,
      at: stored.at,
      removed: [...(stored.removed ?? []), ...removed].slice(-MAX_REMOVED),
    }
  }
  return { drafts: next, changed }
}

function load(): Drafts {
  if (mem) return mem
  try {
    const deduped = dedupeThreadDrafts(prune(sanitize(JSON.parse(readFileSync(filePath(), 'utf-8'))), Date.now()))
    mem = deduped.drafts
    if (deduped.changed) save(mem)
  } catch {
    mem = {}
  }
  return mem
}

export function draftLinksForThread(threadId: string): ThreadDraftLink[] {
  const links: ThreadDraftLink[] = []
  for (const [url, stored] of Object.entries(load())) {
    for (const comment of stored.draft?.comments ?? []) {
      if (comment.threadId === threadId) links.push({ url, commentId: comment.id })
    }
  }
  return links
}

export function draftThreadIds(): Set<string> {
  const ids = new Set<string>()
  for (const stored of Object.values(load())) {
    for (const comment of stored.draft?.comments ?? []) if (comment.threadId) ids.add(comment.threadId)
  }
  return ids
}

function assertReviewDraftLink(url: string, comment: PrReviewComment, movingFrom?: ThreadDraftLink): void {
  if (!comment.threadId) {
    if (comment.inReplyTo) throw new Error('A GitHub reply draft must belong to a review thread')
    return
  }
  const thread = getReviewThread(comment.threadId)
  const review = thread ? getReview(thread.reviewId) : null
  if (!thread || !review || review.status !== 'open') throw new Error('Draft review thread is not open')
  const layer = review.layers.find((candidate) => candidate.url === url)
  if (!layer || (thread.anchor.kind !== 'stack' && thread.anchor.pr !== layer.number)) {
    throw new Error('Draft layer does not belong to the review thread')
  }
  if (thread.origin.kind === 'github') {
    if (
      comment.inReplyTo?.threadNodeId !== thread.origin.threadNodeId ||
      comment.inReplyTo.rootCommentId !== thread.origin.rootCommentId
    ) throw new Error('Draft reply does not match the imported GitHub thread')
  } else if (comment.inReplyTo) {
    throw new Error('Only imported GitHub threads can carry reply metadata')
  }
  const otherLink = draftLinksForThread(thread.id).find(
    (link) =>
      (link.url !== url || link.commentId !== comment.id) &&
      (link.url !== movingFrom?.url || link.commentId !== movingFrom.commentId),
  )
  if (otherLink) throw new Error('Review thread already has a draft on another layer')
}

export function assertReviewDraftOp(url: string, op: PrReviewDraftOp): void {
  if (op.kind === 'add-comment') {
    assertReviewDraftLink(url, op.comment)
    return
  }
  if (op.kind !== 'update-comment') return
  const existing = loadDrafts().drafts[url]?.comments.find((comment) => comment.id === op.id)
  if (existing) assertReviewDraftLink(url, { ...existing, ...op.patch, id: existing.id })
}

export function moveThreadDraft(threadId: string, toUrl: string): Array<{ url: string; result: DraftOpResult }> {
  const links = draftLinksForThread(threadId)
  if (links.length !== 1) throw new Error('Review thread does not have exactly one draft to move')
  const from = links[0]!
  if (from.url === toUrl) return []
  const comment = loadDrafts().drafts[from.url]?.comments.find((candidate) => candidate.id === from.commentId)
  if (!comment) throw new Error('Review thread draft is missing')
  assertReviewDraftLink(toUrl, comment, from)
  // A fresh id: the old one is tombstoned wherever the draft has been, so moving back would be refused.
  const moved = { ...comment, id: crypto.randomUUID() }
  const added = applyOp(toUrl, { kind: 'add-comment', comment: moved })
  if (!added.draft?.comments.some((candidate) => candidate.id === moved.id)) {
    throw new Error('Review thread draft could not be added to the new layer')
  }
  const removed = applyOp(from.url, { kind: 'remove-comment', id: comment.id })
  return [
    { url: toUrl, result: { draft: added.draft, rev: added.rev } },
    { url: from.url, result: { draft: removed.draft, rev: removed.rev } },
  ]
}

export function removeDraftsForThread(threadId: string): Array<{ url: string; result: DraftOpResult }> {
  const removed: Array<{ url: string; result: DraftOpResult }> = []
  for (const link of draftLinksForThread(threadId)) {
    const { draft, rev: nextRev, changed } = applyOp(link.url, { kind: 'remove-comment', id: link.commentId })
    if (changed) removed.push({ url: link.url, result: { draft, rev: nextRev } })
  }
  return removed
}

function save(drafts: Drafts): void {
  const path = filePath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(drafts), 'utf-8')
  renameSync(tmp, path)
}

export function loadDrafts(): DraftsSnapshot {
  const drafts: Record<string, PrReviewDraft> = {}
  for (const [url, d] of Object.entries(load())) if (d.draft) drafts[url] = d.draft
  return { drafts, rev }
}

/**
 * Apply `op` to `url`'s draft and persist it. Returns the draft as it now
 * stands (null: none), and whether anything changed, so a no-op isn't
 * broadcast.
 */
export function applyOp(url: string, op: PrReviewDraftOp, now = new Date()): DraftOpResult & { changed: boolean } {
  const drafts = load()
  const stored = drafts[url]
  const prior = stored?.draft ?? null
  const removed = stored?.removed ?? []
  if (op.kind === 'add-comment' && removed.includes(op.comment.id)) return { draft: prior, rev, changed: false }
  const draft = applyDraftOp(prior, op)
  if (draft === prior) return { draft, rev, changed: false }
  const kept = new Set(draft?.comments.map((c) => c.id))
  const left = (prior?.comments ?? []).filter((c) => !kept.has(c.id)).map((c) => c.id)
  const nextRemoved = [...removed, ...left].slice(-MAX_REMOVED)
  const next = { ...drafts }
  const at = now.toISOString()
  if (nextRemoved.length) next[url] = { draft, at, removed: nextRemoved }
  else if (draft) next[url] = { draft, at }
  else delete next[url]
  save(next)
  mem = next
  rev++
  return { draft, rev, changed: true }
}
