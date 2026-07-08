/**
 * Persistent triage/deep-review cache (plans/screen-prs.md). Keyed by PR url +
 * head commit SHA: an unchanged SHA means the diff is identical, so the model's
 * triage/deep findings are still valid and needn't be recomputed. Re-screening
 * then only spends tokens on new or newly-pushed PRs. Metadata (CI/reviews) is
 * NOT cached — the orchestrator always refetches it so buckets stay current.
 *
 * Stored as one JSON blob under userData/config, mirroring models/config.ts.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { TriageResult, DeepFinding } from '../shared/screenprs'

export interface CacheEntry {
  headSha: string
  diff: string
  triage: TriageResult
  /** Curated deep-review findings, present once a deep review ran at this SHA. */
  deep?: DeepFinding[]
  /** ISO timestamp of the last write — used for age-based pruning. */
  at: string
}

type Cache = Record<string, CacheEntry>

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

let mem: Cache | null = null

function filePath(): string {
  const dir = join(app.getPath('userData'), 'config')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'screenprs-cache.json')
}

/** Drop entries older than MAX_AGE_MS. Pure — exported for tests. */
export function prune(cache: Cache, now: number): Cache {
  const out: Cache = {}
  for (const [url, e] of Object.entries(cache)) {
    if (now - new Date(e.at).getTime() <= MAX_AGE_MS) out[url] = e
  }
  return out
}

function load(): Cache {
  if (mem) return mem
  try {
    mem = prune(JSON.parse(readFileSync(filePath(), 'utf-8')) as Cache, Date.now())
  } catch {
    mem = {}
  }
  return mem
}

function save(): void {
  if (mem) writeFileSync(filePath(), JSON.stringify(mem), 'utf-8')
}

/** Cached entry for `url` iff it was stored at the current `headSha`. */
export function getCached(url: string, headSha: string): CacheEntry | undefined {
  const e = load()[url]
  return e && e.headSha === headSha ? e : undefined
}

/** Store (or replace) the triage result + diff for a PR at a given SHA. */
export function putTriage(url: string, headSha: string, diff: string, triage: TriageResult): void {
  const cache = load()
  // A new SHA supersedes the old entry entirely (its deep result is stale too).
  cache[url] = { headSha, diff, triage, at: new Date().toISOString() }
  save()
}

/** Attach a deep-review result — only if the cached entry is at the same SHA. */
export function putDeep(url: string, headSha: string, deep: DeepFinding[]): void {
  const cache = load()
  const e = cache[url]
  if (e && e.headSha === headSha) {
    e.deep = deep
    e.at = new Date().toISOString()
    save()
  }
}
