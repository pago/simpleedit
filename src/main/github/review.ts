/**
 * The review composer's write path: one review per submit, posted through the
 * reviews API (the `gh pr review` CLI can't attach per-line comments — only the
 * API's `comments[]` can).
 *
 * Every anchor is checked against GitHub's own diff of the PR before it is
 * sent, one comment at a time, because GitHub answers a single bad anchor by
 * rejecting the whole review (plans/screen-prs.md §3.4).
 */
import type { PrRef, ReviewFolds, GithubReviewPayload, CommentableSides } from '../../shared/screenprs'
import { addFolds, anchorsForHead, buildReviewPayload, commentableLines, foldCommentsIntoBody, reviewFolds } from '../../shared/screenprs'
import type { SubmitReviewRequest } from '../../shared/ipc-types'
import { getPrDiff, runGh } from './gh'

export interface PostReviewResult {
  /** The created review's html_url, if GitHub returned one. */
  reviewUrl?: string
  /** How many anchors GitHub refused, which put all of them in the body. */
  rejected: number
}

/** The subset of a PR we need to address the reviews endpoint. */
export type PrReviewTarget = Pick<PrRef, 'owner' | 'repo' | 'number'>

function htmlUrlOf(out: string): string | undefined {
  try {
    return (JSON.parse(out) as { html_url?: string }).html_url
  } catch {
    return undefined
  }
}

/**
 * Post a single review. The JSON body goes over stdin (`--input -`) because it
 * nests an array. If GitHub still rejects an anchor (422), retry once with
 * every comment folded into the body so the content survives — by now only
 * the last resort, since `submitReview` has checked each anchor already.
 */
export async function postReview(pr: PrReviewTarget, payload: GithubReviewPayload): Promise<PostReviewResult> {
  const endpoint = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
  const post = (body: GithubReviewPayload): Promise<string> =>
    runGh(['api', '--method', 'POST', endpoint, '--input', '-'], { input: JSON.stringify(body) })
  try {
    return { reviewUrl: htmlUrlOf(await post(payload)), rejected: 0 }
  } catch (err) {
    // Only the anchor-rejection case is recoverable by folding. A 422 is GitHub
    // saying a comment's line isn't part of the diff; any other failure (auth,
    // network, 5xx) would just fail again — rethrow so the real error surfaces.
    const msg = err instanceof Error ? err.message : String(err)
    if (payload.comments.length === 0 || !/\b422\b|unprocessable/i.test(msg)) throw err
    // A head force-pushed out of the PR 422s too. With nothing left on a line
    // the pin has no job, so it goes rather than failing the retry the same way.
    const folded = foldCommentsIntoBody(payload)
    delete folded.commit_id
    return { reviewUrl: htmlUrlOf(await post(folded)), rejected: payload.comments.length }
  }
}

/**
 * Post a review draft. A failed fetch of GitHub's diff doesn't block the
 * submit: the anchors then go unchecked, as they did before checking existed,
 * and `postReview`'s fallback is what catches a bad one.
 */
export async function submitReview(request: SubmitReviewRequest): Promise<{ reviewUrl?: string; folded: ReviewFolds }> {
  let commentable: Map<string, CommentableSides> | undefined
  try {
    commentable = commentableLines(await getPrDiff(request.pr))
  } catch (err) {
    console.warn('[SimpleEdit] Could not fetch the PR diff to check review anchors:', err)
  }
  const opts = { commentable, headSha: request.headSha, isolatedBase: request.isolatedBase }
  const draft = request.headSha ? anchorsForHead(request.draft, request.headSha) : request.draft
  const { reviewUrl, rejected } = await postReview(request.pr, buildReviewPayload(draft, opts))
  return { reviewUrl, folded: addFolds(reviewFolds(request.draft, opts), 'rejected', rejected) }
}
