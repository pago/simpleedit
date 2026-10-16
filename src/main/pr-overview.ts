/**
 * PR Overview orchestration: gather the context (`github/pr-overview-context`),
 * run the overview task once in text mode, cache the raw answer on the PR's
 * screening entry, and send it to every client. Mirrors `deep-review.ts`: one
 * run per PR url, app-wide; a second start joins it and any client can stop it.
 */
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import type { RemoteClient } from './client-hub'
import type { ModelRef } from '../shared/ipc-types'
import type { PrContext } from '../shared/screenprs'
import type { OverviewFacts, OverviewState, OverviewStatus } from '../shared/pr-overview'
import type { ScreenPrsStartResult } from '../shared/ipc-types'
import { getModelConfig } from './models/config'
import { DEFAULT_OVERVIEW_MODEL } from './models/claude-catalog'
import { createTaskExecution, targetFromModelRef } from './agent-tasks/registry'
import { runTask } from './agent-tasks/orchestrator'
import { withBackendGate } from './agent-tasks/gate'
import { makeOverviewTask, OVERVIEW_PROMPT_VERSION } from './tasks/overview-task'
import { resolveInstructions, instructionsHash } from './prompts/overrides'
import { currentHandle, withGhSignal } from './github/gh'
import { createBaseResolver } from './github/stack-base'
import { diffFiles, gatherOverviewContext, overviewFacts } from './github/pr-overview-context'
import { fetchReviewRubric, rubricFingerprint, type ReviewRubric } from './github/review-rubric'
import { analysisFingerprint, getCachedFindings, getCachedOverview, putOverview } from './screenprs-cache'
import { reviewDiffFor } from './screenprs'

interface ActiveOverview {
  controller: AbortController
  out: RemoteClient
  headSha: string
  fingerprint: string
}
const activeOverviews = new Map<string, ActiveOverview>()
/** Each PR's latest overview this launch, for a client that missed the events. */
const states = new Map<string, OverviewState>()
/** Pre-start reads (diff, rubric) not yet owned by a run, so quit can still kill their `gh`. */
const preparing = new Set<AbortController>()
/** Each PR's starts still reading, by head: a start for another head supersedes them, and Stop reaches them. */
const preparingFor = new Map<string, Set<{ controller: AbortController; headSha: string; out: RemoteClient }>>()

/** Registers a start that is still reading, aborting older ones for another head: the newest intent wins. */
function beginPreparing(url: string, headSha: string, controller: AbortController, out: RemoteClient): () => void {
  const starts = preparingFor.get(url) ?? new Set()
  for (const older of starts) if (older.headSha !== headSha) older.controller.abort()
  const mine = { controller, headSha, out }
  starts.add(mine)
  preparingFor.set(url, starts)
  preparing.add(controller)
  return () => {
    preparing.delete(controller)
    starts.delete(mine)
    if (!starts.size && preparingFor.get(url) === starts) preparingFor.delete(url)
  }
}

/** Aborts the PR's starts still reading; the client to tell, if any was. */
function stopPreparing(url: string): RemoteClient | undefined {
  let out: RemoteClient | undefined
  for (const start of preparingFor.get(url) ?? []) {
    if (!start.controller.signal.aborted) out = start.out
    start.controller.abort()
  }
  return out
}

export interface OverviewResult {
  url: string
  headSha: string
  /** The diff the overview read, which its citations point into. */
  diff: string
  text: string
}

let resultListener: ((result: OverviewResult) => void) | null = null

/** Called with every overview a client is sent, a cache hit included. */
export function onOverviewResult(fn: ((result: OverviewResult) => void) | null): void {
  resultListener = fn
}

function setState(url: string, patch: Partial<OverviewState>): void {
  states.set(url, { ...(states.get(url) ?? { status: 'idle' }), ...patch })
}

export function overviewModel(): ModelRef {
  return getModelConfig().defaults.prOverview ?? DEFAULT_OVERVIEW_MODEL
}

export function overviewFingerprint(model: ModelRef | undefined, instructions: string, rubric?: ReviewRubric, authorBriefing?: string): string {
  return analysisFingerprint({
    target: targetFromModelRef(model),
    promptVersion: OVERVIEW_PROMPT_VERSION,
    instructions: instructionsHash(instructions),
    rubric: rubricFingerprint(rubric),
    // A new or changed briefing is new input: the cached answer didn't check it.
    ...(authorBriefing ? { authorBriefing: instructionsHash(authorBriefing) } : {}),
    schemaVersion: 1,
  })
}

/** The Review Room's author briefing for a PR, as markdown; set by main's wiring (the room imports this module's results). */
let briefingSource: ((url: string, headSha: string) => string | undefined) | null = null

export function setOverviewBriefingSource(fn: typeof briefingSource): void {
  briefingSource = fn
}

function authorBriefingFor(url: string, headSha: string): string | undefined {
  try {
    return briefingSource?.(url, headSha)
  } catch (err) {
    console.warn('[Overview] Reading the author briefing failed:', err instanceof Error ? err.message : err)
    return undefined
  }
}

/** Settles when the overview it started ends; a join settles at once. */
export async function startOverview(ctx: PrContext, out: RemoteClient): Promise<ScreenPrsStartResult> {
  // Resolved once so the fingerprint and the model call see the same text.
  const instructions = resolveInstructions('overview').text
  const model = overviewModel()
  // The rubric is part of the fingerprint, so it is read before the cache
  // check, and its candidates come from the diff. A caller that didn't carry
  // the diff (the phone before it opened Files) gets the review diff the board
  // was screened from.
  const controller = new AbortController()
  const donePreparing = beginPreparing(ctx.url, ctx.headSha, controller, out)
  let pr: PrContext
  let rubric: ReviewRubric | undefined
  try {
    ;({ pr, rubric } = await withGhSignal(controller.signal, async () => {
      const withDiff = ctx.diff ? ctx : { ...ctx, diff: await reviewDiffFor(ctx) }
      const paths = diffFiles(withDiff.diff).map((f) => f.path)
      return { pr: withDiff, rubric: await fetchReviewRubric(ctx.url, ctx.headSha, paths) }
    }))
  } catch (err: unknown) {
    if (controller.signal.aborted) return { joined: false }
    // A run still going for this PR keeps the board; the caller hears why this start failed.
    if (activeOverviews.has(ctx.url)) throw err
    const error = err instanceof Error ? err.message : String(err)
    states.set(ctx.url, { status: 'error', error, headSha: ctx.headSha })
    out.send('screenprs:overview-status', { url: ctx.url, status: 'error', error })
    return { joined: false }
  } finally {
    donePreparing()
  }
  if (controller.signal.aborted) return { joined: false }
  const authorBriefing = authorBriefingFor(ctx.url, ctx.headSha)
  const fingerprint = overviewFingerprint(model, instructions, rubric, authorBriefing)
  const running = activeOverviews.get(ctx.url)
  if (running) {
    if (running.headSha === ctx.headSha && running.fingerprint === fingerprint) return { joined: true }
    // Starts for this head that are still reading join this run; only the run goes.
    stopRun(ctx.url)
  }
  const mine: ActiveOverview = { controller, out, headSha: ctx.headSha, fingerprint }
  activeOverviews.set(ctx.url, mine)
  const live = (): boolean => activeOverviews.get(ctx.url) === mine && !controller.signal.aborted
  const sendStatus = (status: OverviewStatus, error?: string): void => {
    if (!live()) return
    setState(ctx.url, { status, error })
    out.send('screenprs:overview-status', { url: ctx.url, status, error, ...(status === 'running' ? { headSha: ctx.headSha } : {}) })
  }
  const sendResult = (text: string, facts: OverviewFacts): void => {
    if (!live()) return
    setState(ctx.url, { text, facts, headSha: ctx.headSha })
    out.send('screenprs:overview-result', { url: ctx.url, headSha: ctx.headSha, text, facts })
    resultListener?.({ url: ctx.url, headSha: ctx.headSha, diff: pr.diff, text })
  }

  states.set(ctx.url, { status: 'idle', headSha: ctx.headSha })
  sendStatus('running')
  try {
    const cached = getCachedOverview(ctx.url, ctx.headSha, fingerprint)
    if (cached) {
      sendResult(cached.text, cached.facts)
      sendStatus('done')
      return { joined: false }
    }

    const context = await withGhSignal(controller.signal, async () => {
      const handle = await currentHandle().catch(() => '')
      return gatherOverviewContext(pr, {
        handle,
        resolver: createBaseResolver(),
        rubric,
        ...(authorBriefing ? { authorBriefing } : {}),
        ...getCachedFindings(ctx.url, ctx.headSha),
      })
    })
    if (!live()) return { joined: false }

    const analysisDir = mkdtempSync(join(tmpdir(), 'simpleedit-overview-'))
    let text: string | undefined
    try {
      const { runner } = createTaskExecution(targetFromModelRef(model), { cwd: analysisDir, selfContained: true })
      await withBackendGate(model, async () => {
        for await (const answer of runTask(makeOverviewTask(instructions), context, {
          runner,
          model,
          signal: controller.signal,
          context,
        })) {
          text = answer
        }
      })
    } finally {
      rmSync(analysisDir, { recursive: true, force: true })
    }
    if (!live()) return { joined: false }
    if (!text) throw new Error('The model returned no overview.')

    const facts = overviewFacts(context)
    putOverview(ctx.url, ctx.headSha, { text, facts, at: new Date().toISOString() }, fingerprint)
    sendResult(text, facts)
    sendStatus('done')
  } catch (err: unknown) {
    sendStatus('error', err instanceof Error ? err.message : String(err))
  } finally {
    if (activeOverviews.get(ctx.url) === mine) activeOverviews.delete(ctx.url)
  }
  return { joined: false }
}

/** Stop a PR's overview, whoever started it, and tell every client. */
export function cancelOverview(url: string): void {
  const told = stopPreparing(url)
  // A start still reading has sent nothing, but its client already shows it running.
  if (!stopRun(url) && told) {
    setState(url, { status: 'idle', error: undefined })
    told.send('screenprs:overview-status', { url, status: 'idle' })
  }
}

/** Stops the PR's run and tells every client; false when none was running. */
function stopRun(url: string): boolean {
  const active = activeOverviews.get(url)
  if (!active) return false
  active.controller.abort()
  activeOverviews.delete(url)
  setState(url, { status: 'idle', error: undefined })
  active.out.send('screenprs:overview-status', { url, status: 'idle' })
  return true
}

/** Abort at quit: nobody is left to tell. */
export function cancelAllOverviews(): void {
  for (const { controller } of activeOverviews.values()) controller.abort()
  for (const controller of preparing) controller.abort()
  activeOverviews.clear()
  preparing.clear()
  preparingFor.clear()
}

/** Every PR's overview this launch, for a client that missed the events. */
export function overviewSnapshot(): Record<string, OverviewState> {
  return Object.fromEntries(states)
}
