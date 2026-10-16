import { describe, it, expect, vi, afterEach } from 'vitest'
import type { PrContext } from '../../shared/screenprs'

/**
 * One deep review per PR for the whole app: a second start follows the first,
 * a stop from any client settles it for all of them, and main keeps its state
 * for a client that missed the events.
 */
const lens = vi.hoisted(() => ({
  runs: 0,
  waiting: [] as (() => void)[],
  release(): void {
    for (const resolve of this.waiting.splice(0)) resolve()
  },
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../models/config', () => ({
  getModelConfig: () => ({ defaults: {}, deepReview: { lenses: { soundness: { enabled: true } } } }),
}))
vi.mock('../agent-tasks/registry', () => ({
  createTaskExecution: () => ({ runner: {}, concurrency: 1 }),
  targetFromModelRef: () => ({}),
}))
vi.mock('../agent-tasks/gate', () => ({ withBackendGate: (_m: unknown, fn: () => unknown) => fn() }))
vi.mock('../agent-tasks/orchestrator', () => ({
  runTask: async function* () {
    lens.runs++
    await new Promise<void>((resolve) => lens.waiting.push(resolve))
  },
}))
vi.mock('../tasks/deep-review-lenses', () => ({
  makeLensTask: () => ({}),
  makeSynthesisTask: () => ({}),
  DEEP_REVIEW_PROMPT_VERSION: 1,
}))
const rubric = vi.hoisted(() => ({ fetchReviewRubric: vi.fn(async (_url: string, _head: string): Promise<undefined> => undefined) }))
vi.mock('../github/review-rubric', () => ({ fetchReviewRubric: rubric.fetchReviewRubric, rubricFingerprint: () => 'none' }))
vi.mock('../prompts/overrides', () => ({ resolveInstructions: () => ({ text: 'i' }), instructionsHash: (t: string) => t }))
vi.mock('../screenprs-cache', () => ({
  analysisFingerprint: () => 'fp',
  getCachedDeep: () => undefined,
  putDeep: vi.fn(),
}))

import { startDeepReview, cancelDeepReview, cancelAllDeepReviews, deepReviewSnapshot, onDeepResult } from '../deep-review'

const PR = { url: 'https://github.com/acme/ui/pull/7', headSha: 'sha1', diff: 'd' } as PrContext

function client() {
  const sent: [string, unknown][] = []
  return { sent, wc: { id: -1, send: (c: string, d: unknown) => sent.push([c, d]), isDestroyed: () => false } }
}

describe('deep review runs', () => {
  it('joins the running review, and a stop from any client settles it for all', async () => {
    const { sent, wc } = client()
    const first = startDeepReview(PR, wc)
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(startDeepReview(PR, client().wc)).resolves.toEqual({ joined: true })
    expect(lens.runs).toBe(1)
    expect(deepReviewSnapshot()[PR.url]).toMatchObject({ status: 'running', lenses: { soundness: 'running' }, headSha: 'sha1' })

    cancelDeepReview(PR.url)
    lens.release()
    await expect(first).resolves.toEqual({ joined: false })

    expect(sent.map(([c, d]) => [c, (d as { status: string }).status])).toEqual([
      ['screenprs:deep-status', 'running'],
      ['screenprs:deep-lens', 'running'],
      ['screenprs:deep-status', 'idle'],
    ])
    expect(deepReviewSnapshot()[PR.url]).toMatchObject({ status: 'idle' })
    expect(deepReviewSnapshot()[PR.url].lenses).toEqual({})
  })

  it('replaces the running review when the head moved, and tells every client it restarted', async () => {
    const url = 'https://github.com/acme/ui/pull/8'
    const { sent, wc } = client()
    const old = startDeepReview({ ...PR, url, headSha: 'old' }, wc)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const fresh = startDeepReview({ ...PR, url, headSha: 'new' }, wc)
    await new Promise((resolve) => setTimeout(resolve, 0))
    lens.release()
    await expect(old).resolves.toEqual({ joined: false })
    await expect(fresh).resolves.toEqual({ joined: false })

    const statuses = sent.filter(([c]) => c === 'screenprs:deep-status').map(([, d]) => d)
    expect(statuses).toEqual([
      { url, status: 'running', error: undefined, headSha: 'old' },
      { url, status: 'idle' },
      { url, status: 'running', error: undefined, headSha: 'new' },
      { url, status: 'done', error: undefined },
    ])
    // A client that reconnects now agrees with one that watched it happen.
    expect(deepReviewSnapshot()[url]).toMatchObject({ status: 'done', headSha: 'new', lenses: { soundness: 'done' } })
  })
})

describe('the Review Room hook', () => {
  it('hears each result sent, with the diff its lines point into', async () => {
    const heard = vi.fn()
    onDeepResult(heard)
    const url = 'https://github.com/acme/ui/pull/8'
    const run = startDeepReview({ ...PR, url, diff: 'the diff' }, client().wc)
    await vi.waitFor(() => expect(lens.waiting.length).toBeGreaterThan(0))
    lens.release()
    await run
    onDeepResult(null)
    expect(heard).toHaveBeenCalledWith({ url, headSha: 'sha1', diff: 'the diff', findings: [] })
  })
})

describe('deep review starts still reading REVIEW.md', () => {
  afterEach(() => rubric.fetchReviewRubric.mockImplementation(async () => undefined))

  /** Holds each rubric read until the test releases every read of that head. */
  function holdRubric(): Map<string, () => void> {
    const waiting = new Map<string, Array<() => void>>()
    const held = new Map<string, () => void>()
    rubric.fetchReviewRubric.mockImplementation(
      (_url: string, head: string) =>
        new Promise<undefined>((resolve) => {
          waiting.set(head, [...(waiting.get(head) ?? []), () => resolve(undefined)])
          held.set(head, () => { for (const release of waiting.get(head) ?? []) release() })
        }),
    )
    return held
  }

  it('run once for two identical starts', async () => {
    const held = holdRubric()
    const url = 'https://github.com/acme/ui/pull/20'
    const runs = lens.runs
    const first = startDeepReview({ ...PR, url }, client().wc)
    const second = startDeepReview({ ...PR, url }, client().wc)
    await vi.waitFor(() => expect(held.size).toBe(1))
    held.get('sha1')!()
    await expect(second).resolves.toEqual({ joined: true })
    expect(lens.runs - runs).toBe(1)
    lens.release()
    await expect(first).resolves.toEqual({ joined: false })
  })

  it('give way to a newer start for another head, even when they finish reading last', async () => {
    const held = holdRubric()
    const url = 'https://github.com/acme/ui/pull/21'
    const { sent, wc } = client()
    const old = startDeepReview({ ...PR, url, headSha: 'old' }, wc)
    const fresh = startDeepReview({ ...PR, url, headSha: 'new' }, wc)
    await vi.waitFor(() => expect(held.size).toBe(2))
    held.get('new')!()
    await vi.waitFor(() => expect(lens.waiting.length).toBeGreaterThan(0))
    held.get('old')!()
    await expect(old).resolves.toEqual({ joined: false })
    lens.release()
    await fresh
    expect(sent.some(([, d]) => (d as { headSha?: string }).headSha === 'old')).toBe(false)
    expect(deepReviewSnapshot()[url]).toMatchObject({ status: 'done', headSha: 'new' })
  })

  it('for the new head join the run that replaced an older head’s', async () => {
    const url = 'https://github.com/acme/ui/pull/24'
    const old = startDeepReview({ ...PR, url, headSha: 'old' }, client().wc)
    await vi.waitFor(() => expect(deepReviewSnapshot()[url]).toMatchObject({ status: 'running', headSha: 'old' }))
    const reads: Array<() => void> = []
    rubric.fetchReviewRubric.mockImplementation(() => new Promise<undefined>((resolve) => reads.push(() => resolve(undefined))))
    const first = startDeepReview({ ...PR, url, headSha: 'new' }, client().wc)
    const second = startDeepReview({ ...PR, url, headSha: 'new' }, client().wc)
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    // The second is still reading when the first replaces the old head's run.
    reads[0]!()
    await vi.waitFor(() => expect(deepReviewSnapshot()[url]).toMatchObject({ status: 'running', headSha: 'new' }))
    reads[1]!()
    await expect(second).resolves.toEqual({ joined: true })
    lens.release()
    await Promise.all([first, old])
    expect(deepReviewSnapshot()[url]).toMatchObject({ status: 'done', headSha: 'new' })
  })

  it('are reached by Stop', async () => {
    const held = holdRubric()
    const { sent, wc } = client()
    const runs = lens.runs
    const stopped = startDeepReview({ ...PR, url: 'https://github.com/acme/ui/pull/22' }, wc)
    await vi.waitFor(() => expect(held.size).toBe(1))
    cancelDeepReview('https://github.com/acme/ui/pull/22')
    held.get('sha1')!()
    await expect(stopped).resolves.toEqual({ joined: false })
    expect(sent).toEqual([['screenprs:deep-status', { url: 'https://github.com/acme/ui/pull/22', status: 'idle' }]])
    expect(deepReviewSnapshot()['https://github.com/acme/ui/pull/22']).toMatchObject({ status: 'idle' })
    expect(lens.runs).toBe(runs)
  })

  it('are reached by quit', async () => {
    const held = holdRubric()
    const { sent, wc } = client()
    const runs = lens.runs
    const quit = startDeepReview({ ...PR, url: 'https://github.com/acme/ui/pull/23' }, wc)
    await vi.waitFor(() => expect(held.size).toBe(1))
    cancelAllDeepReviews()
    held.get('sha1')!()
    await expect(quit).resolves.toEqual({ joined: false })
    expect(sent).toEqual([])
    expect(lens.runs).toBe(runs)
  })
})
