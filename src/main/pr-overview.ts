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
import { gatherOverviewContext, overviewFacts } from './github/pr-overview-context'
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

function setState(url: string, patch: Partial<OverviewState>): void {
  states.set(url, { ...(states.get(url) ?? { status: 'idle' }), ...patch })
}

export function overviewModel(): ModelRef {
  return getModelConfig().defaults.prOverview ?? DEFAULT_OVERVIEW_MODEL
}

export function overviewFingerprint(model: ModelRef | undefined, instructions: string): string {
  return analysisFingerprint({
    target: targetFromModelRef(model),
    promptVersion: OVERVIEW_PROMPT_VERSION,
    instructions: instructionsHash(instructions),
    schemaVersion: 1,
  })
}

/** Settles when the overview it started ends; a join settles at once. */
export async function startOverview(ctx: PrContext, out: RemoteClient): Promise<ScreenPrsStartResult> {
  // Resolved once so the fingerprint and the model call see the same text.
  const instructions = resolveInstructions('overview').text
  const model = overviewModel()
  const fingerprint = overviewFingerprint(model, instructions)
  const running = activeOverviews.get(ctx.url)
  if (running) {
    if (running.headSha === ctx.headSha && running.fingerprint === fingerprint) return { joined: true }
    cancelOverview(ctx.url)
  }
  const controller = new AbortController()
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

    // A caller that didn't carry the diff (the phone before it opened Files)
    // still gets the review diff the board was screened from.
    const context = await withGhSignal(controller.signal, async () => {
      const pr = ctx.diff ? ctx : { ...ctx, diff: await reviewDiffFor(ctx) }
      const handle = await currentHandle().catch(() => '')
      return gatherOverviewContext(pr, {
        handle,
        resolver: createBaseResolver(),
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
  const active = activeOverviews.get(url)
  if (!active) return
  active.controller.abort()
  activeOverviews.delete(url)
  setState(url, { status: 'idle', error: undefined })
  active.out.send('screenprs:overview-status', { url, status: 'idle' })
}

/** Abort at quit: nobody is left to tell. */
export function cancelAllOverviews(): void {
  for (const { controller } of activeOverviews.values()) controller.abort()
  activeOverviews.clear()
}

/** Every PR's overview this launch, for a client that missed the events. */
export function overviewSnapshot(): Record<string, OverviewState> {
  return Object.fromEntries(states)
}
