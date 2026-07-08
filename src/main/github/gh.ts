/**
 * GitHub context adapter for Screen PRs. Thin typed wrappers over the user's
 * existing `gh` auth — the one genuinely new context source the bounded-task
 * substrate gains (plans/screen-prs.md §4.3). Read-only here: search the review
 * queue and gather per-PR context (size, CI, reviews, base, body, diff). The
 * write path (`gh pr review …`) lands with the review composer.
 *
 * The JSON parsers are exported and pure so they can be unit-tested without a
 * live `gh`; `runGh` itself is the thin, untested shell seam.
 */
import { spawn } from 'child_process'
import type {
  PrRef,
  PrContext,
  PrCiStatus,
  PrReviewer,
  PrReviewerState,
} from '../../shared/screenprs'

/** Run `gh` and resolve its stdout. `allowFail` keeps stdout on a nonzero exit
 *  (e.g. `gh pr checks` returns 8 when a check is failing but still prints JSON). */
export function runGh(args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', args, { env: process.env as Record<string, string> })
    let out = ''
    let err = ''
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()))
    proc.stderr.on('data', (c: Buffer) => (err += c.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0 || opts.allowFail) resolve(out)
      else reject(new Error(`gh ${args[0]} exited ${code}: ${err.slice(0, 300)}`))
    })
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
  headRefOid: string
  body: string
  latestReviews?: RawReview[] | null
}

/** A PR's context minus the diff — the cheap part, always refetched so CI/reviews
 *  stay current even on a cache hit. */
export type PrMeta = Omit<PrContext, 'diff'>

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
    body: view.body ?? '',
    reviewers,
    approvedByOther,
    ...parseChecks(checksJson),
  }
}

const VIEW_FIELDS = 'additions,deletions,changedFiles,baseRefName,headRefOid,body,latestReviews'

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
export function getPrDiff(ref: PrRef): Promise<string> {
  return runGh(['pr', 'diff', ref.url])
}

/** Gather everything triage needs for one PR (meta + diff). */
export async function getPrContext(ref: PrRef, handle: string): Promise<PrContext> {
  const [meta, diff] = await Promise.all([getPrMeta(ref, handle), getPrDiff(ref)])
  return { ...meta, diff }
}
