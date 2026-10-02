import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../gh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gh')>()),
  runGh: vi.fn(),
  getPrDiff: vi.fn(),
}))

import { runGh, getPrDiff, GhTimeoutError } from '../gh'
import { handleSubmitReview, postReview, submitReview } from '../review'
import type { GithubReviewPayload, PrReviewComment } from '../../../shared/screenprs'
import type { SubmitReviewRequest } from '../../../shared/ipc-types'

const GH_DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@
 keep10
-gone11
+new11
+new12
 keep12
`

const PR = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7' }
const HEAD = 'head1'
const you = (over: Partial<PrReviewComment>): PrReviewComment => ({ id: over.id ?? 'c', source: 'you', file: 'a.ts', text: 'n', sha: HEAD, ...over })
const request = (comments: PrReviewComment[], over: Partial<SubmitReviewRequest> = {}): SubmitReviewRequest => ({
  pr: PR,
  draft: { comments, summary: 'LGTM', verdict: 'comment' },
  headSha: HEAD,
  ...over,
})

/** The same PR at the older head `head0`, one added line shorter. */
const GH_DIFF_HEAD0 = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,3 @@
 keep10
-gone11
+new11
 keep12
`

const isPost = (args: string[]): boolean => args.includes('POST')

/** Every payload POSTed, in order. */
function posted(): GithubReviewPayload[] {
  return vi.mocked(runGh).mock.calls.filter(([args]) => isPost(args)).map(([, opts]) => JSON.parse(opts?.input ?? '{}') as GithubReviewPayload)
}

/** The reviews endpoint's answers, in order; `runGh`'s other reads are routed by args. */
const post = vi.fn<() => Promise<string>>()
let headOnGithub = HEAD

beforeEach(() => {
  headOnGithub = HEAD
  post.mockReset().mockResolvedValue(JSON.stringify({ html_url: 'https://github.com/acme/app/pull/7#r1' }))
  vi.mocked(runGh).mockReset().mockImplementation(async (args) => {
    if (isPost(args)) return post()
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ baseRefOid: 'base1', headRefOid: headOnGithub })
    if (args.at(-1) === 'repos/acme/app/compare/base1...head0') return GH_DIFF_HEAD0
    throw new Error(`unexpected gh ${args.join(' ')}`)
  })
  vi.mocked(getPrDiff).mockReset().mockResolvedValue(GH_DIFF)
})

describe('submitReview', () => {
  it('folds the one anchor outside GitHub\'s diff and keeps the rest on their lines', async () => {
    const res = await submitReview(request([you({ id: 'a', line: '11' }), you({ id: 'b', line: '40', text: 'far' })]))
    const [payload] = posted()
    expect(payload.comments).toEqual([{ path: 'a.ts', line: 11, side: 'RIGHT', body: 'n' }])
    expect(payload.body).toContain('a.ts:40 — far')
    expect(res).toEqual({ reviewUrl: 'https://github.com/acme/app/pull/7#r1', folded: { count: 1, reasons: { 'not-in-diff': 1 } } })
  })

  it('pins the review to the head on screen', async () => {
    await submitReview(request([you({ line: '11' })]))
    expect(posted()[0].commit_id).toBe(HEAD)
    expect(vi.mocked(runGh).mock.calls.find(([args]) => isPost(args))?.[0]).toEqual(['api', '--method', 'POST', 'repos/acme/app/pulls/7/reviews', '--input', '-'])
  })

  it('checks anchors against the diff at the pinned head once the branch has moved', async () => {
    // Line 13 is in the latest head's hunk only; pinned to head0, GitHub would refuse it.
    headOnGithub = 'head2'
    const sha = 'head0'
    const res = await submitReview(request([you({ id: 'a', line: '11', sha }), you({ id: 'b', line: '13', sha })], { headSha: sha }))
    expect(runGh).toHaveBeenCalledWith(['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github.diff', 'repos/acme/app/compare/base1...head0'])
    expect(posted()[0].comments).toEqual([{ path: 'a.ts', line: 11, side: 'RIGHT', body: 'n' }])
    expect(res.folded).toEqual({ count: 1, reasons: { 'not-in-diff': 1 } })
  })

  it('posts unchecked when the diff at the pinned head cannot be fetched', async () => {
    headOnGithub = 'head2'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await submitReview(request([you({ line: '40', sha: 'gone' })], { headSha: 'gone' }))
    expect(posted()[0].comments).toEqual([{ path: 'a.ts', line: 40, side: 'RIGHT', body: 'n' }])
    expect(res.folded.count).toBe(0)
  })

  it('folds anchors from another head, or none, and says which', async () => {
    const res = await submitReview(
      request([you({ id: 'a', line: '11', sha: 'old' }), you({ id: 'b', line: '12', sha: undefined }), you({ id: 'c', line: '11' })])
    )
    expect(posted()[0].comments).toHaveLength(1)
    expect(res.folded).toEqual({ count: 2, reasons: { moved: 1, unverified: 1 } })
  })

  it('does not count a note that never had a line', async () => {
    const res = await submitReview(request([you({ file: '', line: undefined })]))
    expect(res.folded).toEqual({ count: 0, reasons: {} })
  })

  it('folds a deleted-line comment read off an isolated stacked diff', async () => {
    const res = await submitReview(request([you({ line: '11', side: 'LEFT' })], { isolatedBase: true }))
    expect(posted()[0].comments).toEqual([])
    expect(res.folded.reasons).toEqual({ 'isolated-base': 1 })
  })

  it('posts unchecked when GitHub\'s diff cannot be fetched', async () => {
    vi.mocked(getPrDiff).mockRejectedValue(new Error('gh pr diff exited 1'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await submitReview(request([you({ line: '40' })]))
    expect(posted()[0].comments).toEqual([{ path: 'a.ts', line: 40, side: 'RIGHT', body: 'n' }])
    expect(res.folded.count).toBe(0)
  })

  it('leaves the head check to the client when no head is sent', async () => {
    await submitReview(request([you({ line: '11', sha: 'old' })], { headSha: undefined }))
    expect(posted()[0].comments).toHaveLength(1)
    expect(posted()[0].commit_id).toBeUndefined()
  })

  it('still folds everything when GitHub refuses an anchor', async () => {
    post.mockRejectedValueOnce(new Error('gh api exited 1: HTTP 422 Unprocessable Entity'))
    vi.mocked(getPrDiff).mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await submitReview(request([you({ id: 'a', line: '11' }), you({ id: 'b', line: '40' })]))
    const [, retry] = posted()
    expect(retry.comments).toEqual([])
    expect(retry.body).toContain('a.ts:11 — n')
    expect(retry.body).toContain('a.ts:40 — n')
    expect(retry.commit_id).toBeUndefined()
    expect(res.folded).toEqual({ count: 2, reasons: { rejected: 2 } })
  })
})

describe('handleSubmitReview', () => {
  it('clears the draft it posted', async () => {
    const clear = vi.fn()
    expect(await handleSubmitReview(request([you({ line: '11' })], { clearDraft: true }), clear)).toMatchObject({ ok: true })
    expect(clear).toHaveBeenCalledWith(PR.url)
  })

  it('keeps the draft when the caller does not ask to clear it', async () => {
    const clear = vi.fn()
    const res = await handleSubmitReview(request([], { draft: { comments: [], summary: '', verdict: 'approve' } }), clear)
    expect(res).toMatchObject({ ok: true })
    expect(posted()[0].event).toBe('APPROVE')
    expect(clear).not.toHaveBeenCalled()
  })

  it('keeps the draft when nothing was posted', async () => {
    const clear = vi.fn()
    post.mockRejectedValueOnce(new Error('HTTP 401'))
    expect(await handleSubmitReview(request([], { clearDraft: true }), clear)).toEqual({ ok: false, error: 'HTTP 401' })
    expect(clear).not.toHaveBeenCalled()
  })

  it('says a killed post may have landed', async () => {
    post.mockRejectedValueOnce(new GhTimeoutError('gh api did not finish'))
    expect(await handleSubmitReview(request([]), vi.fn())).toMatchObject({ ok: false, delivered: 'unknown' })
  })
})

describe('postReview', () => {
  const payload: GithubReviewPayload = { event: 'COMMENT', body: '', comments: [{ path: 'a.ts', line: 1, side: 'RIGHT', body: 'n' }] }

  it('rethrows a failure that folding cannot fix', async () => {
    post.mockRejectedValueOnce(new Error('gh api exited 1: HTTP 401'))
    await expect(postReview(PR, payload)).rejects.toThrow('401')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('rethrows a 422 when there were no anchors to blame', async () => {
    post.mockRejectedValueOnce(new Error('HTTP 422'))
    await expect(postReview(PR, { ...payload, comments: [] })).rejects.toThrow('422')
  })
})
