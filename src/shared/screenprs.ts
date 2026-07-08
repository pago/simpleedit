/**
 * Screen PRs — shared domain types + the deterministic bucketing rules.
 *
 * Bucketing is pure and lives here (not in an agent) so both the main-process
 * orchestrator and the renderer can compute/re-sort identically as cards stream
 * in — see plans/screen-prs.md §3.1. The model only supplies `impact` + light
 * `findings`; the bucket is *derived* from those plus the PR metadata gathered
 * over `gh`.
 */
import type { ConventionalCommentLabel } from './ipc-types'

export type PrCiStatus = 'green' | 'pending' | 'failing'
export type PrReviewerState = 'approved' | 'changes_requested' | 'commented' | 'pending'

/** The lightweight identity from the PR search — enough to render a placeholder. */
export interface PrRef {
  owner: string
  repo: string
  number: number
  url: string
  title: string
  author: string
  updatedAt: string
}

export interface PrReviewer {
  login: string
  state: PrReviewerState
}

/** Everything gathered for a PR in plain JS (via `gh`), before the model judges it. */
export interface PrContext extends PrRef {
  additions: number
  deletions: number
  changedFiles: number
  baseRefName: string
  ci: PrCiStatus
  /** Names of the failing checks (for the "waiting on author" one-liner). */
  ciFailing: string[]
  reviewers: PrReviewer[]
  /** Approved by someone *other* than the current user. */
  approvedByOther: boolean
  body: string
  diff: string
}

export type TriageImpact = 'low' | 'medium' | 'high'

export interface TriageFinding {
  label: ConventionalCommentLabel
  file: string
  line?: string
  title: string
}

/** The model's diff-only judgment — the only part an LLM produces during triage. */
export interface TriageResult {
  impact: TriageImpact
  findings: TriageFinding[]
}

export type ScreenPrBucket = 'attention' | 'quick' | 'waiting' | 'fyi'

/** A fully-triaged PR: context + model result + derived bucket. */
export interface ScreenPrCard extends PrContext, TriageResult {
  bucket: ScreenPrBucket
}

/**
 * A PR is "critical" if the diff carries real risk — high blast radius or a
 * concrete issue the triage model flagged. Critical PRs surface even when
 * someone else already approved.
 */
export function isCritical(pr: Pick<ScreenPrCard, 'impact' | 'findings'>): boolean {
  return pr.impact === 'high' || pr.findings.some((f) => f.label === 'issue')
}

/**
 * Deterministic bucket for a triaged PR (plans/screen-prs.md §2/§3.1):
 * - CI failing → the author still has work; don't review yet.
 * - Approved by someone else → surface only if critical, else FYI.
 * - Otherwise (needs a reviewer) → attention if critical, else a quick pass.
 */
export function bucketOf(pr: Pick<ScreenPrCard, 'ci' | 'approvedByOther' | 'impact' | 'findings'>): ScreenPrBucket {
  if (pr.ci === 'failing') return 'waiting'
  const critical = isCritical(pr)
  if (pr.approvedByOther) return critical ? 'attention' : 'fyi'
  return critical ? 'attention' : 'quick'
}

export const BUCKET_ORDER: ScreenPrBucket[] = ['attention', 'quick', 'waiting', 'fyi']

// ── Deep review ───────────────────────────────────────────────────────────────
// A thorough pass over a chosen PR: fan out focused review *lenses*, then a
// synthesis step dedups/ranks/drops-noise. Mostly local by default; cloud only
// for the lenses that earn it (plans/screen-prs.md §3.2).

export type DeepLensId = 'intent' | 'tests' | 'soundness' | 'types' | 'architecture'

export const DEEP_LENS_ORDER: DeepLensId[] = ['soundness', 'intent', 'tests', 'types', 'architecture']

export const DEEP_LENS_LABEL: Record<DeepLensId, string> = {
  soundness: 'Soundness & bugs',
  intent: 'Intent vs. implementation',
  tests: 'Test coverage',
  types: 'Type safety',
  architecture: 'Architecture & design',
}

export type DeepSeverity = 'blocking' | 'concern' | 'note'

export interface DeepFinding {
  lens: DeepLensId
  severity: DeepSeverity
  file: string
  line?: string
  title: string
  detail: string
}

export type DeepReviewStatus = 'idle' | 'running' | 'done' | 'error'
export type DeepLensStatus = 'running' | 'done' | 'error'

export const SEVERITY_RANK: Record<DeepSeverity, number> = { blocking: 0, concern: 1, note: 2 }

/** Sort curated findings blocking-first, then by lens order, then file. */
export function compareDeepFindings(a: DeepFinding, b: DeepFinding): number {
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (a.lens !== b.lens) return DEEP_LENS_ORDER.indexOf(a.lens) - DEEP_LENS_ORDER.indexOf(b.lens)
  return a.file.localeCompare(b.file)
}

/**
 * Within a bucket: attention worst-first (high impact, most issues), quick
 * smallest-first (fastest to clear), everything else newest-first. Total order,
 * stable for equal keys via the PR number tiebreak.
 */
export function compareInBucket(a: ScreenPrCard, b: ScreenPrCard): number {
  if (a.bucket !== b.bucket) return BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)
  const impactRank = (r: TriageImpact): number => ({ high: 0, medium: 1, low: 2 })[r]
  if (a.bucket === 'attention') {
    if (impactRank(a.impact) !== impactRank(b.impact)) return impactRank(a.impact) - impactRank(b.impact)
    const ai = a.findings.filter((f) => f.label === 'issue').length
    const bi = b.findings.filter((f) => f.label === 'issue').length
    if (ai !== bi) return bi - ai
  } else if (a.bucket === 'quick') {
    const size = (p: ScreenPrCard): number => p.additions + p.deletions
    if (size(a) !== size(b)) return size(a) - size(b)
  } else {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
  }
  return a.number - b.number
}
