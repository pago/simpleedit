import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gh = vi.hoisted(() => ({ runGh: vi.fn<(args: string[]) => Promise<string>>() }))
vi.mock('../github/gh', async (importOriginal) => ({ ...(await importOriginal<typeof import('../github/gh')>()), runGh: gh.runGh }))
vi.mock('../github/stack-base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../github/stack-base')>()),
  baseKey: vi.fn(async () => 'base-key'),
  getReviewDiff: vi.fn(async () => ({ diff: 'diff --git a/x b/x' })),
}))
vi.mock('../screenprs-cache', () => ({ getCachedDiff: vi.fn(() => undefined) }))
import { getDb, openDb, useDbForTests } from '../db'
import { addMainReviewThread, claimCompanion, createReview, getReviewThread } from '../review-room-store'
import { createReviewRoomTools, REVIEW_DIFF_LIMIT } from '../review-room-tools'

const layer = { url: 'https://github.com/acme/repo/pull/42', number: 42, headSha: 'abc123' }

function setupReview(): { reviewId: string; threadId: string } {
  const review = createReview({
    id: 'r_review01',
    repo: 'github.com/acme/repo',
    layers: [layer],
    companionAgent: { provider: 'claude', model: 'sonnet' },
    requesterSessionId: 'requester',
  }).review!
  claimCompanion(review.id, 1, 'claim-1', 'companion', { provider: 'claude', model: 'sonnet' })
  const change = addMainReviewThread({
    id: 'rt_thread01',
    reviewId: review.id,
    anchor: { kind: 'pr', pr: 42 },
    origin: { kind: 'user' },
    author: 'reviewer',
    body: 'Please check this',
  })
  return { reviewId: review.id, threadId: change.threadId }
}

describe('Review Room MCP tools', () => {
  beforeEach(() => useDbForTests(openDb(':memory:')))
  afterEach(() => useDbForTests(null))

  it('scopes list_threads by persisted companion/requester roles', () => {
    const { reviewId } = setupReview()
    const tools = createReviewRoomTools({ broadcast: () => {}, markReplied: () => {}, draftCommentId: () => undefined })
    expect((tools.listThreads('companion', {})['threads'] as unknown[])).toHaveLength(1)
    expect((tools.listThreads('requester', {})['threads'] as unknown[])).toHaveLength(0)
    expect(() => tools.listThreads('unrelated', { review_id: reviewId })).toThrow(/not available/)
  })

  it('lets requesters answer only an open Ask-author request and closes it atomically', () => {
    const { threadId } = setupReview()
    const tools = createReviewRoomTools({ broadcast: () => {}, markReplied: () => {}, draftCommentId: () => undefined })
    expect(tools.reply('requester', threadId, 'answer')).toMatchObject({ ok: false })

    getDb().prepare('UPDATE review_threads SET ask_author_open = 1 WHERE id = ?').run(threadId)
    expect((tools.listThreads('requester', {})['threads'] as unknown[])).toHaveLength(1)
    expect(tools.reply('requester', threadId, 'answer')).toEqual({ ok: true })
    const thread = getReviewThread(threadId)!
    expect(thread.askAuthorOpen).toBe(false)
    expect(thread.messages.at(-1)).toMatchObject({ author: 'author', body: 'answer' })
    expect(tools.reply('requester', threadId, 'again')).toMatchObject({ ok: false })
  })

  it('authorizes proposals and diffs only for the persisted companion', async () => {
    const { reviewId, threadId } = setupReview()
    const broadcast = vi.fn()
    const diffForLayer = vi.fn(async () => `${'x'.repeat(REVIEW_DIFF_LIMIT)}\n${'y'.repeat(100)}`)
    const tools = createReviewRoomTools({ broadcast, markReplied: () => {}, diffForLayer, draftCommentId: () => undefined })

    expect(tools.proposeDraft('requester', threadId, 'rewrite', 'blocking')).toMatchObject({ ok: false })
    expect(tools.proposeDraft('companion', threadId, 'rewrite', 'blocking')).toEqual({ ok: true })
    expect(getReviewThread(threadId)?.proposal).toEqual({ text: 'rewrite', severity: 'blocking' })
    await expect(tools.getDiff('requester', reviewId, 42)).rejects.toThrow(/companion/)
    await expect(tools.getDiff('companion', reviewId, 99)).rejects.toThrow(/not a layer/)
    const result = await tools.getDiff('companion', reviewId, 42)
    expect(result['truncated']).toBe(true)
    expect(result['diff']).toContain('truncated')
  })

  it("records a companion's explicit reply and marks the thread replied for the turn", () => {
    const { threadId } = setupReview()
    const broadcast = vi.fn()
    const markReplied = vi.fn()
    const tools = createReviewRoomTools({ broadcast, markReplied, draftCommentId: () => undefined })
    expect(tools.reply('companion', threadId, 'It is real.')).toEqual({ ok: true })
    expect(getReviewThread(threadId)?.messages.at(-1)).toMatchObject({ author: 'companion', body: 'It is real.' })
    expect(markReplied).toHaveBeenCalledWith('companion', threadId)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it("refuses an unrelated session's reply and records nothing", () => {
    const { threadId } = setupReview()
    const markReplied = vi.fn()
    const tools = createReviewRoomTools({ broadcast: () => {}, markReplied, draftCommentId: () => undefined })
    expect(tools.reply('unrelated', threadId, 'mine now')).toMatchObject({ ok: false, error: expect.stringMatching(/another session/) })
    expect(getReviewThread(threadId)?.messages).toHaveLength(1)
    expect(markReplied).not.toHaveBeenCalled()
  })

  it('lists a thread with the draft link read from the draft store', () => {
    const { threadId } = setupReview()
    const tools = createReviewRoomTools({
      broadcast: () => {},
      markReplied: () => {},
      draftCommentId: (id) => (id === threadId ? 'comment-1' : undefined),
    })
    const [thread] = tools.listThreads('companion', {})['threads'] as Array<Record<string, unknown>>
    expect(thread).toMatchObject({ kind: 'review', id: threadId, draftCommentId: 'comment-1' })
  })

  describe('get_review_diff against GitHub', () => {
    const view = (head: string, baseOid = 'base-oid') =>
      JSON.stringify({ baseRefName: 'feature-base', baseRefOid: baseOid, headRefOid: head })
    beforeEach(() => gh.runGh.mockReset())

    it('refuses when the PR head moved past the reviewed one', async () => {
      const { reviewId } = setupReview()
      gh.runGh.mockResolvedValue(view('pushed-later'))
      const tools = createReviewRoomTools({ broadcast: () => {}, markReplied: () => {}, draftCommentId: () => undefined })
      await expect(tools.getDiff('companion', reviewId, 42)).rejects.toThrow(/head changed/)
    })

    it('refuses a diff whose base moved while it was loading', async () => {
      const { reviewId } = setupReview()
      gh.runGh.mockResolvedValueOnce(view(layer.headSha)).mockResolvedValueOnce(view(layer.headSha, 'base-rebased'))
      const tools = createReviewRoomTools({ broadcast: () => {}, markReplied: () => {}, draftCommentId: () => undefined })
      await expect(tools.getDiff('companion', reviewId, 42)).rejects.toThrow(/changed while its review diff was loading/)
    })

    it('returns the diff labelled with the reviewed head when nothing moved', async () => {
      const { reviewId } = setupReview()
      gh.runGh.mockResolvedValue(view(layer.headSha))
      const tools = createReviewRoomTools({ broadcast: () => {}, markReplied: () => {}, draftCommentId: () => undefined })
      await expect(tools.getDiff('companion', reviewId, 42)).resolves.toMatchObject({
        head_sha: layer.headSha,
        diff: 'diff --git a/x b/x',
        truncated: false,
      })
    })
  })
})
