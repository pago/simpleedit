import { describe, it, expect, vi } from 'vitest'
import type { PrContext } from '../../shared/screenprs'

/**
 * One deep review per PR for the whole app: a second start follows the first,
 * a stop from any client settles it for all of them, and main keeps its state
 * for a client that missed the events.
 */
const lens = vi.hoisted(() => ({ release: (): void => {}, runs: 0 }))

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
    await new Promise<void>((resolve) => (lens.release = resolve))
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
  })
})
