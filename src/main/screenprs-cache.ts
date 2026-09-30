/**
 * Persistent triage/deep-review cache (plans/screen-prs.md). Keyed by PR url +
 * head commit SHA + base key (see `baseKey` in github/stack-base.ts): unchanged,
 * the review diff is identical, so the model's triage/deep findings are still
 * valid and needn't be recomputed. The head alone isn't enough — a rebased
 * lower stack layer changes an upper PR's diff without touching its head. Re-screening
 * then only spends tokens on new or newly-pushed PRs. Metadata (CI/reviews) is
 * NOT cached — the orchestrator always refetches it so buckets stay current.
 *
 * Stored as one JSON blob under userData/config, mirroring models/config.ts.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createHash } from 'crypto'
import type { TriageResult, TriageFinding, DeepFinding, BaseAnalysis } from '../shared/screenprs'
import type { OverviewFacts } from '../shared/pr-overview'

/** A PR overview: the model's raw markdown (parsed on render) and the facts gathered with it. */
export interface CachedOverview {
  text: string
  facts: OverviewFacts
  at: string
}

export interface CacheEntry {
  headSha: string
  baseKey?: string
  base?: BaseAnalysis
  diff: string
  triage: TriageResult
  triageFingerprint?: string
  /** Curated deep-review findings, present once a deep review ran at this SHA. */
  deep?: DeepFinding[]
  deepFingerprint?: string
  /**
   * The PR overview at this SHA and base. It is only ever written onto an
   * entry at the same head, and `putTriage` keeps it only while the base key
   * holds, so it follows the entry's head and base rules without keys of its own.
   */
  overview?: CachedOverview
  overviewFingerprint?: string
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
export function analysisFingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (!input || typeof input !== 'object') return input
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function getCached(url: string, headSha: string, triageFingerprint: string, baseKey: string): CacheEntry | undefined {
  const e = load()[url]
  return e && e.headSha === headSha && e.baseKey === baseKey && e.triageFingerprint === triageFingerprint ? e : undefined
}

/** The cached review diff for `url` at `headSha`, whatever produced it. */
export function getCachedDiff(url: string, headSha: string): string | undefined {
  const e = load()[url]
  return e?.headSha === headSha ? e.diff : undefined
}

/** Store (or replace) the triage result + review diff for a PR at a given SHA and base. */
export function putTriage(
  url: string,
  headSha: string,
  diff: string,
  triage: TriageResult,
  triageFingerprint: string,
  base: { key: string; analysis?: BaseAnalysis }
): void {
  const cache = load()
  // A new SHA or base supersedes the old entry entirely (its deep result is stale too).
  const prior = cache[url]
  const sameDiff = prior?.headSha === headSha && prior.baseKey === base.key
  cache[url] = {
    headSha, baseKey: base.key, base: base.analysis, diff, triage, triageFingerprint, at: new Date().toISOString(),
    ...(sameDiff && prior.triageFingerprint === triageFingerprint && prior.deep && prior.deepFingerprint
      ? { deep: prior.deep, deepFingerprint: prior.deepFingerprint }
      : {}),
    // The overview doesn't read the triage prompt, so only the diff has to match.
    ...(sameDiff && prior.overview && prior.overviewFingerprint
      ? { overview: prior.overview, overviewFingerprint: prior.overviewFingerprint }
      : {}),
  }
  save()
}

/** Attach a deep-review result — only if the cached entry is at the same SHA. */
export function getCachedDeep(url: string, headSha: string, deepFingerprint: string): DeepFinding[] | undefined {
  const entry = load()[url]
  return entry?.headSha === headSha && entry.deepFingerprint === deepFingerprint ? entry.deep : undefined
}

export function putDeep(url: string, headSha: string, deep: DeepFinding[], deepFingerprint: string): void {
  const cache = load()
  const e = cache[url]
  if (e && e.headSha === headSha) {
    e.deep = deep
    e.deepFingerprint = deepFingerprint
    e.at = new Date().toISOString()
    save()
  }
}

/** The findings already made at this head, whatever fingerprint produced them. */
export function getCachedFindings(url: string, headSha: string): { triage: TriageFinding[]; deep: DeepFinding[] } {
  const e = load()[url]
  if (e?.headSha !== headSha) return { triage: [], deep: [] }
  return { triage: e.triage.findings, deep: e.deep ?? [] }
}

export function getCachedOverview(url: string, headSha: string, overviewFingerprint: string): CachedOverview | undefined {
  const e = load()[url]
  return e?.headSha === headSha && e.overviewFingerprint === overviewFingerprint ? e.overview : undefined
}

/** Attach an overview — only if the cached entry is at the same SHA, like `putDeep`. */
export function putOverview(url: string, headSha: string, overview: CachedOverview, overviewFingerprint: string): void {
  const e = load()[url]
  if (e && e.headSha === headSha) {
    e.overview = overview
    e.overviewFingerprint = overviewFingerprint
    e.at = new Date().toISOString()
    save()
  }
}
