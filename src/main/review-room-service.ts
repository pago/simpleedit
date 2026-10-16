/**
 * The Review Room's main-side work behind the `review:*` channels: opening a
 * stack as a review, each layer's diff and info, return visits (§8), moving a
 * draft between layers, submitting and discarding. Also turns every triage,
 * overview and deep-review result into the threads of the open reviews that
 * hold that layer at that head.
 *
 * Every argument arrives from a client (the phone is a remote one), so each is
 * parsed here as untrusted before it reaches `gh` or the stores.
 */
import { createHash } from 'crypto'
import type { DraftOpResult, PrReviewDraftOp } from '../shared/review-drafts'
import { isPrUrl, parseLineRange, type BaseAnalysis, type DeepFinding, type PrReviewDraft, type TriageFinding } from '../shared/screenprs'
import { parseOverview, resolveRefPath } from '../shared/pr-overview'
import { parseUnifiedDiff, type DiffFile } from '../shared/parseDiff'
import {
  isReviewThreadId,
  parseReviewId,
  type Review,
  type ReviewAgent,
  type ReviewChange,
  type ReviewLayerSubmission,
  type ReviewPrRef,
  type ReviewSubmission,
  type ReviewFindingSource,
  type ReviewThreadAnchor,
} from '../shared/review-room'
import type {
  ReviewLayerDiff,
  ReviewLayerInfo,
  ReviewLayerSubmitOutcome,
  ReviewOpenResult,
  ReviewSinceStatus,
  ReviewSubmitRequest,
  ReviewSubmitResult,
  ReviewVerdict,
} from '../shared/review-room-ipc'
import type { ThreadAnchor } from '../shared/agent-threads'
import { parseChecks, runGh } from './github/gh'
import {
  baseKey,
  compareDiff,
  compareHeads,
  createBaseResolver,
  getReviewDiff,
  resolveStack,
  type ReviewDiffTarget,
  type StackCard,
} from './github/stack-base'
import { importGithubReviewThreads } from './github/review-threads'
import { discardLayer, postReviewLayer } from './github/review-graphql'
import { reanchor } from './thread-reanchor'
import { deepSeverity, materialiseFindings, triageSeverity, type FindingToMaterialise } from './review-findings'
import {
  createReview,
  getReview,
  reviewsWithStatus,
  setReviewLastSeenHead,
  setReviewLayerHead,
  setReviewStatus,
  setReviewStepRead,
  threadsForReview,
  updateMainReviewThread,
} from './review-room-store'
import { draftLinksForThread, draftThreadIds, loadDrafts, moveThreadDraft, removeDraftsForThread } from './screenprs-drafts'
import { fileAt as fileAtRef } from './github/pr-overview-context'
import { getCacheEntryAt } from './screenprs-cache'
import { screeningSnapshot } from './screenprs'

export interface ReviewRoomDeps {
  broadcastReview: (changes: ReviewChange[]) => void
  /** Applies a draft op through the draft store and broadcasts it. */
  applyDraftOp: (url: string, op: PrReviewDraftOp) => DraftOpResult
  broadcastDraft: (url: string, result: DraftOpResult) => void
  defaultCompanionAgent: () => ReviewAgent
  endCompanion: (reviewId: string) => Promise<void> | void
  removeCheckouts: (reviewId: string) => Promise<void> | void
}

let deps: ReviewRoomDeps | null = null

export function configureReviewRoom(next: ReviewRoomDeps): void {
  deps = next
}

function need(): ReviewRoomDeps {
  if (!deps) throw new Error('The Review Room is not configured')
  return deps
}

function broadcast(changes: ReadonlyArray<ReviewChange | null>): void {
  const real = changes.filter((change): change is ReviewChange => change !== null)
  if (real.length) need().broadcastReview(real)
}

function warn(what: string, err: unknown): void {
  console.warn(`[ReviewRoom] ${what}:`, err instanceof Error ? err.message : err)
}

// ── argument parsing ────────────────────────────────────────────────────────

function parsePrUrlArg(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048 || !isPrUrl(raw)) throw new Error('Not a pull-request URL')
  return raw.replace(/\/$/, '')
}

function layerOf(rawReviewId: unknown, rawUrl: unknown): { review: Review; layer: ReviewPrRef } {
  const review = getReview(parseReviewId(rawReviewId))
  if (!review) throw new Error('Unknown review')
  const url = parsePrUrlArg(rawUrl)
  const layer = review.layers.find((candidate) => candidate.url === url)
  if (!layer) throw new Error('That pull request is not a layer of this review')
  return { review, layer }
}

const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/
const HEAD_SHA = /^[0-9A-Za-z]{4,64}$/
const VERDICTS: readonly string[] = ['approve', 'comment', 'request_changes']

export function parseSubmitRequest(raw: unknown): ReviewSubmitRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Malformed submit request')
  const { reviewId, layers } = raw as Record<string, unknown>
  if (!Array.isArray(layers) || layers.length === 0 || layers.length > 100) throw new Error('Malformed submit request')
  const seen = new Set<string>()
  const parsed = layers.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Malformed submit layer')
    const { prUrl, verdict, readHead, adoptPendingReviewId } = entry as Record<string, unknown>
    const url = parsePrUrlArg(prUrl)
    if (seen.has(url)) throw new Error('A layer is listed twice')
    seen.add(url)
    if (typeof verdict !== 'string' || !VERDICTS.includes(verdict)) throw new Error('Malformed verdict')
    if (typeof readHead !== 'string' || !HEAD_SHA.test(readHead)) throw new Error('Malformed read head')
    if (adoptPendingReviewId !== undefined && (typeof adoptPendingReviewId !== 'string' || !NODE_ID.test(adoptPendingReviewId))) {
      throw new Error('Malformed pending review id')
    }
    return {
      prUrl: url,
      verdict: verdict as ReviewVerdict,
      readHead,
      ...(adoptPendingReviewId !== undefined ? { adoptPendingReviewId } : {}),
    }
  })
  return { reviewId: parseReviewId(reviewId), layers: parsed }
}

// ── layer metadata ──────────────────────────────────────────────────────────

interface LayerMeta extends ReviewLayerInfo {
  baseRefOid: string
  closedAt?: string
}

const LAYER_FIELDS = 'url,number,title,author,isDraft,state,baseRefName,baseRefOid,headRefName,headRefOid,additions,deletions,changedFiles,body,closedAt'

const str = (value: unknown, max = 1 << 20): string => (typeof value === 'string' ? value.slice(0, max) : '')
const nat = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0)

function ownerRepo(url: string): { owner: string; repo: string } {
  const [, owner, repo] = new URL(url).pathname.split('/')
  return { owner: owner ?? '', repo: repo ?? '' }
}

/** Parse `gh pr view --json <LAYER_FIELDS>` as untrusted; the url is the one asked for. */
export function parseLayerView(url: string, json: string): Omit<LayerMeta, 'ci'> {
  const raw = JSON.parse(json) as unknown
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('GitHub returned malformed pull-request metadata')
  const view = raw as Record<string, unknown>
  const number = nat(view.number)
  const headSha = str(view.headRefOid, 128)
  const state = view.state
  if (!number || !headSha || (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')) {
    throw new Error('GitHub returned incomplete pull-request metadata')
  }
  const author = typeof view.author === 'object' && view.author !== null ? str((view.author as { login?: unknown }).login, 256) : ''
  const closedAt = str(view.closedAt, 64)
  // GitHub's spelling, so a layer is known by one url whichever way it was asked for.
  const canonical = typeof view.url === 'string' && isPrUrl(view.url) ? view.url : url
  return {
    url: canonical,
    ...ownerRepo(canonical),
    number,
    title: str(view.title, 1024),
    author,
    isDraft: view.isDraft === true,
    state,
    baseRefName: str(view.baseRefName, 1024),
    baseRefOid: str(view.baseRefOid, 128),
    headRefName: str(view.headRefName, 1024),
    headSha,
    additions: nat(view.additions),
    deletions: nat(view.deletions),
    changedFiles: nat(view.changedFiles),
    body: str(view.body, 256 * 1024),
    ...(closedAt ? { closedAt } : {}),
  }
}

async function fetchLayerMeta(url: string): Promise<LayerMeta> {
  const [viewJson, checksJson] = await Promise.all([
    runGh(['pr', 'view', url, '--json', LAYER_FIELDS]),
    runGh(['pr', 'checks', url, '--json', 'name,state,bucket'], { allowFail: true }).catch(() => ''),
  ])
  const view = parseLayerView(url, viewJson)
  let ci: LayerMeta['ci'] = 'pending'
  try {
    ci = parseChecks(checksJson).ci
  } catch {
    // Unreadable checks say nothing about CI; pending claims the least.
  }
  return { ...view, ci }
}

function infoOf(meta: LayerMeta): ReviewLayerInfo {
  const { baseRefOid: _oid, closedAt: _closed, ...info } = meta
  const base = getCacheEntryAt(meta.url, meta.headSha)?.base
  return base ? { ...info, base } : info
}

// ── the review diff of a layer ──────────────────────────────────────────────

async function diffTarget(url: string): Promise<ReviewDiffTarget> {
  const raw = JSON.parse(await runGh(['pr', 'view', url, '--json', 'baseRefName,baseRefOid,headRefOid'])) as unknown
  const view = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (typeof view.baseRefName !== 'string' || typeof view.baseRefOid !== 'string' || typeof view.headRefOid !== 'string') {
    throw new Error('GitHub returned incomplete pull-request metadata')
  }
  return { url, baseRefName: view.baseRefName, baseRefOid: view.baseRefOid, headSha: view.headRefOid }
}

const sameTarget = (a: ReviewDiffTarget, b: ReviewDiffTarget): boolean =>
  a.headSha === b.headSha && a.baseRefName === b.baseRefName && a.baseRefOid === b.baseRefOid

const DIFF_TTL_MS = 60_000
const diffs = new Map<string, { at: number; value: Promise<{ diff: string; base?: BaseAnalysis }> }>()

/**
 * The layer's review diff at the review's recorded head, `get_review_diff`'s
 * rule: a cached diff only when head and base key match, and a live fetch
 * refused when the PR moved while it loaded. Shared for a minute, since the
 * room asks for it right as `review:open` refreshes the layer in the background.
 */
export function layerReviewDiff(layer: ReviewPrRef): Promise<{ diff: string; base?: BaseAnalysis }> {
  const key = `${layer.url} ${layer.headSha}`
  const hit = diffs.get(key)
  if (hit && Date.now() - hit.at < DIFF_TTL_MS) return hit.value
  const value = loadLayerDiff(layer)
  diffs.set(key, { at: Date.now(), value })
  value.catch(() => {
    if (diffs.get(key)?.value === value) diffs.delete(key)
  })
  return value
}

async function loadLayerDiff(layer: ReviewPrRef): Promise<{ diff: string; base?: BaseAnalysis }> {
  const target = await diffTarget(layer.url)
  if (target.headSha !== layer.headSha) throw new Error('The PR head changed; reopen the review to read its new head')
  const resolver = createBaseResolver()
  const key = await baseKey(target, resolver)
  const cached = getCacheEntryAt(layer.url, layer.headSha)
  if (cached && cached.baseKey === key) return { diff: cached.diff, ...(cached.base ? { base: cached.base } : {}) }
  const fresh = await getReviewDiff(target, resolver)
  if (!sameTarget(target, await diffTarget(layer.url))) throw new Error('The PR changed while its review diff was loading; try again')
  return fresh
}

/** Test seam. */
export function resetReviewRoomForTests(): void {
  diffs.clear()
  triedAt.clear()
  reresolving.clear()
  opening = Promise.resolve()
  submitting.clear()
}

const isIsolated = (base: BaseAnalysis | undefined): boolean => base?.kind === 'polluted' && base.isolated

export async function layerDiff(rawReviewId: unknown, rawUrl: unknown): Promise<ReviewLayerDiff> {
  const { layer } = layerOf(rawReviewId, rawUrl)
  const { diff, base } = await layerReviewDiff(layer)
  return { url: layer.url, headSha: layer.headSha, diff, ...(base ? { base } : {}) }
}

// ── §8: re-placing line threads on a new head ───────────────────────────────

/** The new side of a file's diff: row text by line number, for the rows the diff shows. */
function rightRows(file: DiffFile): Map<number, string> {
  const rows = new Map<number, string>()
  for (const row of file.rows) if (row.kind !== 'hunk' && row.kind !== 'del' && row.newNo !== undefined) rows.set(row.newNo, row.text)
  return rows
}

type LineAnchor = Extract<ReviewThreadAnchor, { kind: 'line' }>

/**
 * Where a line thread's code is at a new head, or null when that can't be
 * established (it then stays on its old lines, outdated). Uniqueness is judged
 * against the whole file at the new head with `thread-reanchor.ts`'s rule, never
 * against the rows the diff happens to show: a copy inside the diff would look
 * unique while the original moved outside it. The placed lines must also be
 * rows of the new diff, or there is nothing to show or post them on. A LEFT
 * anchor sits on the review diff's base, which can't be read here.
 */
export function placeOnNewHead(anchor: LineAnchor, diff: string, headSha: string, fileAtHead: string | undefined): LineAnchor | null {
  if (anchor.side !== 'RIGHT' || fileAtHead === undefined) return null
  const file = parseUnifiedDiff(diff).find((candidate) => candidate.path === anchor.path)
  if (!file) return null
  const probe: ThreadAnchor = {
    path: anchor.path,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    snippet: anchor.snippet,
    before: anchor.before,
    after: anchor.after,
    context: { commit: headSha },
  }
  const placed = reanchor(probe, fileAtHead, true)
  if (placed?.orphaned) return null
  const at = placed ?? probe
  const rows = rightRows(file)
  const lines = fileAtHead.split(/\r?\n/)
  for (let line = at.startLine; line <= at.endLine; line++) {
    if (!rows.has(line) || rows.get(line) !== lines[line - 1]) return null
  }
  return { ...anchor, headSha, startLine: at.startLine, endLine: at.endLine, before: at.before, after: at.after }
}

/**
 * The thread's draft comment follows it: a comment left on the old head's
 * lines would otherwise fold into the review body as written against an
 * earlier commit.
 */
function moveLinkedDraft(threadId: string, url: string, from: LineAnchor, to: LineAnchor): void {
  for (const link of draftLinksForThread(threadId)) {
    if (link.url !== url) continue
    const comment = loadDrafts().drafts[url]?.comments.find((candidate) => candidate.id === link.commentId)
    const range = parseLineRange(comment?.line)
    if (!comment || !range || comment.file !== from.path || (comment.side ?? 'RIGHT') !== from.side || comment.sha !== from.headSha) continue
    const shift = to.startLine - from.startLine
    const line = range.end > range.start ? `${range.start + shift}-${range.end + shift}` : `${range.start + shift}`
    need().applyDraftOp(url, { kind: 'update-comment', id: comment.id, patch: { line, sha: to.headSha } })
  }
}

/**
 * Outdated threads already tried against a head, by thread id. Their head never
 * matches again, so without this every open would refetch their files.
 */
const triedAt = new Map<string, string>()
/** Per review, so a slow pass for one push can't land after the next one's. */
const reresolving = new Map<string, Promise<void>>()

function reresolveLayer(reviewId: string, layer: ReviewPrRef, diff: string | null): Promise<void> {
  const run = (reresolving.get(reviewId) ?? Promise.resolve()).catch(() => {}).then(() => reresolvePass(reviewId, layer, diff))
  reresolving.set(reviewId, run)
  void run.finally(() => {
    if (reresolving.get(reviewId) === run) reresolving.delete(reviewId)
  }).catch(() => {})
  return run
}

const headNow = (reviewId: string, url: string): string | undefined =>
  getReview(reviewId)?.layers.find((candidate) => candidate.url === url)?.headSha

async function reresolvePass(reviewId: string, layer: ReviewPrRef, diff: string | null): Promise<void> {
  if (headNow(reviewId, layer.url) !== layer.headSha) return
  const moved = threadsForReview(reviewId).flatMap((thread) => {
    const anchor = thread.anchor
    if (anchor.kind !== 'line' || anchor.pr !== layer.number || anchor.headSha === layer.headSha) return []
    return thread.outdated && triedAt.get(thread.id) === layer.headSha ? [] : [{ thread, anchor }]
  })
  if (!moved.length) return
  const inDiff = new Set(diff === null ? [] : parseUnifiedDiff(diff).map((file) => file.path))
  const files = new Map<string, Promise<string | undefined>>()
  const fileAt = (path: string): Promise<string | undefined> => {
    let hit = files.get(path)
    if (!hit) {
      hit = fileAtRef(layer.url, path, layer.headSha)
      files.set(path, hit)
    }
    return hit
  }
  const outcomes: Array<{ id: string; anchor: LineAnchor; placed: LineAnchor | null; conclusive: boolean }> = []
  for (const { thread, anchor } of moved) {
    if (diff === null) {
      outcomes.push({ id: thread.id, anchor, placed: null, conclusive: false })
    } else if (anchor.side !== 'RIGHT' || !inDiff.has(anchor.path)) {
      outcomes.push({ id: thread.id, anchor, placed: null, conclusive: true })
    } else {
      const content = await fileAt(anchor.path)
      outcomes.push({ id: thread.id, anchor, placed: placeOnNewHead(anchor, diff, layer.headSha, content), conclusive: content !== undefined })
    }
  }
  // Another push may have landed while the files were read; its own pass places them.
  if (headNow(reviewId, layer.url) !== layer.headSha) return
  const changes: Array<ReviewChange | null> = []
  for (const { id, anchor, placed, conclusive } of outcomes) {
    try {
      changes.push(updateMainReviewThread(id, placed ? { anchor: placed, outdated: false } : { outdated: true }))
      if (placed) moveLinkedDraft(id, layer.url, anchor, placed)
      if (placed) triedAt.delete(id)
      else if (conclusive) triedAt.set(id, layer.headSha)
    } catch (err) {
      warn(`re-anchoring ${id}`, err)
    }
  }
  broadcast(changes)
}

// ── findings → threads ──────────────────────────────────────────────────────

const shortHash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16)
const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

export function triageToFindings(findings: readonly TriageFinding[]): FindingToMaterialise[] {
  return findings.map((finding) => {
    const severity = triageSeverity(finding.label)
    return {
      key: `triage:${shortHash(`${finding.file}\n${finding.line ?? ''}\n${normalise(finding.title)}`)}`,
      file: finding.file,
      ...(finding.line ? { line: finding.line } : {}),
      title: finding.title,
      ...(severity ? { severity } : {}),
    }
  })
}

export function deepToFindings(findings: readonly DeepFinding[]): FindingToMaterialise[] {
  return findings.map((finding) => {
    const severity = deepSeverity(finding.severity)
    return {
      key: `deep:${finding.lens}:${shortHash(`${finding.file}\n${finding.line ?? ''}\n${normalise(finding.title)}`)}`,
      file: finding.file,
      ...(finding.line ? { line: finding.line } : {}),
      title: finding.title,
      detail: finding.detail,
      ...(severity ? { severity } : {}),
      lens: finding.lens,
    }
  })
}

/** The overview's Look-into items that cite code; an item with no ref is prose, not a thread. */
export function overviewToFindings(text: string, diff: string): FindingToMaterialise[] {
  const paths = parseUnifiedDiff(diff).map((file) => file.path)
  return (parseOverview(text).sections.lookInto ?? []).flatMap((item): FindingToMaterialise[] => {
    const ref = item.refs[0]
    if (!ref) return []
    const [first = '', ...rest] = item.markdown.split('\n')
    const detail = rest.join('\n').trim()
    return [{
      key: `overview:${shortHash(`${ref.path}:${ref.line ?? ''}\n${normalise(item.markdown)}`)}`,
      file: resolveRefPath(paths, ref.path) ?? ref.path,
      ...(ref.line ? { line: ref.line } : {}),
      title: first.trim().slice(0, 500),
      ...(detail ? { detail } : {}),
    }]
  })
}

/** Materialise one result into every open review (or just `onlyReviewId`) holding `url` at `headSha`. */
function materialiseInto(
  url: string,
  headSha: string,
  source: ReviewFindingSource,
  diff: string,
  findings: () => FindingToMaterialise[],
  onlyReviewId?: string,
): void {
  const reviews = reviewsWithStatus('open').filter((review) => onlyReviewId === undefined || review.id === onlyReviewId)
  const targets = reviews.flatMap((review) => {
    const layer = review.layers.find((candidate) => candidate.url === url && candidate.headSha === headSha)
    return layer ? [{ review, layer }] : []
  })
  if (!targets.length) return
  const list = findings()
  const linked = draftThreadIds()
  for (const { review, layer } of targets) {
    try {
      const { changes } = materialiseFindings({
        reviewId: review.id,
        pr: layer.number,
        headSha,
        source,
        diff,
        findings: list,
        draftThreadIds: linked,
      })
      broadcast(changes)
    } catch (err) {
      warn(`materialising ${source} findings for ${url}`, err)
    }
  }
}

/** Never throws: a run's result reaches its clients whatever happens here. */
export function onTriageCard(card: { url: string; headSha: string; diff: string; findings: TriageFinding[] }): void {
  try {
    materialiseInto(card.url, card.headSha, 'triage', card.diff, () => triageToFindings(card.findings))
  } catch (err) {
    warn('triage findings', err)
  }
}

export function onDeepFindings(result: { url: string; headSha: string; diff: string; findings: DeepFinding[] }): void {
  try {
    materialiseInto(result.url, result.headSha, 'deep', result.diff, () => deepToFindings(result.findings))
  } catch (err) {
    warn('deep findings', err)
  }
}

export function onOverviewText(result: { url: string; headSha: string; diff: string; text: string }): void {
  try {
    materialiseInto(result.url, result.headSha, 'overview', result.diff, () => overviewToFindings(result.text, result.diff))
  } catch (err) {
    warn('overview findings', err)
  }
}

/** The results already cached for a layer's head, as if each had just been sent. */
function materialiseCached(reviewId: string, layer: ReviewPrRef): void {
  const entry = getCacheEntryAt(layer.url, layer.headSha)
  if (!entry) return
  const { diff } = entry
  materialiseInto(layer.url, layer.headSha, 'triage', diff, () => triageToFindings(entry.triage.findings), reviewId)
  if (entry.deep) materialiseInto(layer.url, layer.headSha, 'deep', diff, () => deepToFindings(entry.deep ?? []), reviewId)
  if (entry.overview) {
    const text = entry.overview.text
    materialiseInto(layer.url, layer.headSha, 'overview', diff, () => overviewToFindings(text, diff), reviewId)
  }
}

// ── open ────────────────────────────────────────────────────────────────────

function boardCards(): StackCard[] {
  return screeningSnapshot(false).entries.flatMap((entry): StackCard[] => {
    const pr = entry.card ?? entry.context
    return pr ? [{ url: pr.url, number: pr.number, headSha: pr.headSha, headRefName: pr.headRefName, baseRefName: pr.baseRefName }] : []
  })
}

function openReviewWith(url: string): Review | undefined {
  return reviewsWithStatus('open')
    .filter((review) => review.layers.some((layer) => layer.url === url))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

const everPosted = (review: Review): boolean =>
  review.submissions.some((submission) => submission.layers.some((layer) => layer.state === 'posted'))

/**
 * Every PR of the stack merged or closed while the review was open, and
 * nothing was posted: the review is over. One opened on PRs already closed
 * is a deliberate look back, so it stays.
 */
export function shouldAutoClose(review: Review, metas: ReadonlyArray<Pick<LayerMeta, 'state' | 'closedAt'>>): boolean {
  if (!metas.length || everPosted(review) || metas.some((meta) => meta.state === 'OPEN')) return false
  return metas.some((meta) => !meta.closedAt || meta.closedAt > review.createdAt)
}

async function metasFor(layers: readonly ReviewPrRef[], known: LayerMeta[] = []): Promise<LayerMeta[]> {
  return Promise.all(layers.map((layer) => known.find((meta) => meta.url === layer.url) ?? fetchLayerMeta(layer.url)))
}

/** Records pushed heads; the moved layers' threads are re-placed by `refreshLayer`. */
function recordHeads(reviewId: string, metas: readonly LayerMeta[]): Review {
  for (const meta of metas) broadcast([setReviewLayerHead(reviewId, meta.number, meta.headSha)])
  const review = getReview(reviewId)
  if (!review) throw new Error('Unknown review')
  return review
}

/** Background half of opening a layer: re-place moved threads, import GitHub's, materialise cached results. */
async function refreshLayer(reviewId: string, layer: ReviewPrRef): Promise<void> {
  let fetched: { diff: string; base?: BaseAnalysis }
  try {
    fetched = await layerReviewDiff(layer)
  } catch (err) {
    warn(`loading the review diff of ${layer.url}`, err)
    await reresolveLayer(reviewId, layer, null)
    return
  }
  await reresolveLayer(reviewId, layer, fetched.diff)
  try {
    broadcast(await importGithubReviewThreads(reviewId, layer, fetched.diff, isIsolated(fetched.base)))
  } catch (err) {
    warn(`importing GitHub threads of ${layer.url}`, err)
  }
  materialiseCached(reviewId, layer)
}

let opening: Promise<unknown> = Promise.resolve()

/** Serialised, so two opens of one stack can't each create a review. */
export async function openReview(rawUrl: unknown): Promise<ReviewOpenResult> {
  const url = parsePrUrlArg(rawUrl)
  const run = opening.catch(() => {}).then(() => openStack(url))
  opening = run
  return run
}

async function openStack(url: string): Promise<ReviewOpenResult> {
  const opened = await fetchLayerMeta(url)
  let review = openReviewWith(opened.url)
  let metas: LayerMeta[] = []
  if (review) {
    metas = await metasFor(review.layers, [opened])
    if (shouldAutoClose(review, metas)) {
      await discard(review.id)
      review = undefined
    }
  }
  if (!review) {
    const def = await createBaseResolver().defaultBranch(opened.url).catch((err: unknown) => {
      warn(`default branch of ${url}`, err)
      return null
    })
    const refs = def ? await resolveStack(opened, boardCards(), def) : [{ url: opened.url, number: opened.number, headSha: opened.headSha }]
    metas = await metasFor(refs, [opened])
    const change = createReview({
      repo: (() => {
        const { host, pathname } = new URL(opened.url)
        return `${host}${pathname.split('/').slice(0, 3).join('/')}`
      })(),
      layers: metas.map((meta) => ({ url: meta.url, number: meta.number, headSha: meta.headSha })),
      companionAgent: need().defaultCompanionAgent(),
    })
    broadcast([change])
    review = change.review ?? undefined
    if (!review) throw new Error('The review could not be created')
  } else {
    review = recordHeads(review.id, metas)
  }
  const reviewId = review.id
  for (const layer of review.layers) void refreshLayer(reviewId, layer).catch((err: unknown) => warn(`refreshing ${layer.url}`, err))
  return { reviewId, layers: metas.map(infoOf) }
}

export async function reviewLayers(rawReviewId: unknown): Promise<ReviewLayerInfo[]> {
  const review = getReview(parseReviewId(rawReviewId))
  if (!review) throw new Error('Unknown review')
  const metas = await metasFor(review.layers)
  if (review.status !== 'open') return metas.map(infoOf)
  const before = new Map(review.layers.map((layer) => [layer.url, layer.headSha]))
  const now = recordHeads(review.id, metas)
  for (const layer of now.layers) {
    if (before.get(layer.url) !== layer.headSha) void refreshLayer(now.id, layer).catch((err: unknown) => warn(`refreshing ${layer.url}`, err))
  }
  return metas.map(infoOf)
}

/** At startup: reviews whose PRs all closed while they were open. One `gh` call per layer. */
export async function sweepClosedReviews(): Promise<void> {
  for (const review of reviewsWithStatus('open')) {
    try {
      const metas = await Promise.all(
        review.layers.map(async (layer) => {
          const raw = JSON.parse(await runGh(['pr', 'view', layer.url, '--json', 'state,closedAt'])) as { state?: unknown; closedAt?: unknown }
          const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN'
          return { state, ...(typeof raw.closedAt === 'string' && raw.closedAt ? { closedAt: raw.closedAt } : {}) } as const
        }),
      )
      if (shouldAutoClose(review, metas)) await discard(review.id)
    } catch (err) {
      warn(`checking whether ${review.id} is closed`, err)
    }
  }
}

// ── §8: return visits ───────────────────────────────────────────────────────

export async function since(rawReviewId: unknown, rawUrl: unknown): Promise<ReviewSinceStatus> {
  const { review, layer } = layerOf(rawReviewId, rawUrl)
  const from = review.lastSeenHead[layer.url]
  const to = layer.headSha
  if (!from) {
    broadcast([setReviewLastSeenHead(review.id, layer.url, to)])
    return { kind: 'first-visit' }
  }
  if (from === to) return { kind: 'identical' }
  try {
    const compared = await compareHeads(layer.url, from, to)
    if (compared === 'missing' || compared.status === 'diverged') return { kind: 'rewritten', from, to }
    if (compared.status === 'identical') return { kind: 'identical' }
    if (compared.status === 'behind') return { kind: 'behind', from, to }
    return { kind: 'ahead', aheadBy: compared.aheadBy, from, to }
  } catch (err) {
    return { kind: 'unknown', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The new commits' diff, or '' when there is none to show: no new commits,
 * history rewritten, or a merge among them. A merged-in base would show the
 * base's changes as the author's, and the plan's interdiff of the two review
 * diffs isn't built, so the room says so instead.
 */
export async function sinceDiff(rawReviewId: unknown, rawUrl: unknown): Promise<string> {
  const { review, layer } = layerOf(rawReviewId, rawUrl)
  const from = review.lastSeenHead[layer.url]
  if (!from || from === layer.headSha) return ''
  const compared = await compareHeads(layer.url, from, layer.headSha)
  if (compared === 'missing' || compared.status !== 'ahead' || compared.mergeCommit) return ''
  return compareDiff(layer.url, from, layer.headSha)
}

export function ackHead(rawReviewId: unknown, rawUrl: unknown): void {
  const { review, layer } = layerOf(rawReviewId, rawUrl)
  broadcast([setReviewLastSeenHead(review.id, layer.url, layer.headSha)])
}

export function markStep(rawReviewId: unknown, rawStepId: unknown, rawRead: unknown): void {
  const reviewId = parseReviewId(rawReviewId)
  if (typeof rawStepId !== 'string' || !rawStepId || rawStepId.length > 256 || [...rawStepId].some((ch) => ch.charCodeAt(0) < 0x20)) {
    throw new Error('Malformed step id')
  }
  if (typeof rawRead !== 'boolean') throw new Error('Malformed read flag')
  broadcast([setReviewStepRead(reviewId, rawStepId, rawRead)])
}

// ── drafts ──────────────────────────────────────────────────────────────────

export function moveDraft(rawThreadId: unknown, rawUrl: unknown): void {
  if (!isReviewThreadId(rawThreadId)) throw new Error('Malformed thread id')
  const toUrl = parsePrUrlArg(rawUrl)
  for (const { url, result } of moveThreadDraft(rawThreadId, toUrl)) need().broadcastDraft(url, result)
}

/** What a layer posts: its draft's comments that belong to this review's threads, and its summary. */
export function layerDraftFor(review: Review, url: string): PrReviewDraft {
  const stored = loadDrafts().drafts[url]
  const threads = new Set(threadsForReview(review.id).map((thread) => thread.id))
  return {
    comments: (stored?.comments ?? []).filter((comment) => comment.threadId !== undefined && threads.has(comment.threadId)),
    summary: stored?.summary ?? '',
    verdict: stored?.verdict ?? 'approve',
  }
}

// ── submit and discard ──────────────────────────────────────────────────────

const submitting = new Set<string>()

/** A layer's state in the newest attempt that included it. */
function latestLayerState(review: Review, url: string): ReviewLayerSubmission | undefined {
  for (const submission of [...review.submissions].reverse()) {
    const layer = submission.layers.find((entry) => entry.prUrl === url)
    if (layer) return layer
  }
  return undefined
}

async function afterReview(reviewId: string): Promise<void> {
  const { endCompanion, removeCheckouts } = need()
  try {
    await endCompanion(reviewId)
  } catch (err) {
    warn(`ending the companion of ${reviewId}`, err)
  }
  try {
    await removeCheckouts(reviewId)
  } catch (err) {
    warn(`removing the checkouts of ${reviewId}`, err)
  }
}

/**
 * Post each requested layer, bottom to top, as one GitHub review. Progress is
 * persisted as one submission per attempt, layer by layer, so a retry resumes
 * from the last attempt's state. A layer's posted comments leave the draft
 * only after its review was submitted.
 */
export async function submitReview(raw: unknown): Promise<ReviewSubmitResult> {
  const request = parseSubmitRequest(raw)
  if (submitting.has(request.reviewId)) throw new Error('This review is already being submitted')
  submitting.add(request.reviewId)
  try {
    return await submit(request)
  } finally {
    submitting.delete(request.reviewId)
  }
}

async function submit(request: ReviewSubmitRequest): Promise<ReviewSubmitResult> {
  const review = getReview(request.reviewId)
  if (!review || review.status !== 'open') throw new Error('Review is not open')
  const requested = new Map(request.layers.map((layer) => [layer.prUrl, layer]))
  for (const url of requested.keys()) {
    if (!review.layers.some((layer) => layer.url === url)) throw new Error('That pull request is not a layer of this review')
  }
  const attempt: ReviewSubmission = { at: new Date().toISOString(), destination: { session: false, github: true }, layers: [] }
  const submissions = [...review.submissions, attempt]
  const persist = (): void => {
    try {
      broadcast([setReviewStatus(review.id, 'open', submissions)])
    } catch (err) {
      warn(`recording submission progress of ${review.id}`, err)
    }
  }
  persist()

  const outcomes: ReviewLayerSubmitOutcome[] = []
  for (const layer of review.layers) {
    const ask = requested.get(layer.url)
    if (!ask) {
      outcomes.push({ prUrl: layer.url, kind: 'skipped' })
      continue
    }
    // The recorded head follows every fetch of the layer, so it can be ahead
    // of what the user read; posting then would put their verdict on code
    // they never saw.
    if (ask.readHead !== layer.headSha) {
      outcomes.push({ prUrl: layer.url, kind: 'head-moved', readHead: ask.readHead, headSha: layer.headSha })
      continue
    }
    const prior = latestLayerState(review, layer.url)
    const draft = layerDraftFor(review, layer.url)
    const isolatedBase = await layerReviewDiff(layer).then(
      ({ base }) => isIsolated(base),
      // Unknown: fold LEFT anchors rather than risk placing them on GitHub's other base.
      () => true,
    )
    const slot = attempt.layers.length
    attempt.layers.push(prior ? { ...prior, verdict: ask.verdict } : { prUrl: layer.url, verdict: ask.verdict, postedCommentIds: [], state: 'pending' })
    const { owner, repo } = ownerRepo(layer.url)
    const result = await postReviewLayer({
      pr: { owner, repo, number: layer.number, url: layer.url },
      draft,
      currentDraft: () => layerDraftFor(review, layer.url),
      readHead: ask.readHead,
      verdict: ask.verdict,
      isolatedBase,
      ...(prior ? { prior } : {}),
      ...(ask.adoptPendingReviewId ? { adoptPendingReviewId: ask.adoptPendingReviewId } : {}),
      record: (state) => {
        attempt.layers[slot] = state
        persist()
      },
    })
    attempt.layers[slot] = result.state
    persist()
    outcomes.push(result.outcome)
    if (result.outcome.kind === 'posted' && prior?.state !== 'posted') {
      try {
        need().applyDraftOp(layer.url, {
          kind: 'clear-posted',
          ids: result.state.postedCommentIds,
          summary: result.state.sent?.summary ?? '',
          verdict: result.state.sent?.verdict ?? draft.verdict,
        })
      } catch (err) {
        warn(`clearing the posted draft of ${layer.url}`, err)
      }
      broadcast([setReviewLastSeenHead(review.id, layer.url, ask.readHead)])
    }
  }

  const complete = outcomes.every((outcome) => outcome.kind === 'posted' || outcome.kind === 'skipped')
  if (complete) {
    broadcast([setReviewStatus(review.id, 'submitted', submissions)])
    await afterReview(review.id)
  }
  return { layers: outcomes, complete }
}

export async function discardReview(rawReviewId: unknown): Promise<void> {
  await discard(parseReviewId(rawReviewId))
}

/**
 * Deletes SimpleEdit's pending reviews first: a leftover one blocks the
 * user's own review on GitHub. If any can't be deleted the review stays open,
 * so discarding again retries.
 */
async function discard(reviewId: string): Promise<void> {
  const review = getReview(reviewId)
  if (!review) throw new Error('Unknown review')
  if (review.status !== 'open') return
  const failed: string[] = []
  for (const layer of review.layers) {
    const state = latestLayerState(review, layer.url)
    if (!state || state.state === 'posted') continue
    const { owner, repo } = ownerRepo(layer.url)
    try {
      await discardLayer({ owner, repo, number: layer.number, url: layer.url }, state)
    } catch (err) {
      warn(`discarding the pending review on ${layer.url}`, err)
      failed.push(layer.url)
    }
  }
  if (failed.length) throw new Error(`Couldn't delete ${failed.length} pending review(s) on GitHub; try again`)
  broadcast([setReviewStatus(reviewId, 'discarded')])
  for (const thread of threadsForReview(reviewId)) {
    for (const { url, result } of removeDraftsForThread(thread.id)) need().broadcastDraft(url, result)
  }
  await afterReview(reviewId)
}
