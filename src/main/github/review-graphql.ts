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

/**
 * `gh api graphql` exits non-zero when the answer has `errors` but still
 * prints the answer on stdout, so stdout is read whatever the exit code; an
 * empty one means gh failed before GitHub answered (auth, network).
 */
async function graphql<T>(query: string, variables: Fields): Promise<T> {
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
  return answer.data as T
}

const isGraphqlType = (err: unknown, type: string): err is GraphqlError => err instanceof GraphqlError && err.types.includes(type)

interface RemoteComment {
  id: string
  fullDatabaseId?: string | number | null
  body: string
  commit?: { oid: string } | null
}

interface PendingReview {
  id: string
  body: string
  viewerDidAuthor: boolean
  comments: { totalCount: number }
}

const COMMENT_FIELDS = 'id fullDatabaseId body commit { oid }'

async function readPr(pr: PrReviewTarget): Promise<{ id: string; headRefOid: string; pending: PendingReview[] }> {
  const data = await graphql<{ repository: { pullRequest: { id: string; headRefOid: string; reviews: { nodes: PendingReview[] } } | null } | null }>(
    `query PendingReviews($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id headRefOid
          reviews(states: [PENDING], first: 20) { nodes { id body viewerDidAuthor comments(first: 1) { totalCount } } }
        }
      }
    }`,
    { owner: pr.owner, repo: pr.repo, number: pr.number }
  )
  const found = data.repository?.pullRequest
  if (!found) throw new Error(`GitHub has no pull request ${pr.owner}/${pr.repo}#${pr.number}`)
  return { id: found.id, headRefOid: found.headRefOid, pending: found.reviews.nodes.filter((r) => r.viewerDidAuthor) }
}

async function readHeadRefOid(pr: PrReviewTarget): Promise<string> {
  return (await readPr(pr)).headRefOid
}

async function readReviewComments(reviewId: string): Promise<RemoteComment[]> {
  const out: RemoteComment[] = []
  let after: string | null = null
  for (;;) {
    const data: { node: { comments: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RemoteComment[] } } | null } = await graphql(
      `query ReviewComments($id: ID!, $after: String) {
        node(id: $id) { ... on PullRequestReview { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } } } }
      }`,
      { id: reviewId, after }
    )
    if (!data.node) throw new GraphqlError(`Review ${reviewId} is gone`, ['NOT_FOUND'])
    out.push(...data.node.comments.nodes)
    if (!data.node.comments.pageInfo.hasNextPage) return out
    after = data.node.comments.pageInfo.endCursor
  }
}

/** A review's state and url, or null once it is deleted. */
async function readReview(reviewId: string): Promise<{ state: string; url?: string } | null> {
  try {
    const data = await graphql<{ node: { state?: string; url?: string } | null }>(
      `query ReviewState($id: ID!) { node(id: $id) { ... on PullRequestReview { state url } } }`,
      { id: reviewId }
    )
    return data.node?.state ? { state: data.node.state, url: data.node.url } : null
  } catch (err) {
    if (isGraphqlType(err, 'NOT_FOUND')) return null
    throw err
  }
}

async function readReplyContext(threadNodeId: string): Promise<ReplyContext | null> {
  try {
    const data = await graphql<{ node: { path?: string; line?: number | null; comments?: { nodes: Array<{ body: string; author?: { login: string } | null }> } } | null }>(
      `query ReplyContext($id: ID!) {
        node(id: $id) { ... on PullRequestReviewThread { path line comments(first: 1) { nodes { body author { login } } } } }
      }`,
      { id: threadNodeId }
    )
    const root = data.node?.comments?.nodes[0]
    if (!data.node) return null
    return { path: data.node.path, line: data.node.line ?? undefined, body: root?.body, author: root?.author?.login }
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

async function addReview(pullRequestId: string, commitOID: string, body: string, threads: DraftThreadInput[]): Promise<string> {
  const data = await graphql<{ addPullRequestReview: { pullRequestReview: { id: string } | null } | null }>(
    `mutation AddReview($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }`,
    { input: { pullRequestId, commitOID, body, threads } }
  )
  const id = data.addPullRequestReview?.pullRequestReview?.id
  if (!id) throw new Error('GitHub created no review')
  return id
}

/** Null when GitHub placed no thread: a bad line answers `thread: null` without an error. */
async function addThread(pullRequestReviewId: string, input: DraftThreadInput): Promise<RemoteComment | null> {
  const data = await graphql<{ addPullRequestReviewThread: { thread: { comments: { nodes: RemoteComment[] } } | null } | null }>(
    `mutation AddThread($input: AddPullRequestReviewThreadInput!) {
      addPullRequestReviewThread(input: $input) { thread { comments(first: 1) { nodes { ${COMMENT_FIELDS} } } } }
    }`,
    { input: { pullRequestReviewId, ...input } }
  )
  return data.addPullRequestReviewThread?.thread?.comments.nodes[0] ?? null
}

/** Always with `pullRequestReviewId`: without it, a reply posts at once. */
async function addReply(pullRequestReviewId: string, pullRequestReviewThreadId: string, body: string): Promise<RemoteComment | null> {
  const data = await graphql<{ addPullRequestReviewThreadReply: { comment: RemoteComment | null } | null }>(
    `mutation AddReply($input: AddPullRequestReviewThreadReplyInput!) {
      addPullRequestReviewThreadReply(input: $input) { comment { ${COMMENT_FIELDS} } }
    }`,
    { input: { pullRequestReviewId, pullRequestReviewThreadId, body } }
  )
  return data.addPullRequestReviewThreadReply?.comment ?? null
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
  const data = await graphql<{ submitPullRequestReview: { pullRequestReview: { url?: string } | null } | null }>(
    `mutation SubmitReview($input: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $input) { pullRequestReview { id url state } } }`,
    { input: { pullRequestReviewId, event, body } }
  )
  return { url: data.submitPullRequestReview?.pullRequestReview?.url }
}

/**
 * Drop a pending review and everything in it (cancel, discard, or a pending
 * review the user chose to throw away). One already gone counts as done.
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
   * lands, and with the final state. Must not throw.
   */
  record: (state: ReviewLayerSubmission) => void
}

export interface PostReviewLayerResult {
  outcome: ReviewLayerSubmitOutcome
  /** As last recorded. Once posted, `postedCommentIds` is what `clear-posted` clears. */
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
      save({ ...state, state: 'posted', reviewUrl: previous.url, postedCommentIds: input.draft.comments.map((c) => c.id) })
      return { prUrl: pr.url, kind: 'posted', reviewUrl: previous.url, folded: countFolds(plan, foldedSet(plan, current())) }
    }
    save({ ...state, reviewNodeId: undefined, items: [], folded: [] })
    state = current()
  }

  // A review pinned to another head than the one now being posted would put
  // these comments on code the user didn't read last. It is ours and nothing
  // in it is visible, so it is started over.
  if (state.readHead && state.readHead !== readHead) {
    const stale = pending.find((r) => r.id === state.reviewNodeId)
    if (stale) await deletePendingReview(stale.id)
    pending = pending.filter((r) => r !== stale)
    save({ ...state, reviewNodeId: undefined, claimToken: undefined, items: [], folded: [], readHead })
    state = current()
  }

  const claim = state.claimToken
  const ours = pending.find(
    (r) => r.id === state.reviewNodeId || r.id === input.adoptPendingReviewId || (claim !== undefined && r.body.includes(claimMarker(claim)))
  )
  if (!ours && pending.length) {
    return { prUrl: pr.url, kind: 'foreign-pending', pendingReviewId: pending[0].id, commentCount: pending[0].comments.totalCount }
  }

  let reviewId: string
  let existingBody = ''
  let headNow = remote.headRefOid
  if (ours) {
    reviewId = ours.id
    existingBody = withoutClaim(ours.body)
    save({ ...state, state: 'pending', readHead, reviewNodeId: reviewId })
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
  const { url } = await submit(reviewId, REVIEW_EVENT[input.verdict], body)
  save({ ...current(), state: 'posted', reviewUrl: url, postedCommentIds: input.draft.comments.map((c) => c.id) })
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
  save({ ...current(), state: 'pending', readHead, claimToken, reviewNodeId: undefined, items: [], folded: [] })
  const claimBody = claimMarker(claimToken)
  const threads = plan.items.filter((i): i is PlannedThread => i.kind === 'thread').map(threadInput)
  let reviewId: string
  let headNow: string | undefined
  try {
    reviewId = await addReview(pullRequestId, readHead, claimBody, threads)
  } catch (err) {
    if (!threads.length || !isGraphqlType(err, 'UNPROCESSABLE')) throw refusedCommit(err, readHead)
    headNow = await readHeadRefOid(input.pr)
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
      ...(c.fullDatabaseId != null ? { databaseId: String(c.fullDatabaseId) } : {}),
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
    const before = recorded.get(item.comment.id)
    if (existing && item.kind === 'thread' && before && anchorPartOf(before.draftRev) !== anchorPartOf(item.rev)) {
      await deleteComment(existing.id)
      existing = undefined
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
    if (comment && comment.commit?.oid === readHead) {
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
