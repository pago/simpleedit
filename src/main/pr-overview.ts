/**
 * PR Overview orchestration: gather the context (`github/pr-overview-context`),
 * run the overview task once in text mode, cache the raw answer on the PR's
 * screening entry, and send it to whichever client asked. Mirrors
 * `deep-review.ts`: one run per PR url, plain `send`, so the phone gets the
 * same events as the desktop.
 */
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import type { RemoteClient } from './client-hub'
import type { ModelRef } from '../shared/ipc-types'
import type { PrContext } from '../shared/screenprs'
import type { OverviewStatus } from '../shared/pr-overview'
import { getModelConfig } from './models/config'
import { DEFAULT_OVERVIEW_MODEL } from './models/claude-catalog'
import { createTaskExecution, targetFromModelRef } from './agent-tasks/registry'
import { runTask } from './agent-tasks/orchestrator'
import { withBackendGate } from './agent-tasks/gate'
import { makeOverviewTask, OVERVIEW_PROMPT_VERSION } from './tasks/overview-task'
import { resolveInstructions, instructionsHash } from './prompts/overrides'
import { currentHandle } from './github/gh'
import { createBaseResolver } from './github/stack-base'
import { gatherOverviewContext, overviewFacts } from './github/pr-overview-context'
import { analysisFingerprint, getCachedFindings, getCachedOverview, putOverview } from './screenprs-cache'
import { reviewDiffFor } from './screenprs'

const activeOverviews = new Map<string, AbortController>()

function send(wc: RemoteClient, channel: string, data: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, data)
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

export async function startOverview(ctx: PrContext, webContents: RemoteClient): Promise<void> {
  cancelOverview(ctx.url)
  const controller = new AbortController()
  activeOverviews.set(ctx.url, controller)
  const sendStatus = (status: OverviewStatus, error?: string): void =>
    send(webContents, 'screenprs:overview-status', { url: ctx.url, status, error })

  sendStatus('running')
  try {
    // Resolved once so the fingerprint and the model call see the same text.
    const instructions = resolveInstructions('overview').text
    const model = overviewModel()
    const fingerprint = overviewFingerprint(model, instructions)
    const cached = getCachedOverview(ctx.url, ctx.headSha, fingerprint)
    if (cached) {
      send(webContents, 'screenprs:overview-result', { url: ctx.url, headSha: ctx.headSha, text: cached.text, facts: cached.facts })
      sendStatus('done')
      return
    }

    // A caller that didn't carry the diff (the phone before it opened Files)
    // still gets the review diff the board was screened from.
    const pr = ctx.diff ? ctx : { ...ctx, diff: await reviewDiffFor(ctx) }
    const handle = await currentHandle().catch(() => '')
    const context = await gatherOverviewContext(pr, {
      handle,
      resolver: createBaseResolver(),
      ...getCachedFindings(ctx.url, ctx.headSha),
    })
    if (controller.signal.aborted) return

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
    if (controller.signal.aborted) return
    if (!text) throw new Error('The model returned no overview.')

    const facts = overviewFacts(context)
    putOverview(ctx.url, ctx.headSha, { text, facts, at: new Date().toISOString() }, fingerprint)
    send(webContents, 'screenprs:overview-result', { url: ctx.url, headSha: ctx.headSha, text, facts })
    sendStatus('done')
  } catch (err: unknown) {
    if (!controller.signal.aborted) sendStatus('error', err instanceof Error ? err.message : String(err))
  } finally {
    if (activeOverviews.get(ctx.url) === controller) activeOverviews.delete(ctx.url)
  }
}

export function cancelOverview(url: string): void {
  activeOverviews.get(url)?.abort()
  activeOverviews.delete(url)
}

export function cancelAllOverviews(): void {
  for (const c of activeOverviews.values()) c.abort()
  activeOverviews.clear()
}
