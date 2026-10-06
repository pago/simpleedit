/**
 * GitHub context adapter for Screen PRs. Thin typed wrappers over the user's
 * existing `gh` auth — the one genuinely new context source the bounded-task
 * substrate gains (plans/screen-prs.md §4.3). Read-only here: search the review
 * queue and gather per-PR context (size, CI, reviews, base, body, diff). The
 * write path is `review.ts`.
 *
 * The JSON parsers are exported and pure so they can be unit-tested without a
 * live `gh`; `runGh` itself is the thin, untested shell seam.
 */
import { spawn } from 'child_process'
import { AsyncLocalStorage } from 'async_hooks'
import type {
  PrRef,
  PrContext,
  PrCiStatus,
  PrReviewer,
  PrReviewerState,
} from '../../shared/screenprs'
import { isPrUrl } from '../../shared/screenprs'

export { isPrUrl }

/** Run `gh` and resolve its stdout. `allowFail` keeps stdout on a nonzero exit
 *  (e.g. `gh pr checks` returns 8 when a check is failing but still prints JSON).
 *  `input`, when set, is written to the child's stdin (for `gh api --input -`). */
/**
 * A `gh` call that ran out of time and was killed.
 *
 * Distinguished because it is the one failure whose EFFECT is unknown: a POST
 * that was killed mid-flight may still have been received. A caller on a write
 * path must not report it as "nothing happened".
 */
export class GhTimeoutError extends Error {}

/** Long enough for a big diff on a slow link; short enough to not be forever. */
export const GH_TIMEOUT_MS = 120_000

/** A `gh` call killed because the run that made it was stopped. */
export class GhAbortError extends Error {
  override name = 'AbortError'
}

const ambientSignal = new AsyncLocalStorage<AbortSignal>()

/**
 * Run `fn` with every `gh` call it makes, however deep (`stack-base.ts`'s
 * resolver included), killed when `signal` aborts. Ambient rather than a
 * parameter on each helper: a run reaches `runGh` through a dozen of them, and
 * one missed would leave a child that outlives Stop and holds up quit.
 */
export function withGhSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return ambientSignal.run(signal, fn)
}

export function runGh(
  args: string[],
  opts: { allowFail?: boolean; input?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const signal = opts.signal ?? ambientSignal.getStore()
  if (signal?.aborted) return Promise.reject(new GhAbortError(`gh ${args[0]} was stopped`))
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', args, { env: process.env as Record<string, string> })
    let out = ''
    let err = ''
    let timedOut = false
    let aborted = false
    // Unbounded, this hangs whatever awaited it for the life of the process —
    // and on the review screen that is a dialog with a write in flight.
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, opts.timeoutMs ?? GH_TIMEOUT_MS)
    const onAbort = (): void => {
      aborted = true
      proc.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const settle = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()))
    proc.stderr.on('data', (c: Buffer) => (err += c.toString()))
    proc.on('error', (e) => {
      settle()
      reject(e)
    })
    proc.on('close', (code) => {
      settle()
      if (aborted) reject(new GhAbortError(`gh ${args[0]} was stopped`))
      else if (timedOut) reject(new GhTimeoutError(`gh ${args[0]} did not finish within ${opts.timeoutMs ?? GH_TIMEOUT_MS}ms`))
      else if (code === 0 || opts.allowFail) resolve(out)
      else reject(new Error(`gh ${args[0]} exited ${code}: ${err.slice(0, 300)}`))
    })
    if (opts.input != null) {
      proc.stdin.write(opts.input)
      proc.stdin.end()
    }
  })
}

export async function currentHandle(): Promise<string> {
  return (await runGh(['api', 'user', '--jq', '.login'])).trim()
}

// ── search ──────────────────────────────────────────────────────────────────

interface RawSearchPr {
  number: number
  title: string
  url: string
  updatedAt: string
  author?: { login?: string } | null
  repository?: { name?: string; nameWithOwner?: string } | null
}

/** Parse `gh search prs --json number,title,url,updatedAt,author,repository`. */
export function parseSearch(json: string): PrRef[] {
  const rows = JSON.parse(json) as RawSearchPr[]
  return rows.map((r) => {
    const nameWithOwner = r.repository?.nameWithOwner ?? ''
    const owner = nameWithOwner.includes('/') ? nameWithOwner.split('/')[0] : ''
    return {
      owner,
      repo: r.repository?.name ?? nameWithOwner.split('/')[1] ?? '',
      number: r.number,
      url: r.url,
      title: r.title,
      author: r.author?.login ?? 'unknown',
      updatedAt: r.updatedAt,
    }
  })
}

/**
 * Open, non-draft PRs where the current user is a requested reviewer, active
 * since `updatedSince` (YYYY-MM-DD). `owner` scopes to one org when provided.
 */
export async function searchReviewRequestedPrs(opts: {
  owner?: string
  updatedSince?: string
  limit?: number
}): Promise<PrRef[]> {
  const args = [
    'search', 'prs',
    '--review-requested=@me',
    '--state=open',
    '--draft=false',
    '--json', 'number,title,url,updatedAt,author,repository',
    '--limit', String(opts.limit ?? 50),
  ]
  if (opts.owner) args.push('--owner', opts.owner)
  if (opts.updatedSince) args.push('--updated', `>=${opts.updatedSince}`)
  return parseSearch(await runGh(args))
}

// ── per-PR context ────────────────────────────────────────────────────────────

interface RawCheck {
  name: string
  state: string
  bucket?: string
}

/** Derive a single CI status + the failing check names from `gh pr checks --json`. */
export function parseChecks(json: string): { ci: PrCiStatus; ciFailing: string[] } {
  const rows = (JSON.parse(json || '[]') as RawCheck[]) ?? []
  if (rows.length === 0) return { ci: 'green', ciFailing: [] }
  const failing = rows.filter((r) => r.bucket === 'fail' || r.state === 'FAILURE' || r.state === 'ERROR')
  if (failing.length) return { ci: 'failing', ciFailing: failing.map((r) => r.name) }
  const pending = rows.some((r) => r.bucket === 'pending' || r.state === 'PENDING' || r.state === 'IN_PROGRESS' || r.state === 'QUEUED')
  return { ci: pending ? 'pending' : 'green', ciFailing: [] }
}

interface RawReview {
  author?: { login?: string } | null
  state?: string
}
interface RawPrView {
  additions: number
  deletions: number
  changedFiles: number
  baseRefName: string
  baseRefOid?: string
  headRefName?: string
  headRefOid: string
  body: string
  latestReviews?: RawReview[] | null
}

/** A PR's context minus the diff — the cheap part, always refetched so CI/reviews
 *  stay current even on a cache hit. `baseRefOid` is typed here, not on `PrContext`:
 *  only main reads it, to key the cache. */
export type PrMeta = Omit<PrContext, 'diff'> & { baseRefOid: string }

const REVIEW_STATE: Record<string, PrReviewerState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  PENDING: 'pending',
}

/** Assemble a `PrMeta` (everything but the diff) from the view + checks output. */
export function assembleMeta(ref: PrRef, viewJson: string, checksJson: string, handle: string): PrMeta {
  const view = JSON.parse(viewJson) as RawPrView
  const reviews = view.latestReviews ?? []
  const reviewers: PrReviewer[] = reviews.map((r) => ({
    login: r.author?.login ?? 'unknown',
    state: REVIEW_STATE[r.state ?? ''] ?? 'commented',
  }))
  const approvedByOther = reviews.some(
    (r) => r.state === 'APPROVED' && (r.author?.login ?? '') !== handle
  )
  return {
    ...ref,
    headSha: view.headRefOid ?? '',
    additions: view.additions,
    deletions: view.deletions,
    changedFiles: view.changedFiles,
    baseRefName: view.baseRefName,
    baseRefOid: view.baseRefOid ?? '',
    headRefName: view.headRefName ?? '',
    body: view.body ?? '',
    reviewers,
    approvedByOther,
    ...parseChecks(checksJson),
  }
}

const VIEW_FIELDS = 'additions,deletions,changedFiles,baseRefName,baseRefOid,headRefName,headRefOid,body,latestReviews'

/** The cheap half: metadata + CI + head SHA (no diff). Always refetched so a
 *  cached PR still gets current CI/reviews and an accurate bucket. */
export async function getPrMeta(ref: PrRef, handle: string): Promise<PrMeta> {
  const [viewJson, checksJson] = await Promise.all([
    runGh(['pr', 'view', ref.url, '--json', VIEW_FIELDS]),
    runGh(['pr', 'checks', ref.url, '--json', 'name,state,bucket'], { allowFail: true }),
  ])
  return assembleMeta(ref, viewJson, checksJson, handle)
}

/** The expensive-to-refetch half: the unified diff. Skipped on a cache hit. */
export function getPrDiff(ref: Pick<PrRef, 'url'>): Promise<string> {
  if (!isPrUrl(ref.url)) return Promise.reject(new Error(`Not a pull-request URL: ${ref.url}`))
  return runGh(['pr', 'diff', ref.url])
}

/** Gather everything triage needs for one PR (meta + diff). */
export async function getPrContext(ref: PrRef, handle: string): Promise<PrContext> {
  const [meta, diff] = await Promise.all([getPrMeta(ref, handle), getPrDiff(ref)])
  return { ...meta, diff }
}
