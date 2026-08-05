/**
 * Screen PRs orchestration: fetch the review queue → gather each PR's context
 * over `gh` → `runFanout` the diff-only triage judgment → derive buckets → stream
 * cards to the renderer. Mirrors review.ts's per-window streaming shape, but
 * fanned out over PRs (plans/screen-prs.md §3.1).
 */
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import type { ModelRef, ScreenPrsFilters, ScreenPrsRunStatus } from '../shared/ipc-types'
import type { PrContext, ScreenPrCard, TriageResult } from '../shared/screenprs'
import { bucketOf } from '../shared/screenprs'
import { getModelConfig } from './models/config'
import { DEFAULT_TRIAGE_MODEL } from './models/claude-catalog'
import type { Runner } from './agent-tasks/runner'
import { createTaskExecution, targetFromModelRef } from './agent-tasks/registry'
import { runFanout } from './agent-tasks/orchestrator'
import { triageTask, TRIAGE_PROMPT_VERSION } from './tasks/triage-task'
import { currentHandle, searchReviewRequestedPrs, getPrMeta, getPrDiff, type PrMeta } from './github/gh'
import { analysisFingerprint, getCached, putTriage } from './screenprs-cache'

/** In-flight run per window, so a re-screen / window close can cancel cleanly. */
const activeRuns = new Map<number, AbortController>()

function send(wc: WebContents, channel: string, data: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, data)
}
function sendStatus(wc: WebContents, status: ScreenPrsRunStatus, extra: { error?: string; total?: number } = {}): void {
  send(wc, 'screenprs:status', { status, ...extra })
}

/**
 * Runner for the triage pass. Local (Ollama) → harness-free `DirectRunner`
 * (the diff is self-contained); otherwise the cloud harness. The concurrency
 * here is provisional — the eventual per-backend gate (local-serial for the GPU,
 * parallel for cloud; see plans/bounded-tasks.md) will own this.
 */
function selectTriageRunner(cwd = tmpdir()): { runner: Runner; model?: ModelRef; concurrency: number } {
  // Fall back to Haiku (not the CLI's implicit default) when unconfigured.
  const def = getModelConfig().defaults.screenPrs ?? DEFAULT_TRIAGE_MODEL
  return createTaskExecution(targetFromModelRef(def), { cwd, selfContained: true })
}

function currentTriageFingerprint(): string {
  const model = getModelConfig().defaults.screenPrs ?? DEFAULT_TRIAGE_MODEL
  return analysisFingerprint({ target: targetFromModelRef(model), promptVersion: TRIAGE_PROMPT_VERSION, schemaVersion: 1 })
}

/** Run async `fn` over `items`, at most `limit` at once; failures resolve to null. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try {
        out[i] = await fn(items[i])
      } catch {
        out[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

export async function startScreening(filters: ScreenPrsFilters, webContents: WebContents): Promise<void> {
  cancelScreening(webContents)
  const controller = new AbortController()
  activeRuns.set(webContents.id, controller)
  sendStatus(webContents, 'running')

  try {
    const handle = await currentHandle()
    const refs = await searchReviewRequestedPrs({ owner: filters.owner, updatedSince: filters.updatedSince })
    if (controller.signal.aborted) return
    if (refs.length === 0) {
      sendStatus(webContents, 'done', { total: 0 })
      activeRuns.delete(webContents.id)
      return
    }

    // Seed the queue immediately (before the slower context gather) so the UI
    // shows a "Screening…" placeholder per PR the moment the search returns.
    send(webContents, 'screenprs:queued', { refs })

    // Always refetch the cheap metadata (CI/reviews/size/head SHA) — even a cached
    // PR gets a fresh bucket. The diff + model run are what the cache saves.
    const metas = (await mapLimit(refs, 5, (ref) => getPrMeta(ref, handle))).filter(
      (m): m is PrMeta => m !== null
    )
    if (controller.signal.aborted) return

    const emitCard = (ctx: PrContext, result: TriageResult): void => {
      const card: ScreenPrCard = { ...ctx, ...result, bucket: bucketOf({ ...ctx, ...result }) }
      send(webContents, 'screenprs:card', { card })
    }

    // Cache hit (same head SHA) → reuse the diff + triage, no model call. Miss (or
    // ⌥-force) → gather the diff and queue it for the model.
    const triageFingerprint = currentTriageFingerprint()
    const toTriage: PrMeta[] = []
    for (const meta of metas) {
      const cached = filters.force ? undefined : getCached(meta.url, meta.headSha, triageFingerprint)
      if (cached) emitCard({ ...meta, diff: cached.diff }, cached.triage)
      else toTriage.push(meta)
    }

    // Fetch diffs only for the misses, emitting each PR into the "Screening…"
    // section as its diff lands (as "scheduled" — waiting for the model).
    const contexts = (
      await mapLimit(toTriage, 5, async (m) => {
        const ctx = { ...m, diff: await getPrDiff(m) }
        if (!controller.signal.aborted) send(webContents, 'screenprs:screening', { context: ctx })
        return ctx
      })
    ).filter((c): c is PrContext => c !== null)
    if (controller.signal.aborted) return

    const analysisDir = mkdtempSync(join(tmpdir(), 'simpleedit-triage-'))
    const { runner, model, concurrency } = selectTriageRunner(analysisDir)
    const results: (TriageResult | null)[] = new Array(contexts.length).fill(null)

    // Per-PR budget: a stuck/slow model call is aborted so it can't freeze the
    // whole screen (that PR falls back to a metadata-only bucket). Generous
    // enough for a slow local model on a large diff.
    const TRIAGE_TIMEOUT_MS = 120_000
    try {
      for await (const ev of runFanout(triageTask, contexts, {
        runner,
        model,
        concurrency,
        signal: controller.signal,
        timeoutMs: TRIAGE_TIMEOUT_MS,
      })) {
        if (ev.kind === 'start') {
          // The model has picked this PR up — promote it from scheduled to running.
          send(webContents, 'screenprs:triaging', { url: ev.input.url })
        } else if (ev.kind === 'item') {
          results[ev.index] = ev.item ?? null
        } else if (ev.kind === 'done' || ev.kind === 'error') {
          // A model failure (or empty output) still yields a card — bucketed from
          // metadata alone (impact 'low', no findings) so the PR isn't dropped.
          const result: TriageResult = results[ev.index] ?? { impact: 'low', findings: [] }
          const ctx = ev.input
          if (ev.kind === 'done' && results[ev.index]) {
            putTriage(ctx.url, ctx.headSha, ctx.diff, result, triageFingerprint)
          }
          emitCard(ctx, result)
        }
      }
    } finally {
      rmSync(analysisDir, { recursive: true, force: true })
    }

    if (!controller.signal.aborted) sendStatus(webContents, 'done', { total: metas.length })
  } catch (err: unknown) {
    if (!controller.signal.aborted) {
      sendStatus(webContents, 'error', { error: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    if (activeRuns.get(webContents.id) === controller) activeRuns.delete(webContents.id)
  }
}

export function cancelScreening(webContents: WebContents): void {
  activeRuns.get(webContents.id)?.abort()
  activeRuns.delete(webContents.id)
}

export function cancelAllScreening(): void {
  for (const c of activeRuns.values()) c.abort()
  activeRuns.clear()
}
