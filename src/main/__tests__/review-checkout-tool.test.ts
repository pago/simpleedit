import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import { claimCompanion, createReview } from '../review-room-store'
import { createReviewRoomTools } from '../review-room-tools'

const layers = [
  { url: 'https://github.com/acme/repo/pull/41', number: 41, headSha: 'a'.repeat(40) },
  { url: 'https://github.com/acme/repo/pull/42', number: 42, headSha: 'b'.repeat(40) },
]

describe('checkout_review_head', () => {
  beforeEach(() => {
    useDbForTests(openDb(':memory:'))
    createReview({ id: 'r_review01', repo: 'github.com/acme/repo', layers, companionAgent: { provider: 'claude', model: 'default' }, requesterSessionId: 'requester' })
    claimCompanion('r_review01', 1, 'claim-1', 'companion', { provider: 'claude', model: 'default' })
  })
  afterEach(() => useDbForTests(null))

  it("is the companion's only, defaults to the top layer and returns the path", async () => {
    const checkoutHead = vi.fn(async (_review: unknown, pr?: number) => ({ path: `/data/r_review01/${pr ?? 42}`, pr: pr ?? 42, headSha: 'b'.repeat(40) }))
    const tools = createReviewRoomTools({ broadcast: () => {}, markReplied: () => {}, checkoutHead })
    await expect(tools.checkoutHead('requester', 'r_review01', undefined)).rejects.toThrow(/companion/)
    await expect(tools.checkoutHead('companion', '../x', undefined)).rejects.toThrow(/Malformed/)
    await expect(tools.checkoutHead('companion', 'r_review01', -1)).rejects.toThrow(/Malformed/)
    await expect(tools.checkoutHead('companion', 'r_review01', undefined)).resolves.toMatchObject({ ok: true, path: '/data/r_review01/42', pr: 42 })
    expect(checkoutHead).toHaveBeenCalledTimes(1)
    expect(checkoutHead.mock.calls[0]![1]).toBeUndefined()
  })
})
