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
import { parseUnifiedDiff } from './parseDiff'

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
  /** How the PR's base relates to the default branch; absent when it couldn't be determined. */
  base?: BaseAnalysis
}

/**
 * Whether GitHub's diff for a PR can be trusted.
 *
 * When a lower stack layer is rebased, the upper PR still carries the lower
 * layer's old commits, and GitHub's diff (computed from the old merge-base)
 * shows the whole stack. Those commits are `foreign`; `own` are the PR's own.
 * `isolated` means the own commits form a contiguous suffix, so the diff shown
 * could be narrowed to them; the context's size figures then describe that
 * narrowed diff, and `github` keeps the figures GitHub shows.
 */
export type BaseAnalysis =
  | { kind: 'default' }
  | { kind: 'clean' }
  | {
      kind: 'polluted'
      basePr?: number
      foreign: number
      behindBy: number
      own: { sha: string; subject: string }[]
      isolated: boolean
      github?: DiffStats
    }

export interface DiffStats {
  additions: number
  deletions: number
  changedFiles: number
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The warning shown above a polluted PR's diff, or null when there is nothing to warn about. */
export function baseWarning(pr: Pick<PrContext, 'base' | 'baseRefName' | 'changedFiles'>): string | null {
  const { base, baseRefName } = pr
  if (base?.kind !== 'polluted') return null
  const from = base.basePr != null ? `#${base.basePr}` : baseRefName
  const why = base.behindBy > 0 ? `base rebased, behind by ${base.behindBy}` : 'base rebased'
  const head = `Misleading diff on GitHub: includes ${plural(base.foreign, 'commit')} from ${from} (${why}).`
  if (base.isolated && base.github) {
    return `${head} GitHub shows ${plural(base.github.changedFiles, 'file')}; this PR's own ${plural(base.own.length, 'commit')} touch ${pr.changedFiles}. Showing only those.`
  }
  return base.isolated
    ? `${head} Showing only this PR's ${plural(base.own.length, 'commit')}.`
    : `${head} Couldn't isolate this PR's commits; the diff below includes the lower layer.`
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
export type PrReviewCommentSource = 'triage' | 'deep' | 'overview' | 'agent' | 'you'

export interface PrReviewComment {
  /**
   * Stable identity, minted when the comment joins a draft. Every edit and
   * removal addresses a comment by it: an array index means a different
   * comment on each client the moment another one adds or removes.
   */
  id: string
  source: PrReviewCommentSource
  /** File path relative to the repo root (empty for a PR-level note). */
  file: string
  /** Raw finding line ("88", "88–94", "L88", "—" …) — anchored best-effort. */
  line?: string
  /**
   * Which side of the diff `line` counts on: `LEFT` is the old file (a deleted
   * row), `RIGHT` the new one. Absent means `RIGHT`, which is what every
   * finding is.
   */
  side?: 'LEFT' | 'RIGHT'
  text: string
  /**
   * The row text the comment was written on. Quoted when the comment folds into
   * the review body, so it keeps its context without a line to sit on.
   */
  snippet?: string
  /**
   * The head commit this comment's `line` was read off, when it is known.
   *
   * GitHub anchors a review against its `commit_id`, which defaults to the
   * PR's latest head when the payload leaves it out. Either way that is the
   * head at POST time: if it moved after the comment was raised, the number
   * now points at different code — see `anchorsForHead`, which is what has to
   * run before a draft is posted.
   *
   * `undefined` means UNKNOWN, and unknown is not "a different head": a comment
   * with no stamp is never treated as stale. Never store `''` here — that is a
   * head this comment demonstrably does not belong to, which is the opposite of
   * what an absent head means.
   */
  sha?: string
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
  /** The single line, or the LAST line of a range. */
  line: number
  side: 'LEFT' | 'RIGHT'
  /** Set only for a multi-line range; GitHub requires it below `line`. */
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
  body: string
}

/** The body POSTed to `/repos/{o}/{r}/pulls/{n}/reviews`. */
export interface GithubReviewPayload {
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'
  body: string
  comments: GithubReviewComment[]
  /** The head the anchors were checked against; GitHub defaults to the latest. */
  commit_id?: string
}

/**
 * Read a finding's line field as a line range. "88" → 88–88, "88–94"/"88-94"/
 * "L88-L94" → 88–94; "—", "", undefined, or non-numeric → null. A reversed
 * range keeps only its first line.
 */
export function parseLineRange(line?: string): { start: number; end: number } | null {
  if (!line) return null
  const m = line.match(/(\d+)(?:\s*[-–—]\s*L?(\d+))?/)
  if (!m) return null
  const start = Number(m[1])
  // Files are 1-based, so 0 is not a line GitHub can anchor to — and a single
  // rejected anchor 422s the review, collapsing EVERY anchor in it into the
  // body. Folding one comment beats losing the placement of all of them.
  if (start <= 0) return null
  const end = m[2] === undefined ? start : Number(m[2])
  return { start, end: end > start ? end : start }
}

/**
 * Reduce a finding's line field to a single GitHub-anchorable line number: the
 * first line of `parseLineRange`, or null (the comment gets folded into the
 * review body instead of anchored).
 */
export function parseLineAnchor(line?: string): number | null {
  return parseLineRange(line)?.start ?? null
}

/**
 * Whether a comment's line anchor may be posted, and if not, why not.
 *
 * Three states, not two. Two rounds of this code asked "is it stale?", which
 * has no answer when the stamp or the current head is missing — and both times
 * the missing answer was resolved as "go ahead". On a write other people see,
 * ONLY a positive match may anchor: a line number that cannot be checked is a
 * line number that might land on code the reviewer never read, and GitHub
 * accepts it silently: it checks the line against the review's commit, not
 * against the commit the reviewer read.
 */
export type AnchorState =
  /** No line was raised — a file-level note. Nothing to anchor either way. */
  | 'none'
  /** Read off the head that is on screen now. The only state that anchors. */
  | 'current'
  /** Read off a different head: the code under that line has changed. */
  | 'moved'
  /** Unstamped, or the current head is unknown. Cannot be checked. */
  | 'unverified'

export function anchorState(c: PrReviewComment, headSha: string): AnchorState {
  if (c.line === undefined) return 'none'
  if (!c.sha || !headSha) return 'unverified'
  return c.sha === headSha ? 'current' : 'moved'
}

/** The states whose anchor must not reach GitHub. */
function foldsAway(state: AnchorState): boolean {
  return state === 'moved' || state === 'unverified'
}

/**
 * Keep a line anchor only where it is verified against `headSha`.
 *
 * Everything else loses its line and keeps its file and text, so
 * `buildReviewPayload` folds it into the review body — the same treatment an
 * unanchorable finding already gets. Nothing is dropped; placement is what is
 * given up, and only where placement could not be shown to be right.
 *
 * Returns the draft unchanged when every anchor is verified, so a caller can
 * compare by identity.
 */
export function anchorsForHead(draft: PrReviewDraft, headSha: string): PrReviewDraft {
  if (!draft.comments.some((c) => foldsAway(anchorState(c, headSha)))) return draft
  return {
    ...draft,
    comments: draft.comments.map((c) =>
      foldsAway(anchorState(c, headSha)) ? { ...c, line: undefined } : c
    ),
  }
}

/**
 * How many comments are in each anchor state — so the UI can say WHICH reason
 * cost a comment its line, rather than reporting one number for two causes.
 */
export function anchorCounts(draft: PrReviewDraft, headSha: string): Record<AnchorState, number> {
  const counts: Record<AnchorState, number> = { none: 0, current: 0, moved: 0, unverified: 0 }
  for (const c of draft.comments) counts[anchorState(c, headSha)]++
  return counts
}

/** Per side, each line GitHub accepts a comment on, mapped to its hunk's index. */
export interface CommentableSides {
  LEFT: Map<number, number>
  RIGHT: Map<number, number>
}

/**
 * The lines of a diff that GitHub will anchor a review comment to, by path:
 * RIGHT is every added or context row's new number, LEFT every deleted or
 * context row's old number. Feed it GitHub's own diff of the PR — a comment on
 * a row outside its hunks 422s the whole review.
 */
export function commentableLines(diff: string): Map<string, CommentableSides> {
  const out = new Map<string, CommentableSides>()
  for (const file of parseUnifiedDiff(diff)) {
    const sides: CommentableSides = { LEFT: new Map(), RIGHT: new Map() }
    let hunk = -1
    for (const row of file.rows) {
      if (row.kind === 'hunk') { hunk++; continue }
      if (row.kind !== 'del' && row.newNo !== undefined) sides.RIGHT.set(row.newNo, hunk)
      if (row.kind !== 'add' && row.oldNo !== undefined) sides.LEFT.set(row.oldNo, hunk)
    }
    out.set(file.path, sides)
  }
  return out
}

export interface ReviewPayloadOptions {
  /** From `commentableLines` on GitHub's diff. Absent: anchors aren't checked. */
  commentable?: Map<string, CommentableSides>
  /** Sent as `commit_id`, pinning the anchors to the head they were checked on. */
  headSha?: string
  /**
   * The diff the reviewer read was taken against a different base than
   * GitHub's (a stacked PR's parent), so its old-side numbers are not GitHub's.
   */
  isolatedBase?: boolean
}

/** Why a comment went into the review body instead of onto a line. */
export type FoldReason =
  /** No file, or no numeric line. */
  | 'no-line'
  /** A deleted-line comment read off a diff with a different base. */
  | 'isolated-base'
  /** The line is outside GitHub's hunks for that file. */
  | 'not-in-diff'

/** Where one draft comment goes in the payload: onto a line, or into the body. */
export function resolveAnchor(
  c: PrReviewComment,
  opts: ReviewPayloadOptions = {}
): { anchor: GithubReviewComment } | { fold: FoldReason } {
  const range = c.file ? parseLineRange(c.line) : null
  if (!range) return { fold: 'no-line' }
  const side = c.side ?? 'RIGHT'
  if (side === 'LEFT' && opts.isolatedBase) return { fold: 'isolated-base' }
  const single = { anchor: { path: c.file, line: range.start, side, body: c.text } }
  if (!opts.commentable) return single
  const lines = opts.commentable.get(c.file)?.[side]
  const startHunk = lines?.get(range.start)
  if (startHunk === undefined) return { fold: 'not-in-diff' }
  // GitHub rejects a range that spans hunks, so it narrows to its first line.
  if (range.end === range.start || lines?.get(range.end) !== startHunk) return single
  return {
    anchor: { path: c.file, start_line: range.start, start_side: side, line: range.end, side, body: c.text },
  }
}

function location(file: string, start: number, end: number, side: 'LEFT' | 'RIGHT'): string {
  const lines = end > start ? `${start}-${end}` : `${start}`
  const deleted = side === 'LEFT' ? (end > start ? ' (deleted lines)' : ' (deleted line)') : ''
  return `${file}:${lines}${deleted}`
}

function quoted(snippet: string): string {
  return snippet.split('\n').map((l) => `\n  > ${l}`).join('')
}

function foldedBullet(c: PrReviewComment): string {
  // A non-numeric line ("—") is just noise in the body, so only a real number
  // is kept next to the file.
  const range = parseLineRange(c.line)
  const loc = !c.file ? '' : range ? `${location(c.file, range.start, range.end, c.side ?? 'RIGHT')} — ` : `${c.file} — `
  return `- ${loc}${c.text}${c.snippet ? quoted(c.snippet) : ''}`
}

/**
 * Turn a draft into a single review payload. Each comment anchors where
 * `resolveAnchor` can place it; the rest fold into the review body as a bullet
 * list so nothing is silently dropped (the decision recorded in
 * plans/screen-prs.md §3.4). Folding is per comment, so one bad anchor does not
 * cost the others their lines.
 */
export function buildReviewPayload(draft: PrReviewDraft, opts: ReviewPayloadOptions = {}): GithubReviewPayload {
  const anchored: GithubReviewComment[] = []
  const folded: string[] = []
  for (const c of draft.comments) {
    const placed = resolveAnchor(c, opts)
    if ('anchor' in placed) anchored.push(placed.anchor)
    else folded.push(foldedBullet(c))
  }
  const body = [draft.summary.trim(), folded.join('\n')].filter(Boolean).join('\n\n')
  const payload: GithubReviewPayload = { event: REVIEW_EVENT[draft.verdict], body, comments: anchored }
  if (opts.headSha) payload.commit_id = opts.headSha
  return payload
}

/**
 * Collapse every anchored comment into the body — the recovery path when the
 * reviews API rejects an anchor that isn't part of the diff (422). Keeps the
 * content rather than failing the whole submit.
 */
export function foldCommentsIntoBody(payload: GithubReviewPayload): GithubReviewPayload {
  if (payload.comments.length === 0) return payload
  const bullets = payload.comments.map(
    (c) => `- ${location(c.path, c.start_line ?? c.line, c.line, c.side)} — ${c.body}`
  )
  const body = [payload.body, bullets.join('\n')].filter(Boolean).join('\n\n')
  return { ...payload, body, comments: [] }
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
