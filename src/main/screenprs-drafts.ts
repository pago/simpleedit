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
import { isPrUrl, type PrReviewDraft } from '../shared/screenprs'
import { applyDraftOp, parseReviewDraft, type DraftOpResult, type DraftsSnapshot, type PrReviewDraftOp } from '../shared/review-drafts'

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

function load(): Drafts {
  if (mem) return mem
  try {
    mem = prune(sanitize(JSON.parse(readFileSync(filePath(), 'utf-8'))), Date.now())
  } catch {
    mem = {}
  }
  return mem
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
