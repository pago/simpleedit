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
  /** Head commit SHA — the cache key: unchanged SHA ⇒ triage/deep still valid. */
  headSha: string
  additions: number
  deletions: number
  changedFiles: number
  baseRefName: string
  /** This PR's own branch — lets us detect a stack (another PR whose base is this). */
  headRefName: string
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

// ── Review composer (the GitHub WRITE path) ─────────────────────────────────
// The in-app *human* path to GitHub (plans/screen-prs.md §3.4): collect line
// comments (from triage/deep findings or your own) + a summary + a verdict, then
// POST a single review. The verdict/anchor logic is pure and lives here so the
// renderer, main handler, and tests share one source of truth.

export type PrReviewVerdict = 'approve' | 'comment' | 'request_changes'

/** Where a composer comment came from — drives its provenance chip in the UI. */
export type PrReviewCommentSource = 'triage' | 'deep' | 'agent' | 'you'

export interface PrReviewComment {
  source: PrReviewCommentSource
  /** File path relative to the repo root (empty for a PR-level note). */
  file: string
  /** Raw finding line ("88", "88–94", "L88", "—" …) — anchored best-effort. */
  line?: string
  text: string
}

export interface PrReviewDraft {
  comments: PrReviewComment[]
  summary: string
  verdict: PrReviewVerdict
}

export function emptyReviewDraft(): PrReviewDraft {
  return { comments: [], summary: '', verdict: 'approve' }
}

/** The GitHub reviews-API event for each verdict. */
export const REVIEW_EVENT: Record<PrReviewVerdict, 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'> = {
  approve: 'APPROVE',
  comment: 'COMMENT',
  request_changes: 'REQUEST_CHANGES',
}

/** A line-anchored comment in the shape the reviews API expects. */
export interface GithubReviewComment {
  path: string
  line: number
  side: 'RIGHT'
  body: string
}

/** The body POSTed to `/repos/{o}/{r}/pulls/{n}/reviews`. */
export interface GithubReviewPayload {
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'
  body: string
  comments: GithubReviewComment[]
}

/**
 * Reduce a finding's line field to a single GitHub-anchorable line number.
 * "88" → 88, "88–94"/"88-94" → 88 (first line of the range), "L88" → 88;
 * "—", "", undefined, or non-numeric → null (the comment gets folded into the
 * review body instead of anchored).
 */
export function parseLineAnchor(line?: string): number | null {
  if (!line) return null
  const m = line.match(/\d+/)
  return m ? Number(m[0]) : null
}

function foldedBullet(c: PrReviewComment): string {
  // A folded comment has no anchorable line (or no file at all), so the raw line
  // string would just be noise — keep only the file for context.
  const loc = c.file ? `${c.file} — ` : ''
  return `- ${loc}${c.text}`
}

/**
 * Turn a draft into a single review payload. Comments with a resolvable
 * file+line anchor to the diff's RIGHT side; the rest (no file, or an
 * unparseable/"—" line) fold into the review body as a bullet list so nothing
 * is silently dropped (the decision recorded in plans/screen-prs.md §3.4).
 */
export function buildReviewPayload(draft: PrReviewDraft): GithubReviewPayload {
  const anchored: GithubReviewComment[] = []
  const folded: string[] = []
  for (const c of draft.comments) {
    const anchor = c.file ? parseLineAnchor(c.line) : null
    if (c.file && anchor != null) anchored.push({ path: c.file, line: anchor, side: 'RIGHT', body: c.text })
    else folded.push(foldedBullet(c))
  }
  const body = [draft.summary.trim(), folded.join('\n')].filter(Boolean).join('\n\n')
  return { event: REVIEW_EVENT[draft.verdict], body, comments: anchored }
}

/**
 * Collapse every anchored comment into the body — the recovery path when the
 * reviews API rejects an anchor that isn't part of the diff (422). Keeps the
 * content rather than failing the whole submit.
 */
export function foldCommentsIntoBody(payload: GithubReviewPayload): GithubReviewPayload {
  if (payload.comments.length === 0) return payload
  const bullets = payload.comments.map((c) => `- ${c.path}:${c.line} — ${c.body}`)
  const body = [payload.body, bullets.join('\n')].filter(Boolean).join('\n\n')
  return { event: payload.event, body, comments: [] }
}

/**
 * Why a draft can't be posted yet, or null if it can. GitHub rejects a COMMENT
 * or REQUEST_CHANGES review with no body and no comments; APPROVE may be empty.
 */
export function reviewSubmitError(draft: PrReviewDraft): string | null {
  const { event, body, comments } = buildReviewPayload(draft)
  if (event !== 'APPROVE' && !body.trim() && comments.length === 0) {
    return draft.verdict === 'comment'
      ? 'Add a summary or at least one comment to post a Comment review.'
      : 'Add a summary or a comment explaining the requested changes.'
  }
  return null
}

// ── Stacked-PR grouping ─────────────────────────────────────────────────────

/** A group in a rendered bucket: a lone card, or a stack ordered base→head. */
export interface PrGroup {
  /** Set for a multi-PR stack (repo#rootNumber); undefined for a standalone card. */
  stackId?: string
  /** For a stack, ordered base→head — review `cards[0]` first. */
  cards: ScreenPrCard[]
}

const branchKey = (repo: string, ref: string): string => `${repo} ${ref}`

/**
 * Fold a bucket's already-sorted cards into stacks: a card whose `baseRefName`
 * equals another (same-repo) card's `headRefName` stacks on it. Linear chains
 * are surfaced as one group so the reviewer sees the order, not N loose items
 * (plans/screen-prs.md §Step 4). A card whose parent lives in another bucket
 * has no visible parent here and stays standalone. Group order follows the
 * incoming sort (a stack takes its root's position).
 */
export function groupStacks(cards: ScreenPrCard[]): PrGroup[] {
  const byHead = new Map<string, ScreenPrCard>()
  for (const c of cards) if (c.headRefName) byHead.set(branchKey(c.repo, c.headRefName), c)
  const parentOf = (c: ScreenPrCard): ScreenPrCard | undefined => {
    const p = byHead.get(branchKey(c.repo, c.baseRefName))
    return p && p !== c ? p : undefined
  }
  const children = new Map<ScreenPrCard, ScreenPrCard[]>()
  for (const c of cards) {
    const p = parentOf(c)
    if (!p) continue
    const list = children.get(p) ?? []
    list.push(c)
    children.set(p, list)
  }
  const seen = new Set<ScreenPrCard>()
  const groups: PrGroup[] = []
  for (const c of cards) {
    if (seen.has(c) || parentOf(c)) continue // skip non-roots; their ancestor emits them
    // DFS so a branching stack (a PR with >1 dependent) keeps every descendant in
    // the group, always parent-before-child — not just the first child.
    const chain: ScreenPrCard[] = []
    const visit = (node: ScreenPrCard): void => {
      if (seen.has(node)) return
      chain.push(node)
      seen.add(node)
      for (const child of children.get(node) ?? []) visit(child)
    }
    visit(c)
    groups.push(chain.length > 1 ? { stackId: `${chain[0].repo}#${chain[0].number}`, cards: chain } : { cards: chain })
  }
  // Cards whose parent sits in another bucket were never rooted here — emit them
  // standalone, preserving order.
  for (const c of cards) if (!seen.has(c)) { groups.push({ cards: [c] }); seen.add(c) }
  return groups
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
