/**
 * Deep-review orchestration (plans/screen-prs.md §3.2): fan out the enabled
 * review lenses over a PR, then a synthesis reduce curates/ranks/dedups. Lenses
 * are heterogeneous (own prompt + model), so this uses `runTask` per lens + the
 * backend gate (local-serial / cloud-parallel) rather than the homogeneous
 * `runFanout`. Mostly local by default; each lens inherits the screenPrs model
 * unless escalated. All diff-only for now (repo-aware-on-worktree lands later).
 */
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import type { RemoteClient } from './client-hub'
import type { ModelRef } from '../shared/ipc-types'
import type { PrContext, DeepFinding, DeepLensId, DeepReviewState, DeepReviewStatus, DeepLensStatus } from '../shared/screenprs'
import type { ScreenPrsStartResult } from '../shared/ipc-types'
import { DEEP_LENS_ORDER, compareDeepFindings } from '../shared/screenprs'
import { getModelConfig } from './models/config'
import { DEFAULT_TRIAGE_MODEL } from './models/claude-catalog'
import type { Runner } from './agent-tasks/runner'
import { createTaskExecution, targetFromModelRef } from './agent-tasks/registry'
import { runTask } from './agent-tasks/orchestrator'
import { withBackendGate } from './agent-tasks/gate'
import { makeLensTask, makeSynthesisTask, DEEP_REVIEW_PROMPT_VERSION } from './tasks/deep-review-lenses'
import { resolveInstructions, instructionsHash } from './prompts/overrides'
import { analysisFingerprint, getCachedDeep, putDeep } from './screenprs-cache'

/**
 * One deep review per PR, app-wide, reported to every client (`out`): a second
 * start for a PR already under review joins it, and any client can stop it.
 * `states` keeps each PR's latest for a client that missed the events.
 */
const activeDeep = new Map<string, { controller: AbortController; out: RemoteClient }>()
const states = new Map<string, DeepReviewState>()

function setState(url: string, patch: Partial<DeepReviewState>): void {
  const cur = states.get(url) ?? { status: 'idle', lenses: {}, findings: [] }
  states.set(url, { ...cur, ...patch })
}

function runnerFor(model: ModelRef | undefined, cwd = tmpdir()): Runner {
  return createTaskExecution(targetFromModelRef(model), { cwd, selfContained: true }).runner
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of it) out.push(item)
  return out
}

/** Lenses enabled in config, in display order, with their resolved model and instructions. */
function enabledLenses(): Array<{ lens: DeepLensId; model?: ModelRef; instructions: string }> {
  const config = getModelConfig()
  const inherit = config.defaults.screenPrs ?? DEFAULT_TRIAGE_MODEL
  const lensCfg = config.deepReview?.lenses ?? {}
  return DEEP_LENS_ORDER.filter((lens) => lensCfg[lens]?.enabled).map((lens) => ({
    lens,
    model: lensCfg[lens]?.model ?? inherit,
    instructions: resolveInstructions(`deep-review/${lens}`).text,
  }))
}

export function deepReviewFingerprint(
  lenses: Array<{ lens: DeepLensId; model?: ModelRef; instructions: string }>,
  synthModel: ModelRef | undefined,
  synthInstructions: string
): string {
  return analysisFingerprint({
    lenses: lenses.map(({ lens, model, instructions }) => ({
      lens,
      target: targetFromModelRef(model),
      instructions: instructionsHash(instructions),
    })),
    synthesis: targetFromModelRef(synthModel),
    synthesisInstructions: instructionsHash(synthInstructions),
    promptVersion: DEEP_REVIEW_PROMPT_VERSION,
    schemaVersion: 1,
  })
}

/** Settles when the review it started ends; a join settles at once. */
export async function startDeepReview(ctx: PrContext, out: RemoteClient): Promise<ScreenPrsStartResult> {
  if (activeDeep.has(ctx.url)) return { joined: true }
  const controller = new AbortController()
  const mine = { controller, out }
  activeDeep.set(ctx.url, mine)
  const live = (): boolean => activeDeep.get(ctx.url) === mine && !controller.signal.aborted
  const sendLens = (lens: DeepLensId, status: DeepLensStatus): void => {
    if (!live()) return
    setState(ctx.url, { lenses: { ...states.get(ctx.url)?.lenses, [lens]: status } })
    out.send('screenprs:deep-lens', { url: ctx.url, lens, status })
  }
  const sendStatus = (status: DeepReviewStatus, error?: string): void => {
    if (!live()) return
    setState(ctx.url, { status, error })
    out.send('screenprs:deep-status', { url: ctx.url, status, error })
  }
  const sendResult = (findings: DeepFinding[]): void => {
    if (!live()) return
    setState(ctx.url, { findings, headSha: ctx.headSha })
    out.send('screenprs:deep-result', { url: ctx.url, findings, headSha: ctx.headSha })
  }

  states.set(ctx.url, { status: 'idle', lenses: {}, findings: [], headSha: ctx.headSha })
  sendStatus('running')

  try {
    // Cache hit at this head SHA → the diff hasn't changed, so the prior deep
    // findings still hold. Serve them instantly, no model calls.
    const lenses = enabledLenses()
    const synthModel = getModelConfig().deepReview?.synthesisModel ?? getModelConfig().defaults.screenPrs ?? DEFAULT_TRIAGE_MODEL
    const synthInstructions = resolveInstructions('deep-review/synthesis').text
    const deepFingerprint = deepReviewFingerprint(lenses, synthModel, synthInstructions)
    const cached = getCachedDeep(ctx.url, ctx.headSha, deepFingerprint)
    if (cached) {
      sendResult(cached)
      sendStatus('done')
      return { joined: false }
    }

    for (const { lens } of lenses) sendLens(lens, 'running')

    const analysisDir = mkdtempSync(join(tmpdir(), 'simpleedit-deep-review-'))
    try {
      // Fan out the lenses; the gate serializes local work and parallelizes cloud.
      const perLens = await Promise.all(
        lenses.map(({ lens, model, instructions }) =>
          withBackendGate(model, () =>
            collect(runTask(makeLensTask(lens, instructions), ctx, { runner: runnerFor(model, analysisDir), model, signal: controller.signal }))
          )
            .then((findings) => {
              sendLens(lens, 'done')
              return findings
            })
            .catch(() => {
              // One lens failing must not sink the whole review.
              sendLens(lens, 'error')
              return [] as DeepFinding[]
            })
        )
      )
      if (!live()) return { joined: false }

      const raw = perLens.flat()

      // Synthesis reduce (local by default). If it yields nothing usable, fall back
      // to the raw findings sorted — never silently drop everything.
      let curated: DeepFinding[] = []
      if (raw.length > 0) {
        try {
          curated = await withBackendGate(synthModel, () =>
            collect(runTask(makeSynthesisTask(synthInstructions), { ctx, raw }, { runner: runnerFor(synthModel, analysisDir), model: synthModel, signal: controller.signal }))
          )
        } catch {
          curated = []
        }
        if (curated.length === 0 && !controller.signal.aborted) curated = raw
      }
      if (!live()) return { joined: false }

      curated.sort(compareDeepFindings)
      putDeep(ctx.url, ctx.headSha, curated, deepFingerprint)
      sendResult(curated)
      sendStatus('done')
    } finally {
      rmSync(analysisDir, { recursive: true, force: true })
    }
  } catch (err: unknown) {
    sendStatus('error', err instanceof Error ? err.message : String(err))
  } finally {
    if (activeDeep.get(ctx.url) === mine) activeDeep.delete(ctx.url)
  }
  return { joined: false }
}

/** Stop a PR's deep review, whoever started it, and tell every client. */
export function cancelDeepReview(url: string): void {
  const active = activeDeep.get(url)
  if (!active) return
  active.controller.abort()
  activeDeep.delete(url)
  setState(url, { status: 'idle', error: undefined })
  active.out.send('screenprs:deep-status', { url, status: 'idle' })
}

/** Abort at quit: nobody is left to tell. */
export function cancelAllDeepReviews(): void {
  for (const { controller } of activeDeep.values()) controller.abort()
  activeDeep.clear()
}

/** Every PR's deep review this launch, for a client that missed the events. */
export function deepReviewSnapshot(): Record<string, DeepReviewState> {
  return Object.fromEntries(states)
}
