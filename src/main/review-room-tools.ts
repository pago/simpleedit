import { getCachedDiff } from './screenprs-cache'
import { baseKey, createBaseResolver, getReviewDiff, type ReviewDiffTarget } from './github/stack-base'
import { runGh } from './github/gh'
import { threadsForSession } from './agent-threads-store'
import {
  appendReviewMessage,
  getReview,
  getReviewThread,
  reviewsForSession,
  setReviewProposal,
  threadsForReview,
} from './review-room-store'
import type { ReviewRoomTools } from './mcp-bridge'
import { draftLinksForThread } from './screenprs-drafts'
import { checkoutReviewHead } from './review-checkout'
import { isReviewId, type Review, type ReviewChange, type ReviewPrRef, type ReviewSeverity } from '../shared/review-room'

type ReviewRole = 'companion' | 'requester'

function reviewRole(review: Review, terminalId: string): ReviewRole | null {
  if (review.companion?.sessionId === terminalId) return 'companion'
  if (review.requesterSessionId === terminalId) return 'requester'
  return null
}

function reviewThreadsForCaller(
  terminalId: string,
  requestedReviewId: string | undefined,
  draftCommentId: (threadId: string) => string | undefined,
): Array<Record<string, unknown>> {
  const reviews = requestedReviewId
    ? (() => {
        if (!isReviewId(requestedReviewId)) throw new Error('Malformed review_id')
        const review = getReview(requestedReviewId)
        if (!review || !reviewRole(review, terminalId)) throw new Error('Review is not available to this session')
        return [review]
      })()
    : reviewsForSession(terminalId)
  return reviews.flatMap((review) => {
    const role = reviewRole(review, terminalId)
    return threadsForReview(review.id)
      .filter((thread) => role === 'companion' || thread.askAuthorOpen)
      .map((thread) => {
        const commentId = draftCommentId(thread.id)
        return { kind: 'review', review_id: review.id, ...thread, ...(commentId ? { draftCommentId: commentId } : {}) }
      })
  })
}

export const REVIEW_DIFF_LIMIT = 120 * 1024

export function capReviewDiff(diff: string): { diff: string; truncated: boolean; originalChars: number } {
  if (diff.length <= REVIEW_DIFF_LIMIT) return { diff, truncated: false, originalChars: diff.length }
  const cut = diff.lastIndexOf('\n', REVIEW_DIFF_LIMIT)
  return {
    diff: `${diff.slice(0, cut > 0 ? cut : REVIEW_DIFF_LIMIT)}\n\n[SimpleEdit truncated this review diff at ${REVIEW_DIFF_LIMIT} characters.]`,
    truncated: true,
    originalChars: diff.length,
  }
}

async function diffTarget(layer: ReviewPrRef): Promise<ReviewDiffTarget> {
  const raw = JSON.parse(
    await runGh(['pr', 'view', layer.url, '--json', 'baseRefName,baseRefOid,headRefOid']),
  ) as { baseRefName?: unknown; baseRefOid?: unknown; headRefOid?: unknown }
  if (
    typeof raw.baseRefName !== 'string' ||
    typeof raw.baseRefOid !== 'string' ||
    typeof raw.headRefOid !== 'string'
  ) throw new Error('GitHub returned incomplete pull-request metadata')
  return { url: layer.url, baseRefName: raw.baseRefName, baseRefOid: raw.baseRefOid, headSha: raw.headRefOid }
}

function sameDiffTarget(a: ReviewDiffTarget, b: ReviewDiffTarget): boolean {
  return a.headSha === b.headSha && a.baseRefName === b.baseRefName && a.baseRefOid === b.baseRefOid
}

async function diffForLayer(layer: ReviewPrRef): Promise<string> {
  const target = await diffTarget(layer)
  if (target.headSha !== layer.headSha) throw new Error('The PR head changed; refresh the review before reading its diff')
  const resolver = createBaseResolver()
  const key = await baseKey(target, resolver)
  const cached = getCachedDiff(layer.url, layer.headSha, key)
  if (cached !== undefined) return cached
  const diff = (await getReviewDiff(target, resolver)).diff
  if (!sameDiffTarget(target, await diffTarget(layer))) {
    throw new Error('The PR changed while its review diff was loading; try again')
  }
  return diff
}

export function createReviewRoomTools(deps: {
  broadcast: (changes: ReviewChange[]) => void
  markReplied: (sessionId: string, threadId: string) => void
  diffForLayer?: (layer: ReviewPrRef) => Promise<string>
  draftCommentId?: (threadId: string) => string | undefined
  checkoutHead?: typeof checkoutReviewHead
}): ReviewRoomTools {
  return {
    listThreads(terminalId, input) {
      const status = input['status']
      if (status !== undefined && status !== 'open' && status !== 'done') throw new Error('status must be open or done')
      const requested = input['review_id']
      if (requested !== undefined && typeof requested !== 'string') throw new Error('review_id must be a string')
      const reviewThreads = reviewThreadsForCaller(
        terminalId,
        requested,
        deps.draftCommentId ?? ((threadId) => draftLinksForThread(threadId)[0]?.commentId),
      )
      const agentThreads = requested === undefined
        ? threadsForSession(terminalId).map((thread) => ({
            kind: 'agent',
            ...thread,
            status: thread.status === 'resolved' ? 'done' : 'open',
          }))
        : []
      return {
        ok: true,
        threads: [...agentThreads, ...reviewThreads].filter((thread) => status === undefined || thread.status === status),
      }
    },
    reply(terminalId, threadId, body) {
      if (!body.trim()) return { ok: false, error: 'reply_to_thread needs a non-empty `body`.' }
      if (body.length > 64 * 1024) return { ok: false, error: 'reply_to_thread body is too large.' }
      const thread = getReviewThread(threadId)
      const review = thread ? getReview(thread.reviewId) : null
      if (!thread || !review) return { ok: false, error: `Unknown thread "${threadId}".` }
      const role = reviewRole(review, terminalId)
      if (!role) return { ok: false, error: 'That review thread belongs to another session.' }
      if (role === 'requester' && !thread.askAuthorOpen) {
        return { ok: false, error: 'The companion has not asked the author in this thread.' }
      }
      const change = appendReviewMessage(
        thread.id,
        role === 'companion' ? 'companion' : 'author',
        body,
        role === 'requester' ? { closeAskAuthor: true } : {},
      )
      if (!change) return { ok: false, error: 'The review thread changed before the reply was recorded.' }
      deps.broadcast([change])
      if (role === 'companion') deps.markReplied(terminalId, thread.id)
      return { ok: true }
    },
    async getDiff(terminalId, reviewId, pr) {
      if (!isReviewId(reviewId) || !Number.isSafeInteger(pr) || pr < 1) throw new Error('Malformed review diff request')
      const review = getReview(reviewId)
      if (!review || review.companion?.sessionId !== terminalId) throw new Error('Only this review\'s companion may read its diff')
      const layer = review.layers.find((candidate) => candidate.number === pr)
      if (!layer) throw new Error(`PR #${pr} is not a layer of this review`)
      const diff = await (deps.diffForLayer ?? diffForLayer)(layer)
      return { ok: true, review_id: review.id, pr: layer.number, url: layer.url, head_sha: layer.headSha, ...capReviewDiff(diff) }
    },
    async checkoutHead(terminalId, reviewId, pr) {
      if (!isReviewId(reviewId) || (pr !== undefined && (!Number.isSafeInteger(pr) || pr < 1))) {
        throw new Error('Malformed checkout request')
      }
      const review = getReview(reviewId)
      if (!review || review.status !== 'open' || review.companion?.sessionId !== terminalId) {
        throw new Error('Only this review\'s companion may check out its code')
      }
      const result = await (deps.checkoutHead ?? checkoutReviewHead)(review, pr)
      return {
        ok: true,
        review_id: review.id,
        pr: result.pr,
        head_sha: result.headSha,
        path: result.path,
        note: 'A read-only checkout of the PR head. Read files here by absolute path; do not modify them.',
      }
    },
    proposeDraft(terminalId, threadId, text, severity) {
      if (!text.trim() || text.length > 64 * 1024) return { ok: false, error: 'propose_draft needs non-empty text within 65536 characters.' }
      if (severity !== undefined && severity !== 'blocking' && severity !== 'consider' && severity !== 'nit') {
        return { ok: false, error: 'severity must be blocking, consider, or nit.' }
      }
      const thread = getReviewThread(threadId)
      const review = thread ? getReview(thread.reviewId) : null
      if (!thread || !review) return { ok: false, error: `Unknown thread "${threadId}".` }
      if (review.companion?.sessionId !== terminalId) return { ok: false, error: 'Only this review\'s companion may propose a draft.' }
      const change = setReviewProposal(thread.id, text, severity as ReviewSeverity | undefined)
      if (change) deps.broadcast([change])
      return { ok: true }
    },
  }
}
