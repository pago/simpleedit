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
import { withGhSignal } from './github/gh'
import { diffFiles } from './github/pr-overview-context'
import { fetchReviewRubric, rubricFingerprint, type ReviewRubric } from './github/review-rubric'

/**
 * One deep review per PR, app-wide, reported to every client (`out`). A second
 * start for the same head and lens setup joins it; one for another head or
 * setup replaces it. Any client can stop it. `states` keeps each PR's latest
 * for a client that missed the events.
 */
interface ActiveDeep {
  controller: AbortController
  out: RemoteClient
  headSha: string
  fingerprint: string
}
const activeDeep = new Map<string, ActiveDeep>()
const states = new Map<string, DeepReviewState>()
/** Rubric reads not yet owned by a run, so quit can still kill their `gh`. */
const preparing = new Set<AbortController>()
/** Each PR's starts still reading, by head: a start for another head supersedes them, and Stop reaches them. */
const preparingFor = new Map<string, Set<{ controller: AbortController; headSha: string }>>()

/** Registers a start that is still reading, aborting older ones for another head: the newest intent wins. */
function beginPreparing(url: string, headSha: string, controller: AbortController): () => void {
  const starts = preparingFor.get(url) ?? new Set()
  for (const older of starts) if (older.headSha !== headSha) older.controller.abort()
  const mine = { controller, headSha }
  starts.add(mine)
  preparingFor.set(url, starts)
  preparing.add(controller)
  return () => {
    preparing.delete(controller)
    starts.delete(mine)
    if (!starts.size && preparingFor.get(url) === starts) preparingFor.delete(url)
  }
}

function stopPreparing(url: string): void {
  for (const start of preparingFor.get(url) ?? []) start.controller.abort()
}

export interface DeepResult {
  url: string
  headSha: string
  /** The diff the lenses read, which the findings' lines point into. */
  diff: string
  findings: DeepFinding[]
}

let resultListener: ((result: DeepResult) => void) | null = null

/** Called with every deep result a client is sent, a cache hit included. */
export function onDeepResult(fn: ((result: DeepResult) => void) | null): void {
  resultListener = fn
}

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
  synthInstructions: string,
  rubric?: ReviewRubric
): string {
  return analysisFingerprint({
    lenses: lenses.map(({ lens, model, instructions }) => ({
      lens,
      target: targetFromModelRef(model),
      instructions: instructionsHash(instructions),
    })),
    synthesis: targetFromModelRef(synthModel),
    synthesisInstructions: instructionsHash(synthInstructions),
    rubric: rubricFingerprint(rubric),
    promptVersion: DEEP_REVIEW_PROMPT_VERSION,
    schemaVersion: 1,
  })
}

/** Settles when the review it started ends; a join settles at once. */
export async function startDeepReview(ctx: PrContext, out: RemoteClient): Promise<ScreenPrsStartResult> {
  const lenses = enabledLenses()
  const synthModel = getModelConfig().deepReview?.synthesisModel ?? getModelConfig().defaults.screenPrs ?? DEFAULT_TRIAGE_MODEL
  const synthInstructions = resolveInstructions('deep-review/synthesis').text
  // Read before the cache check: the rubric is part of the fingerprint.
  const controller = new AbortController()
  const donePreparing = beginPreparing(ctx.url, ctx.headSha, controller)
  const rubric = await withGhSignal(controller.signal, () =>
    fetchReviewRubric(ctx.url, ctx.headSha, diffFiles(ctx.diff).map((f) => f.path))
  ).finally(donePreparing)
  if (controller.signal.aborted) return { joined: false }
  const deepFingerprint = deepReviewFingerprint(lenses, synthModel, synthInstructions, rubric)
  const running = activeDeep.get(ctx.url)
  if (running) {
    if (running.headSha === ctx.headSha && running.fingerprint === deepFingerprint) return { joined: true }
    cancelDeepReview(ctx.url)
  }
  const mine: ActiveDeep = { controller, out, headSha: ctx.headSha, fingerprint: deepFingerprint }
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
    out.send('screenprs:deep-status', { url: ctx.url, status, error, ...(status === 'running' ? { headSha: ctx.headSha } : {}) })
  }
  const sendResult = (findings: DeepFinding[]): void => {
    if (!live()) return
    setState(ctx.url, { findings, headSha: ctx.headSha })
    out.send('screenprs:deep-result', { url: ctx.url, findings, headSha: ctx.headSha })
    resultListener?.({ url: ctx.url, headSha: ctx.headSha, diff: ctx.diff, findings })
  }

  states.set(ctx.url, { status: 'idle', lenses: {}, findings: [], headSha: ctx.headSha })
  sendStatus('running')

  try {
    // Cache hit at this head SHA → the diff hasn't changed, so the prior deep
    // findings still hold. Serve them instantly, no model calls.
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
            collect(runTask(makeLensTask(lens, instructions, rubric), ctx, { runner: runnerFor(model, analysisDir), model, signal: controller.signal }))
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
            collect(runTask(makeSynthesisTask(synthInstructions, rubric), { ctx, raw }, { runner: runnerFor(synthModel, analysisDir), model: synthModel, signal: controller.signal }))
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
  stopPreparing(url)
  const active = activeDeep.get(url)
  if (!active) return
  active.controller.abort()
  activeDeep.delete(url)
  setState(url, { status: 'idle', lenses: {}, error: undefined })
  active.out.send('screenprs:deep-status', { url, status: 'idle' })
}

/** Abort at quit: nobody is left to tell. */
export function cancelAllDeepReviews(): void {
  for (const { controller } of activeDeep.values()) controller.abort()
  for (const controller of preparing) controller.abort()
  activeDeep.clear()
  preparing.clear()
  preparingFor.clear()
}

/** Every PR's deep review this launch, for a client that missed the events. */
export function deepReviewSnapshot(): Record<string, DeepReviewState> {
  return Object.fromEntries(states)
}
