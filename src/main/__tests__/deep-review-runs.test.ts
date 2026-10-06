import { describe, it, expect, vi } from 'vitest'
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
vi.mock('../prompts/overrides', () => ({ resolveInstructions: () => ({ text: 'i' }), instructionsHash: (t: string) => t }))
vi.mock('../screenprs-cache', () => ({
  analysisFingerprint: () => 'fp',
  getCachedDeep: () => undefined,
  putDeep: vi.fn(),
}))

import { startDeepReview, cancelDeepReview, deepReviewSnapshot } from '../deep-review'

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
