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
import type { WebContents } from 'electron'
import type { ModelRef } from '../shared/ipc-types'
import type { PrContext, DeepFinding, DeepLensId, DeepReviewStatus, DeepLensStatus } from '../shared/screenprs'
import { DEEP_LENS_ORDER, compareDeepFindings } from '../shared/screenprs'
import { getModelConfig } from './models/config'
import { DEFAULT_TRIAGE_MODEL } from './models/claude-catalog'
import type { Runner } from './agent-tasks/runner'
import { createTaskExecution, targetFromModelRef } from './agent-tasks/registry'
import { runTask } from './agent-tasks/orchestrator'
import { withBackendGate } from './agent-tasks/gate'
import { makeLensTask, synthesisTask, DEEP_REVIEW_PROMPT_VERSION } from './tasks/deep-review-lenses'
import { analysisFingerprint, getCachedDeep, putDeep } from './screenprs-cache'

const activeDeep = new Map<string, AbortController>()

function send(wc: WebContents, channel: string, data: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, data)
}

function runnerFor(model: ModelRef | undefined, cwd = tmpdir()): Runner {
  return createTaskExecution(targetFromModelRef(model), { cwd, selfContained: true }).runner
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of it) out.push(item)
  return out
}

/** Lenses enabled in config, in display order, with their resolved model. */
function enabledLenses(): Array<{ lens: DeepLensId; model?: ModelRef }> {
  const config = getModelConfig()
  const inherit = config.defaults.screenPrs ?? DEFAULT_TRIAGE_MODEL
  const lensCfg = config.deepReview?.lenses ?? {}
  return DEEP_LENS_ORDER.filter((lens) => lensCfg[lens]?.enabled).map((lens) => ({
    lens,
    model: lensCfg[lens]?.model ?? inherit,
  }))
}

export async function startDeepReview(ctx: PrContext, webContents: WebContents): Promise<void> {
  cancelDeepReview(ctx.url)
  const controller = new AbortController()
  activeDeep.set(ctx.url, controller)
  const sendLens = (lens: DeepLensId, status: DeepLensStatus): void =>
    send(webContents, 'screenprs:deep-lens', { url: ctx.url, lens, status })
  const sendStatus = (status: DeepReviewStatus, error?: string): void =>
    send(webContents, 'screenprs:deep-status', { url: ctx.url, status, error })

  sendStatus('running')

  // Cache hit at this head SHA → the diff hasn't changed, so the prior deep
  // findings still hold. Serve them instantly, no model calls.
  const lenses = enabledLenses()
  const synthModel = getModelConfig().deepReview?.synthesisModel ?? getModelConfig().defaults.screenPrs ?? DEFAULT_TRIAGE_MODEL
  const deepFingerprint = analysisFingerprint({
    lenses: lenses.map(({ lens, model }) => ({ lens, target: targetFromModelRef(model) })),
    synthesis: targetFromModelRef(synthModel),
    promptVersion: DEEP_REVIEW_PROMPT_VERSION,
    schemaVersion: 1,
  })
  const cached = getCachedDeep(ctx.url, ctx.headSha, deepFingerprint)
  if (cached) {
    send(webContents, 'screenprs:deep-result', { url: ctx.url, findings: cached })
    sendStatus('done')
    activeDeep.delete(ctx.url)
    return
  }

  for (const { lens } of lenses) sendLens(lens, 'running')

  try {
    const analysisDir = mkdtempSync(join(tmpdir(), 'simpleedit-deep-review-'))
    try {
      // Fan out the lenses; the gate serializes local work and parallelizes cloud.
      const perLens = await Promise.all(
        lenses.map(({ lens, model }) =>
          withBackendGate(model, () =>
            collect(runTask(makeLensTask(lens), ctx, { runner: runnerFor(model, analysisDir), model, signal: controller.signal }))
          )
            .then((findings) => {
              sendLens(lens, 'done')
              return findings
            })
            .catch(() => {
              // One lens failing must not sink the whole review.
              if (!controller.signal.aborted) sendLens(lens, 'error')
              return [] as DeepFinding[]
            })
        )
      )
      if (controller.signal.aborted) return

      const raw = perLens.flat()

      // Synthesis reduce (local by default). If it yields nothing usable, fall back
      // to the raw findings sorted — never silently drop everything.
      let curated: DeepFinding[] = []
      if (raw.length > 0) {
        try {
          curated = await withBackendGate(synthModel, () =>
            collect(runTask(synthesisTask, { ctx, raw }, { runner: runnerFor(synthModel, analysisDir), model: synthModel, signal: controller.signal }))
          )
        } catch {
          curated = []
        }
        if (curated.length === 0 && !controller.signal.aborted) curated = raw
      }
      if (controller.signal.aborted) return

      curated.sort(compareDeepFindings)
      putDeep(ctx.url, ctx.headSha, curated, deepFingerprint)
      send(webContents, 'screenprs:deep-result', { url: ctx.url, findings: curated })
      sendStatus('done')
    } finally {
      rmSync(analysisDir, { recursive: true, force: true })
    }
  } catch (err: unknown) {
    if (!controller.signal.aborted) sendStatus('error', err instanceof Error ? err.message : String(err))
  } finally {
    if (activeDeep.get(ctx.url) === controller) activeDeep.delete(ctx.url)
  }
}

export function cancelDeepReview(url: string): void {
  activeDeep.get(url)?.abort()
  activeDeep.delete(url)
}

export function cancelAllDeepReviews(): void {
  for (const c of activeDeep.values()) c.abort()
  activeDeep.clear()
}
