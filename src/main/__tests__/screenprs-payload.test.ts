import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PrRef, TriageResult } from '../../shared/screenprs'

/**
 * A board card must reach a phone without its diff, and reach the window's own
 * renderer with it.
 *
 * `PrContext.diff` is the whole unified diff and screening defaults to every
 * org where you're a reviewer, so the un-stripped payload is dozens of complete
 * diffs down a WebSocket. The desktop still reads `context.diff` straight out
 * of the card, so the split has to be exactly that — a split, not a removal.
 *
 * Driven through the cache-hit path: a cached PR emits its card with no model
 * call, which is what lets this test the payload without a runner.
 */
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('../models/config', () => ({ getModelConfig: () => ({ defaults: {}, submenuAllowlist: [] }) }))
vi.mock('../agent-tasks/orchestrator', () => ({
  // Nothing is left to triage on a full cache hit; yielding nothing keeps the
  // run entirely inside the code under test.
  runFanout: async function* () {},
}))
vi.mock('../github/gh', () => ({
  currentHandle: async () => 'me',
  searchReviewRequestedPrs: async () => [REF],
  getPrMeta: async (ref: PrRef) => ({ ...ref, headSha: 'sha1', additions: 1, deletions: 0, changedFiles: 1, baseRefName: 'main', headRefName: 'feat', ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false, body: '' }),
  getPrDiff: async () => DIFF,
}))
vi.mock('../screenprs-cache', () => ({
  analysisFingerprint: () => 'fp',
  getCached: () => ({ diff: DIFF, triage: TRIAGE }),
  putTriage: vi.fn(),
}))

import { ClientHub } from '../client-hub'
import { startScreening } from '../screenprs'

const REF: PrRef = {
  owner: 'acme', repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7',
  title: 'Tighten the gate', author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
}
const DIFF = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const TRIAGE: TriageResult = { impact: 'low', findings: [] }

function transport(clientKey?: string) {
  return {
    id: 1,
    ...(clientKey === undefined ? {} : { clientKey }),
    send: vi.fn<(channel: string, data: unknown) => void>(),
    isDestroyed: () => false,
  }
}

function cardsSentTo(t: ReturnType<typeof transport>): { diff: string }[] {
  return t.send.mock.calls
    .filter(([channel]) => channel === 'screenprs:card')
    .map(([, data]) => (data as { card: { diff: string } }).card)
}

let window_: ReturnType<typeof transport>
let phone: ReturnType<typeof transport>
let hub: ClientHub

beforeEach(() => {
  window_ = transport()
  phone = transport('w1.3')
  hub = new ClientHub(1, window_)
  hub.register(phone)
})

describe('board payload', () => {
  it('sends the full diff to the window and an empty one to a socket client', async () => {
    await startScreening({}, hub)

    expect(cardsSentTo(window_)).toEqual([expect.objectContaining({ diff: DIFF })])
    expect(cardsSentTo(phone)).toEqual([expect.objectContaining({ diff: '' })])
  })

  it('leaves the phone a card that is otherwise identical', async () => {
    await startScreening({}, hub)

    const [local] = cardsSentTo(window_)
    const [remote] = cardsSentTo(phone)
    expect(remote).toEqual({ ...local, diff: '' })
  })
})
