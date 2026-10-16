/**
 * Review Room posting: one GraphQL review per layer, built as a pending review
 * and submitted last (plans/review-room.md §7 and its PR 2 notes).
 *
 * Pending reviews are what make a retry safe: nothing is visible until
 * `submitPullRequestReview`, the review's id is recorded before anything is
 * added to it, and each comment carries a hidden marker naming its draft, so
 * a retry after a failure or a timeout picks up the same review and adds only
 * what is missing.
 *
 * Line threads go in with `addPullRequestReview(commitOID, threads)`, the only
 * call that pins them to the head the user read (`addPullRequestReviewThread`
 * anchors on the PR's current head, whatever `commitOID` says). That call is
 * atomic, so when GitHub refuses it the threads are added one by one, and
 * only while the PR's head is still the read head.
 */
import { randomUUID } from 'crypto'
import type { PrRef, PrReviewDraft } from '../../shared/screenprs'
import { commentableLines, REVIEW_EVENT, reviewSubmitError } from '../../shared/screenprs'
import type { ReviewLayerSubmission, ReviewSubmissionItem } from '../../shared/review-room'
import type { ReviewLayerSubmitOutcome, ReviewVerdict } from '../../shared/review-room-ipc'
import {
  anchorPartOf,
  claimMarker,
  commentRev,
  itemMarkerOf,
  layerBody,
  planLayer,
  withoutClaim,
  type LayerPlan,
  type PlannedItem,
  type PlannedThread,
  type ReplyContext,
} from '../../shared/review-post'
import { GhTimeoutError, runGh } from './gh'
import { prDiffAt } from './review'

/** A GraphQL answer that carried `errors`; `types` are GitHub's (`NOT_FOUND`, `UNPROCESSABLE`, …). */
export class GraphqlError extends Error {
  constructor(
    message: string,
    readonly types: string[]
  ) {
    super(message)
  }
}

type Fields = Record<string, unknown>

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── answer shapes ─────────────────────────────────────────────────────────────
// Every field dereferenced below is checked first: an answer in another shape
// fails the layer with a message instead of posting on a misread.

function shapeError(what: string): Error {
  return new Error(`GitHub answered ${what} in an unexpected shape; nothing more was sent for this layer`)
}

function obj(value: unknown, what: string): Fields {
  if (!isObject(value)) throw shapeError(what)
  return value
}

function objOrNull(value: unknown, what: string): Fields | null {
  return value === null || value === undefined ? null : obj(value, what)
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string') throw shapeError(what)
  return value
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw shapeError(what)
  return value
}

/**
 * `gh api graphql` exits non-zero when the answer has `errors` but still
 * prints the answer on stdout, so stdout is read whatever the exit code; an
 * empty one means gh failed before GitHub answered (auth, network).
 */
async function graphql(query: string, variables: Fields): Promise<Fields> {
  const out = await runGh(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query, variables }), allowFail: true })
  let answer: unknown
  try {
    answer = JSON.parse(out)
  } catch {
    throw new Error(out.trim() ? `GitHub answered with something other than JSON: ${out.slice(0, 200)}` : 'gh api graphql failed without an answer from GitHub; check `gh auth status`.')
  }
  if (!isObject(answer)) throw new Error('GitHub answered with something other than an object')
  if (Array.isArray(answer.errors) && answer.errors.length) {
    const errors = answer.errors.filter(isObject)
    const message = errors.map((e) => (typeof e.message === 'string' ? e.message : 'GraphQL error')).join('; ') || 'GraphQL error'
    throw new GraphqlError(message, errors.flatMap((e) => (typeof e.type === 'string' ? [e.type] : [])))
  }
  if (!isObject(answer.data)) throw new Error(typeof answer.message === 'string' ? `GitHub: ${answer.message}` : 'GitHub answered without data')
  return answer.data
}

const isGraphqlType = (err: unknown, type: string): err is GraphqlError => err instanceof GraphqlError && err.types.includes(type)

interface RemoteComment {
  id: string
  databaseId?: string
  body: string
  commitOid?: string
  /** Where GitHub placed it, on the review's commit. */
  path?: string
  line?: number
  startLine?: number
  side?: string
}

const COMMENT_FIELDS = 'id fullDatabaseId body commit { oid } path line originalLine startLine originalStartLine diffSide'

function parseComment(value: unknown): RemoteComment {
  const c = obj(value, 'a review comment')
  const dbId = c.fullDatabaseId
  return {
    id: str(c.id, 'a review comment id'),
    body: str(c.body, 'a review comment body'),
    ...(typeof dbId === 'string' || typeof dbId === 'number' ? { databaseId: String(dbId) } : {}),
    commitOid: optStr(objOrNull(c.commit, 'a review comment commit')?.oid),
    path: optStr(c.path),
    line: optInt(c.originalLine) ?? optInt(c.line),
    startLine: optInt(c.originalStartLine) ?? optInt(c.startLine),
    side: optStr(c.diffSide),
  }
}

interface PendingReview {
  id: string
  body: string
  commitOid?: string
  commentCount: number
}

async function readPr(pr: PrReviewTarget): Promise<{ id: string; headRefOid: string; pending: PendingReview[] }> {
  const data = await graphql(
    `query PendingReviews($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id headRefOid
          reviews(states: [PENDING], first: 20) { nodes { id body viewerDidAuthor commit { oid } comments(first: 1) { totalCount } } }
        }
      }
    }`,
    { owner: pr.owner, repo: pr.repo, number: pr.number }
  )
  const found = objOrNull(objOrNull(data.repository, 'the repository')?.pullRequest, 'the pull request')
  if (!found) throw new Error(`GitHub has no pull request ${pr.owner}/${pr.repo}#${pr.number}`)
  const pending = list(obj(found.reviews, 'the pending reviews').nodes, 'the pending reviews').flatMap((node): PendingReview[] => {
    const r = obj(node, 'a pending review')
    if (r.viewerDidAuthor !== true) return []
    const count = obj(r.comments, 'a pending review’s comments').totalCount
    return [
      {
        id: str(r.id, 'a pending review id'),
        body: optStr(r.body) ?? '',
        commitOid: optStr(objOrNull(r.commit, 'a pending review commit')?.oid),
        commentCount: typeof count === 'number' ? count : 0,
      },
    ]
  })
  return { id: str(found.id, 'the pull request id'), headRefOid: str(found.headRefOid, 'the pull request head'), pending }
}

async function readReviewComments(reviewId: string): Promise<RemoteComment[]> {
  const out: RemoteComment[] = []
  let after: string | null = null
  for (;;) {
    const data = await graphql(
      `query ReviewComments($id: ID!, $after: String) {
        node(id: $id) { ... on PullRequestReview { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } } } }
      }`,
      { id: reviewId, after }
    )
    const node = objOrNull(data.node, 'the review')
    if (!node) throw new GraphqlError(`Review ${reviewId} is gone`, ['NOT_FOUND'])
    const comments = obj(node.comments, 'the review’s comments')
    out.push(...list(comments.nodes, 'the review’s comments').map(parseComment))
    const page = obj(comments.pageInfo, 'the review’s comment page')
    if (page.hasNextPage !== true) return out
    after = str(page.endCursor, 'the review’s comment cursor')
  }
}

/** A review's state and url, or null once it is deleted. */
async function readReview(reviewId: string): Promise<{ state: string; url?: string } | null> {
  try {
    const data = await graphql(`query ReviewState($id: ID!) { node(id: $id) { ... on PullRequestReview { state url } } }`, { id: reviewId })
    const node = objOrNull(data.node, 'the review')
    const state = optStr(node?.state)
    return state ? { state, url: optStr(node?.url) } : null
  } catch (err) {
    if (isGraphqlType(err, 'NOT_FOUND')) return null
    throw err
  }
}

async function readReplyContext(threadNodeId: string): Promise<ReplyContext | null> {
  try {
    const data = await graphql(
      `query ReplyContext($id: ID!) {
        node(id: $id) { ... on PullRequestReviewThread { path line comments(first: 1) { nodes { body author { login } } } } }
      }`,
      { id: threadNodeId }
    )
    const node = objOrNull(data.node, 'the thread')
    if (!node) return null
    const root = objOrNull(isObject(node.comments) && Array.isArray(node.comments.nodes) ? node.comments.nodes[0] : null, 'the thread’s first comment')
    return { path: optStr(node.path), line: optInt(node.line), body: optStr(root?.body), author: optStr(objOrNull(root?.author, 'its author')?.login) }
  } catch (err) {
    if (err instanceof GhTimeoutError) throw err
    return null
  }
}

interface DraftThreadInput {
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
  body: string
}

function threadInput(t: PlannedThread): DraftThreadInput {
  return {
    path: t.path,
    line: t.line,
    side: t.side,
    ...(t.startLine !== undefined ? { startLine: t.startLine, startSide: t.startSide } : {}),
    body: t.body,
  }
}

/** Whether GitHub holds `c` where the plan puts `t`, read off the comment itself. */
function sitsWhere(c: RemoteComment, t: PlannedThread): boolean {
  if (c.path === undefined || c.line === undefined) return true
  const start = (line: number | undefined, end: number): number | undefined => (line === undefined || line === end ? undefined : line)
  return c.path === t.path && c.line === t.line && start(c.startLine, c.line) === start(t.startLine, t.line) && (c.side === undefined || c.side === t.side)
}

async function addReview(pullRequestId: string, commitOID: string, body: string, threads: DraftThreadInput[]): Promise<string> {
  const data = await graphql(
    `mutation AddReview($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }`,
    { input: { pullRequestId, commitOID, body, threads } }
  )
  const review = objOrNull(objOrNull(data.addPullRequestReview, 'the new review')?.pullRequestReview, 'the new review')
  if (!review) throw new Error('GitHub created no review')
  return str(review.id, 'the new review id')
}

/** Null when GitHub placed no thread: a bad line answers `thread: null` without an error. */
async function addThread(pullRequestReviewId: string, input: DraftThreadInput): Promise<RemoteComment | null> {
  const data = await graphql(
    `mutation AddThread($input: AddPullRequestReviewThreadInput!) {
      addPullRequestReviewThread(input: $input) { thread { comments(first: 1) { nodes { ${COMMENT_FIELDS} } } } }
    }`,
    { input: { pullRequestReviewId, ...input } }
  )
  const thread = objOrNull(objOrNull(data.addPullRequestReviewThread, 'the new thread')?.thread, 'the new thread')
  if (!thread) return null
  const first = list(obj(thread.comments, 'the new thread’s comments').nodes, 'the new thread’s comments')[0]
  return first === undefined ? null : parseComment(first)
}

/** Always with `pullRequestReviewId`: without it, a reply posts at once. */
async function addReply(pullRequestReviewId: string, pullRequestReviewThreadId: string, body: string): Promise<RemoteComment | null> {
  const data = await graphql(
    `mutation AddReply($input: AddPullRequestReviewThreadReplyInput!) {
      addPullRequestReviewThreadReply(input: $input) { comment { ${COMMENT_FIELDS} } }
    }`,
    { input: { pullRequestReviewId, pullRequestReviewThreadId, body } }
  )
  const comment = objOrNull(objOrNull(data.addPullRequestReviewThreadReply, 'the reply')?.comment, 'the reply')
  return comment ? parseComment(comment) : null
}

async function updateComment(id: string, body: string): Promise<void> {
  await graphql(
    `mutation UpdateComment($input: UpdatePullRequestReviewCommentInput!) { updatePullRequestReviewComment(input: $input) { pullRequestReviewComment { id } } }`,
    { input: { pullRequestReviewCommentId: id, body } }
  )
}

async function deleteComment(id: string): Promise<void> {
  await graphql(
    `mutation DeleteComment($input: DeletePullRequestReviewCommentInput!) { deletePullRequestReviewComment(input: $input) { pullRequestReview { id } } }`,
    { input: { id } }
  )
}

async function submit(pullRequestReviewId: string, event: string, body: string): Promise<{ url?: string }> {
  const data = await graphql(
    `mutation SubmitReview($input: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $input) { pullRequestReview { id url state } } }`,
    { input: { pullRequestReviewId, event, body } }
  )
  const review = objOrNull(objOrNull(data.submitPullRequestReview, 'the submitted review')?.pullRequestReview, 'the submitted review')
  return { url: optStr(review?.url) }
}

/**
 * Drop a pending review and everything in it. One already gone counts as
 * done. Only for a review SimpleEdit created; `discardLayer` is what decides.
 */
export async function deletePendingReview(nodeId: string): Promise<void> {
  try {
    await graphql(
      `mutation DeleteReview($input: DeletePullRequestReviewInput!) { deletePullRequestReview(input: $input) { pullRequestReview { id } } }`,
      { input: { pullRequestReviewId: nodeId } }
    )
  } catch (err) {
    if (!isGraphqlType(err, 'NOT_FOUND')) throw err
  }
}

/** Take SimpleEdit's comments (those with a marker) out of a pending review, leaving the rest. */
async function deleteOwnComments(reviewId: string): Promise<void> {
  for (const c of await readReviewComments(reviewId)) {
    if (itemMarkerOf(c.body)) await deleteComment(c.id)
  }
}

/**
 * Undo what an unfinished attempt left on GitHub, for cancel or discard: a
 * pending review SimpleEdit created is deleted, one it adopted only loses
 * SimpleEdit's comments. A review that turns out to be submitted is left
 * alone, and a create that timed out is found by its claim marker.
 */
export async function discardLayer(pr: PrReviewTarget, state: ReviewLayerSubmission): Promise<void> {
  if (state.state === 'posted') return
  let reviewId = state.reviewNodeId
  if (reviewId) {
    const review = await readReview(reviewId)
    if (!review || review.state !== 'PENDING') return
  } else {
    const claim = state.claimToken
    if (!claim) return
    reviewId = (await readPr(pr)).pending.find((r) => r.body.includes(claimMarker(claim)))?.id
    if (!reviewId) return
  }
  try {
    if (state.adopted) await deleteOwnComments(reviewId)
    else await deletePendingReview(reviewId)
  } catch (err) {
    if (!isGraphqlType(err, 'NOT_FOUND')) throw err
  }
}

export type PrReviewTarget = Pick<PrRef, 'owner' | 'repo' | 'number' | 'url'>

export interface PostReviewLayerInput {
  pr: PrReviewTarget
  /** This layer's draft from the draft store. */
  draft: PrReviewDraft
  /** The head the user read: the review is pinned to it and every anchor checked against it. */
  readHead: string
  verdict: ReviewVerdict
  /** The user read a stacked diff with a different base than GitHub's, so LEFT anchors fold. */
  isolatedBase: boolean
  /** This layer's state from an earlier attempt of the same submission. */
  prior?: ReviewLayerSubmission
  /** The user chose to post into a pending review SimpleEdit didn't create. */
  adoptPendingReviewId?: string
  /**
   * Persist progress. Called before anything is created or added, again
   * with the review's id the moment it exists, after every comment that
   * lands, before the submit, and with the final state. Must not throw.
   */
  record: (state: ReviewLayerSubmission) => void
}

export interface PostReviewLayerResult {
  outcome: ReviewLayerSubmitOutcome
  /**
   * As last recorded. Once posted, `clear-posted` clears `postedCommentIds`
   * with `sent.summary` and `sent.verdict`.
   */
  state: ReviewLayerSubmission
}

/**
 * Post one layer's draft as one review. Never throws: every failure is an
 * outcome, and `unknown` (a `gh` call that timed out, so it may have landed)
 * is resumed by passing the recorded state back as `prior`.
 */
export async function postReviewLayer(input: PostReviewLayerInput): Promise<PostReviewLayerResult> {
  const { pr } = input
  let state: ReviewLayerSubmission = input.prior
    ? { ...input.prior, verdict: input.verdict }
    : { prUrl: pr.url, verdict: input.verdict, postedCommentIds: [], state: 'pending' }
  const save = (next: ReviewLayerSubmission): void => {
    state = next
    input.record(next)
  }
  if (state.state === 'posted') return { outcome: { prUrl: pr.url, kind: 'posted', reviewUrl: state.reviewUrl, folded: state.folded?.length ?? 0 }, state }
  try {
    const outcome = await post(input, () => state, save)
    return { outcome, state }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const timedOut = err instanceof GhTimeoutError
    save({ ...state, state: timedOut ? 'unknown' : 'failed' })
    return { outcome: timedOut ? { prUrl: pr.url, kind: 'unknown', error } : { prUrl: pr.url, kind: 'failed', error }, state }
  }
}

/**
 * The draft comments a review that was submitted already carried, as far as
 * they are still the version that went: one edited since stays in the draft.
 */
function stillAsSent(draft: PrReviewDraft, plan: LayerPlan, state: ReviewLayerSubmission): string[] {
  const now = new Map(draft.comments.map((c) => [c.id, c]))
  if (state.sent) {
    return state.sent.comments.filter((s) => {
      const c = now.get(s.draftId)
      return c !== undefined && commentRev(c) === s.rev
    }).map((s) => s.draftId)
  }
  // Submitted without our submit (the user finished it on GitHub): only the
  // comments that had landed in it went.
  const planned = new Map(plan.items.map((i) => [i.comment.id, i.rev]))
  return (state.items ?? []).filter((i) => planned.get(i.draftId) === i.draftRev).map((i) => i.draftId)
}

async function post(
  input: PostReviewLayerInput,
  current: () => ReviewLayerSubmission,
  save: (next: ReviewLayerSubmission) => void
): Promise<ReviewLayerSubmitOutcome> {
  const { pr, readHead } = input
  const refusal = reviewSubmitError({ ...input.draft, verdict: input.verdict })
  if (refusal) {
    save({ ...current(), state: 'failed' })
    return { prUrl: pr.url, kind: 'failed', error: refusal }
  }

  let commentable: ReturnType<typeof commentableLines> | undefined
  try {
    commentable = commentableLines(await prDiffAt(pr, readHead))
  } catch (err) {
    if (err instanceof GhTimeoutError) throw err
    console.warn('[SimpleEdit] Could not fetch the PR diff to check review anchors:', err)
  }
  const plan = planLayer(input.draft, readHead, { commentable, isolatedBase: input.isolatedBase })

  const remote = await readPr(pr)
  let pending = remote.pending
  let state = current()

  if (state.reviewNodeId && !pending.some((r) => r.id === state.reviewNodeId)) {
    const previous = await readReview(state.reviewNodeId)
    // Not pending and not gone: the earlier attempt's submit landed. A review
    // is never submitted twice.
    if (previous) {
      const ids = stillAsSent(input.draft, plan, state)
      save({
        ...state,
        state: 'posted',
        reviewUrl: previous.url,
        postedCommentIds: ids,
        sent: state.sent ?? { comments: [], summary: '', verdict: input.draft.verdict },
      })
      return { prUrl: pr.url, kind: 'posted', reviewUrl: previous.url, folded: countFolds(plan, foldedSet(plan, current())) }
    }
    save({ ...state, reviewNodeId: undefined, adopted: undefined, items: [], folded: [], sent: undefined })
    state = current()
  }

  const claimed = (r: PendingReview, s: ReviewLayerSubmission): boolean =>
    r.id === s.reviewNodeId || (s.claimToken !== undefined && r.body.includes(claimMarker(s.claimToken)))

  // A review pinned to another head than the one now being posted would put
  // these comments on code the user didn't read last. Nothing in it is
  // visible, so it is started over; an adopted one only loses our comments.
  if (state.readHead && state.readHead !== readHead) {
    const stale = pending.find((r) => claimed(r, state))
    if (stale) {
      if (state.adopted) await deleteOwnComments(stale.id)
      else await deletePendingReview(stale.id)
      if (!state.adopted) pending = pending.filter((r) => r !== stale)
    }
    save({ ...state, reviewNodeId: undefined, claimToken: undefined, adopted: undefined, items: [], folded: [], sent: undefined, readHead })
    state = current()
  }

  const ours = pending.find((r) => claimed(r, state) || r.id === input.adoptPendingReviewId)
  if (!ours && pending.length) {
    return { prUrl: pr.url, kind: 'foreign-pending', pendingReviewId: pending[0].id, commentCount: pending[0].commentCount }
  }

  let reviewId: string
  let existingBody = ''
  let headNow = remote.headRefOid
  if (ours) {
    const adopted = state.adopted === true || !claimed(ours, state)
    // GitHub pins a review to one commit; an adopted one started on another
    // would carry this approval to code the user didn't read here.
    if (adopted && ours.commitOid !== readHead) {
      save({ ...state, state: 'failed' })
      return {
        prUrl: pr.url,
        kind: 'failed',
        error:
          `Your pending review on GitHub is on commit ${(ours.commitOid ?? 'unknown').slice(0, 7)}, not ${readHead.slice(0, 7)} that you read here. ` +
          'Finish or delete it on GitHub, then post again.',
      }
    }
    reviewId = ours.id
    existingBody = withoutClaim(ours.body)
    save({ ...state, state: 'pending', readHead, reviewNodeId: reviewId, ...(adopted ? { adopted: true } : {}) })
  } else {
    const created = await create(input, plan, remote.id, current, save)
    reviewId = created.reviewId
    if (created.headNow) headNow = created.headNow
  }

  await reconcile(input, plan, reviewId, headNow, current, save)

  const folded = foldedSet(plan, current())
  const replyContext = new Map<string, ReplyContext | null>()
  for (const c of plan.draft.comments) {
    if (c.inReplyTo && folded.has(c.id)) replyContext.set(c.id, await readReplyContext(c.inReplyTo.threadNodeId))
  }
  const body = [existingBody, layerBody(plan, folded, pr.url, replyContext)].filter(Boolean).join('\n\n')
  const sent = {
    comments: input.draft.comments.map((c) => ({ draftId: c.id, rev: commentRev(c) })),
    summary: input.draft.summary,
    verdict: input.draft.verdict,
  }
  save({ ...current(), sent })
  const { url } = await submit(reviewId, REVIEW_EVENT[input.verdict], body)
  save({ ...current(), state: 'posted', reviewUrl: url, postedCommentIds: sent.comments.map((c) => c.draftId) })
  return { prUrl: pr.url, kind: 'posted', reviewUrl: url, folded: countFolds(plan, folded) }
}

/**
 * Start the pending review with every line thread in it. Returns the head the
 * PR is on when GitHub refused the threads, which decides whether `reconcile`
 * may still add them one by one.
 */
async function create(
  input: PostReviewLayerInput,
  plan: LayerPlan,
  pullRequestId: string,
  current: () => ReviewLayerSubmission,
  save: (next: ReviewLayerSubmission) => void
): Promise<{ reviewId: string; headNow?: string }> {
  const { readHead } = input
  const claimToken = current().claimToken ?? randomUUID().replace(/-/g, '')
  save({ ...current(), state: 'pending', readHead, claimToken, reviewNodeId: undefined, adopted: undefined, items: [], folded: [], sent: undefined })
  const claimBody = claimMarker(claimToken)
  const threads = plan.items.filter((i): i is PlannedThread => i.kind === 'thread').map(threadInput)
  let reviewId: string
  let headNow: string | undefined
  try {
    reviewId = await addReview(pullRequestId, readHead, claimBody, threads)
  } catch (err) {
    if (!threads.length || !isGraphqlType(err, 'UNPROCESSABLE')) throw refusedCommit(err, readHead)
    headNow = (await readPr(input.pr)).headRefOid
    try {
      reviewId = await addReview(pullRequestId, readHead, claimBody, [])
    } catch (retryErr) {
      throw refusedCommit(retryErr, readHead)
    }
  }
  save({ ...current(), reviewNodeId: reviewId })
  return { reviewId, headNow }
}

/** With no thread left to blame, GitHub refusing a review is GitHub refusing its commit. */
function refusedCommit(err: unknown, readHead: string): unknown {
  if (!isGraphqlType(err, 'UNPROCESSABLE')) return err
  return new Error(
    `GitHub refused to start a review on ${readHead.slice(0, 7)} (${err.message}). If the branch was force-pushed, ` +
      'that commit is no longer on the PR: reload it and review its current head. Nothing was posted.'
  )
}

/**
 * Bring the pending review in line with the plan: match what is there by
 * marker, update what changed, add what is missing, drop what the draft no
 * longer has. Every item is recorded as it lands.
 */
async function reconcile(
  input: PostReviewLayerInput,
  plan: LayerPlan,
  reviewId: string,
  headNow: string,
  current: () => ReviewLayerSubmission,
  save: (next: ReviewLayerSubmission) => void
): Promise<void> {
  const { readHead } = input
  const byDraft = new Map<string, RemoteComment>()
  for (const c of await readReviewComments(reviewId)) {
    const id = itemMarkerOf(c.body)
    if (id && !byDraft.has(id)) byDraft.set(id, c)
  }
  const recorded = new Map((current().items ?? []).map((i) => [i.draftId, i]))
  const landed = (item: PlannedItem, c: RemoteComment): void => {
    const entry: ReviewSubmissionItem = {
      draftId: item.comment.id,
      draftRev: item.rev,
      nodeId: c.id,
      ...(c.databaseId !== undefined ? { databaseId: c.databaseId } : {}),
    }
    const state = current()
    save({
      ...state,
      items: [...(state.items ?? []).filter((i) => i.draftId !== entry.draftId), entry],
      folded: (state.folded ?? []).filter((id) => id !== entry.draftId),
    })
  }
  const fold = (item: PlannedItem): void => {
    const state = current()
    save({
      ...state,
      items: (state.items ?? []).filter((i) => i.draftId !== item.comment.id),
      folded: [...new Set([...(state.folded ?? []), item.comment.id])],
    })
  }

  for (const item of plan.items) {
    let existing = byDraft.get(item.comment.id)
    if (existing && item.kind === 'thread') {
      const before = recorded.get(item.comment.id)
      // Nothing recorded (a create that timed out): GitHub's own placement says.
      const moved = before ? anchorPartOf(before.draftRev) !== anchorPartOf(item.rev) : !sitsWhere(existing, item)
      if (moved) {
        await deleteComment(existing.id)
        existing = undefined
      }
    }
    if (existing) {
      if (existing.body !== item.body) await updateComment(existing.id, item.body)
      landed(item, existing)
      continue
    }
    if ((current().folded ?? []).includes(item.comment.id)) continue
    if (item.kind === 'reply') {
      const reply = await tryGraphql(() => addReply(reviewId, item.threadNodeId, item.body))
      if (reply) landed(item, reply)
      else fold(item)
      continue
    }
    // Added one by one, a thread lands on the PR's current head, which is
    // only the code the user read while the head hasn't moved.
    if (headNow !== readHead) {
      fold(item)
      continue
    }
    const comment = await tryGraphql(() => addThread(reviewId, threadInput(item)))
    if (comment && comment.commitOid === readHead) {
      landed(item, comment)
      continue
    }
    if (comment) await deleteComment(comment.id)
    fold(item)
  }

  const planned = new Set(plan.items.map((i) => i.comment.id))
  for (const [draftId, c] of byDraft) {
    if (planned.has(draftId)) continue
    // A comment of ours whose draft was removed or now folds since the last attempt.
    await tryGraphql(() => deleteComment(c.id))
    const state = current()
    if (state.items?.some((i) => i.draftId === draftId)) save({ ...state, items: state.items.filter((i) => i.draftId !== draftId) })
  }
}

/** A per-item refusal is folded, not fatal; a `gh` that never got an answer still is. */
async function tryGraphql<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof GraphqlError) return null
    throw err
  }
}

/** Everything bound for the body: the plan's folds and GitHub's refusals, minus what landed on a line. */
function foldedSet(plan: LayerPlan, state: ReviewLayerSubmission): Set<string> {
  const landed = new Set((state.items ?? []).map((i) => i.draftId))
  return new Set([...plan.folded, ...(state.folded ?? [])].filter((id) => !landed.has(id)))
}

function countFolds(plan: LayerPlan, folded: ReadonlySet<string>): number {
  return [...folded].filter((id) => !plan.notes.has(id)).length
}
