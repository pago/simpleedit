import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BaseAnalysis, PrRef, TriageResult } from '../../shared/screenprs'

/**
 * A board card must reach a phone without its diff, and reach the window's own
 * renderer with it.
 *
 * `PrContext.diff` is the whole unified diff and screening defaults to every
 * org where you're a reviewer, so the un-stripped payload is dozens of complete
 * diffs down a WebSocket. The desktop still reads `context.diff` straight out
 * of the card, so the split has to be exactly that — a split, not a removal.
 *
 * The payload cases are driven through the cache-hit path: a cached PR emits
 * its card with no model call. The polluted-base cases miss the cache, so the
 * fan-out stub stands in for the model and records what it was given.
 */
const state = vi.hoisted(() => ({
  cached: true,
  cachedBase: undefined as unknown,
  baseRefOid: 'base1',
  triaged: [] as { diff: string; base?: unknown }[],
  putTriage: [] as unknown[][],
}))

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('../models/config', () => ({ getModelConfig: () => ({ defaults: {}, submenuAllowlist: [] }) }))
vi.mock('../agent-tasks/registry', () => ({
  createTaskExecution: () => ({ runner: {}, concurrency: 1 }),
  targetFromModelRef: () => ({}),
}))
vi.mock('../agent-tasks/orchestrator', () => ({
  // On a full cache hit nothing is left to triage, which keeps the run entirely
  // inside the code under test. On a miss it records what the model would read.
  runFanout: async function* (_task: unknown, inputs: { diff: string; base?: unknown }[]) {
    for (const [index, input] of inputs.entries()) {
      state.triaged.push(input)
      yield { kind: 'item', index, input, item: TRIAGE }
      yield { kind: 'done', index, input }
    }
  },
}))
vi.mock('../github/gh', () => ({
  withGhSignal: (_signal: AbortSignal, fn: () => Promise<unknown>) => fn(),
  currentHandle: async () => 'me',
  searchReviewRequestedPrs: async () => [REF],
  getPrMeta: async (ref: PrRef) => ({ ...ref, headSha: 'sha1', additions: 5, deletions: 3, changedFiles: 4, baseRefName: 'lower', baseRefOid: state.baseRefOid, headRefName: 'feat', ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false, body: '' }),
}))
vi.mock('../github/stack-base', async (importOriginal) => ({
  withReviewDiff: (await importOriginal<typeof import('../github/stack-base')>()).withReviewDiff,
  createBaseResolver: () => ({}),
  baseKey: async (meta: { baseRefOid: string }) => `stacked:${meta.baseRefOid}`,
  getReviewDiff: async () => ({ diff: ISOLATED, base: POLLUTED }),
  getReviewDiffByUrl: async () => ISOLATED,
}))
vi.mock('../screenprs-cache', () => ({
  analysisFingerprint: () => 'fp',
  // Hits only at the base the entry was stored at — the real cache's rule.
  getCached: (_url: string, _sha: string, _fp: string, key: string) =>
    state.cached && key === 'stacked:base1' ? { diff: state.cachedBase ? ISOLATED : DIFF, base: state.cachedBase, triage: TRIAGE } : undefined,
  getCachedDiff: () => undefined,
  putTriage: (...args: unknown[]) => state.putTriage.push(args),
}))

import { ClientHub } from '../client-hub'
import { startScreening } from '../screenprs'

const REF: PrRef = {
  owner: 'acme', repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7',
  title: 'Tighten the gate', author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
}
const DIFF = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const TRIAGE: TriageResult = { impact: 'low', findings: [] }
const ISOLATED = 'diff --git a/own.ts b/own.ts\n@@ -1 +1 @@\n-a\n+b\n'
const GITHUB_STATS = { additions: 5, deletions: 3, changedFiles: 4 }
const ISOLATED_STATS = { additions: 1, deletions: 1, changedFiles: 1 }
const POLLUTED: BaseAnalysis = { kind: 'polluted', basePr: 6, foreign: 3, behindBy: 2, own: [{ sha: 'sha1', subject: 'mine' }], isolated: true }

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
  state.cached = true
  state.cachedBase = undefined
  state.baseRefOid = 'base1'
  state.triaged = []
  state.putTriage = []
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

describe('polluted base', () => {
  it('triages the isolated diff, not GitHub\'s, and caches it with the base', async () => {
    state.cached = false
    await startScreening({}, hub)

    const base = { ...POLLUTED, github: GITHUB_STATS }
    expect(state.triaged).toEqual([expect.objectContaining({ diff: ISOLATED, base, ...ISOLATED_STATS })])
    expect(cardsSentTo(window_)).toEqual([expect.objectContaining({ diff: ISOLATED, base, ...ISOLATED_STATS })])
    expect(state.putTriage).toEqual([[REF.url, 'sha1', ISOLATED, TRIAGE, 'fp', { key: 'stacked:base1', analysis: base }]])
  })

  it('gives a cached polluted card the isolated diff’s figures, not GitHub’s fresh ones', async () => {
    state.cachedBase = { ...POLLUTED, github: { additions: 1, deletions: 1, changedFiles: 1 } }
    await startScreening({}, hub)

    expect(state.triaged).toEqual([])
    expect(cardsSentTo(window_)).toEqual([
      expect.objectContaining({ diff: ISOLATED, base: { ...POLLUTED, github: GITHUB_STATS }, ...ISOLATED_STATS }),
    ])
  })

  it('re-triages when the base moves even though the head did not', async () => {
    state.baseRefOid = 'base2'
    await startScreening({}, hub)

    expect(state.triaged).toHaveLength(1)
    expect(state.putTriage[0][5]).toEqual({ key: 'stacked:base2', analysis: { ...POLLUTED, github: GITHUB_STATS } })
  })
})
