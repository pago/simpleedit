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
import type { PrReviewDraft } from '../shared/screenprs'
import { applyDraftOp, type DraftOpResult, type DraftsSnapshot, type PrReviewDraftOp } from '../shared/review-drafts'

export interface StoredDraft {
  draft: PrReviewDraft
  /** ISO timestamp of the last op — used for age-based pruning. */
  at: string
}

type Drafts = Record<string, StoredDraft>

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

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

function load(): Drafts {
  if (mem) return mem
  try {
    mem = prune(JSON.parse(readFileSync(filePath(), 'utf-8')) as Drafts, Date.now())
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
  return { drafts: Object.fromEntries(Object.entries(load()).map(([url, d]) => [url, d.draft])), rev }
}

/**
 * Apply `op` to `url`'s draft and persist it. Returns the draft as it now
 * stands (null: none), and whether anything changed, so a no-op isn't
 * broadcast.
 */
export function applyOp(url: string, op: PrReviewDraftOp, now = new Date()): DraftOpResult & { changed: boolean } {
  const drafts = load()
  const prior = drafts[url]?.draft ?? null
  const draft = applyDraftOp(prior, op)
  if (draft === prior) return { draft, rev, changed: false }
  const next = { ...drafts }
  if (draft) next[url] = { draft, at: now.toISOString() }
  else delete next[url]
  save(next)
  mem = next
  rev++
  return { draft, rev, changed: true }
}
