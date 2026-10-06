import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PrRef, TriageResult } from '../../shared/screenprs'

/**
 * A screening belongs to the app, not to the window that started it: every
 * window and every phone hears it, whichever hub they are on and whenever they
 * joined, a second start joins it, and any client can stop it.
 *
 * The search is held open by the test, so each case can act mid-run.
 */
const gate = vi.hoisted(() => ({
  searches: 0,
  release: (): void => {},
}))

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('../models/config', () => ({ getModelConfig: () => ({ defaults: {}, submenuAllowlist: [] }) }))
vi.mock('../agent-tasks/registry', () => ({
  createTaskExecution: () => ({ runner: {}, concurrency: 1 }),
  targetFromModelRef: () => ({}),
}))
vi.mock('../agent-tasks/orchestrator', () => ({ runFanout: async function* () {} }))
vi.mock('../github/gh', () => ({
  currentHandle: async () => 'me',
  searchReviewRequestedPrs: async () => {
    gate.searches++
    await new Promise<void>((resolve) => (gate.release = resolve))
    return [REF]
  },
  getPrMeta: async (ref: PrRef) => ({ ...ref, headSha: 'sha1', additions: 1, deletions: 1, changedFiles: 1, baseRefName: 'main', baseRefOid: 'b', headRefName: 'feat', ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false, body: '' }),
}))
vi.mock('../github/stack-base', async (importOriginal) => ({
  withReviewDiff: (await importOriginal<typeof import('../github/stack-base')>()).withReviewDiff,
  createBaseResolver: () => ({}),
  baseKey: async () => 'main',
  getReviewDiff: async () => ({ diff: DIFF }),
  getReviewDiffByUrl: async () => DIFF,
}))
vi.mock('../screenprs-cache', () => ({
  analysisFingerprint: () => 'fp',
  getCached: () => ({ diff: DIFF, triage: TRIAGE }),
  getCachedDiff: () => undefined,
  putTriage: vi.fn(),
}))

import { ClientHub, everyClient } from '../client-hub'
import { startScreening, cancelScreening, screeningSnapshot } from '../screenprs'

const REF: PrRef = {
  owner: 'acme', repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7',
  title: 'Tighten the gate', author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
}
const DIFF = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const TRIAGE: TriageResult = { impact: 'low', findings: [] }

function transport(id: number, clientKey?: string) {
  return {
    id,
    ...(clientKey === undefined ? {} : { clientKey }),
    send: vi.fn<(channel: string, data: unknown) => void>(),
    isDestroyed: () => false,
  }
}
type Transport = ReturnType<typeof transport>

const statuses = (t: Transport): unknown[] =>
  t.send.mock.calls.filter(([c]) => c === 'screenprs:status').map(([, d]) => (d as { status: string }).status)
const cards = (t: Transport): { diff: string }[] =>
  t.send.mock.calls.filter(([c]) => c === 'screenprs:card').map(([, d]) => (d as { card: { diff: string } }).card)

/** Let the run reach the next point it waits on. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let windowA: Transport
let phoneOnA: Transport
let windowB: Transport
let windowWithoutHub: Transport
let hubs: Map<number, ClientHub>
let all: ReturnType<typeof everyClient>

beforeEach(() => {
  gate.searches = 0
  windowA = transport(1)
  phoneOnA = transport(1, 'w1.1')
  windowB = transport(2)
  windowWithoutHub = transport(3)
  hubs = new Map([
    [1, new ClientHub(1, windowA)],
    [2, new ClientHub(2, windowB)],
  ])
  hubs.get(1)!.register(phoneOnA)
  all = everyClient(() => hubs.values(), () => [windowA, windowB, windowWithoutHub])
})

describe('one screening for every client', () => {
  it('reaches every window and every phone, whichever window started it', async () => {
    const run = startScreening({}, all)
    await settle()
    gate.release()
    await run

    for (const t of [windowA, phoneOnA, windowB, windowWithoutHub]) expect(statuses(t)).toEqual(['running', 'done'])
    expect(cards(windowA)).toEqual([expect.objectContaining({ diff: DIFF })])
    expect(cards(windowB)).toEqual([expect.objectContaining({ diff: DIFF })])
    expect(cards(windowWithoutHub)).toEqual([expect.objectContaining({ diff: DIFF })])
    // A phone gets every card too, still without its diff.
    expect(cards(phoneOnA)).toEqual([expect.objectContaining({ diff: '' })])
  })

  it('reaches a phone that switched to another window mid-run, and answers it whole', async () => {
    const run = startScreening({}, all)
    await settle()
    hubs.get(1)!.unregister(phoneOnA)
    const phoneOnB = transport(2, 'w2.1')
    hubs.get(2)!.register(phoneOnB)

    expect(screeningSnapshot(true)).toEqual({ status: 'running', entries: [], triaging: [], total: undefined, error: undefined })
    gate.release()
    await run

    expect(statuses(phoneOnB)).toEqual(['done'])
    expect(cards(phoneOnB)).toEqual([expect.objectContaining({ url: REF.url, diff: '' })])
    const late = screeningSnapshot(true)
    expect(late).toMatchObject({ status: 'done', total: 1, triaging: [] })
    expect(late.entries).toEqual([expect.objectContaining({ ref: REF, card: expect.objectContaining({ diff: '' }) })])
    expect(screeningSnapshot(false).entries[0].card).toEqual(expect.objectContaining({ diff: DIFF }))
  })

  it('joins the run already going instead of starting a second', async () => {
    const first = startScreening({}, all)
    await settle()

    await expect(startScreening({ owner: 'other' }, all)).resolves.toEqual({ joined: true })
    expect(gate.searches).toBe(1)

    gate.release()
    await expect(first).resolves.toEqual({ joined: false })
    expect(statuses(windowB)).toEqual(['running', 'done'])
    expect(cards(windowB)).toHaveLength(1)
  })

  it('stops from any client, tells them all, and sends nothing after', async () => {
    const run = startScreening({}, all)
    await settle()

    cancelScreening()
    gate.release()
    await run

    for (const t of [windowA, phoneOnA, windowB, windowWithoutHub]) expect(statuses(t)).toEqual(['running', 'cancelled'])
    expect(cards(windowA)).toEqual([])
    expect(screeningSnapshot(false).status).toBe('cancelled')

    // Stopped means a fresh start is a new run, not a join.
    const again = startScreening({}, all)
    await settle()
    expect(gate.searches).toBe(2)
    gate.release()
    await expect(again).resolves.toEqual({ joined: false })
  })
})

describe('everyClient', () => {
  it('sends to each client once, a hub-backed window through its hub only', () => {
    all.send('screenprs:status', { status: 'done' })
    expect(windowA.send).toHaveBeenCalledTimes(1)
    expect(phoneOnA.send).toHaveBeenCalledTimes(1)
    expect(windowB.send).toHaveBeenCalledTimes(1)
    expect(windowWithoutHub.send).toHaveBeenCalledTimes(1)
  })
})
