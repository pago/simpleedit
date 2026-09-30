/**
 * Screen PRs orchestration: fetch the review queue → gather each PR's context
 * over `gh` → `runFanout` the diff-only triage judgment → derive buckets → stream
 * cards to the renderer. Mirrors review.ts's per-window streaming shape, but
 * fanned out over PRs (plans/screen-prs.md §3.1).
 */
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import type { RemoteClient } from './client-hub'
import type { ModelRef, ScreenPrsFilters, ScreenPrsRunStatus } from '../shared/ipc-types'
import type { PrContext, ScreenPrCard, TriageResult } from '../shared/screenprs'
import { bucketOf } from '../shared/screenprs'
import { getModelConfig } from './models/config'
import { DEFAULT_TRIAGE_MODEL } from './models/claude-catalog'
import type { Runner } from './agent-tasks/runner'
import { createTaskExecution, targetFromModelRef } from './agent-tasks/registry'
import { runFanout } from './agent-tasks/orchestrator'
import { makeTriageTask, TRIAGE_PROMPT_VERSION } from './tasks/triage-task'
import { resolveInstructions, instructionsHash } from './prompts/overrides'
import { currentHandle, searchReviewRequestedPrs, getPrMeta, type PrMeta } from './github/gh'
import { baseKey, createBaseResolver, getReviewDiff, getReviewDiffByUrl, withReviewDiff } from './github/stack-base'
import { analysisFingerprint, getCached, getCachedDiff, putTriage } from './screenprs-cache'

/**
 * In-flight run per client identity, so a re-screen / window close can cancel
 * cleanly. The key is read off the `RemoteClient` that will receive the cards,
 * never passed alongside it — a `ClientHub` is one identity with several
 * transports, so a web client re-screening cancels and replaces the run whose
 * output it is already receiving instead of starting a second, competing one.
 */
const activeRuns = new Map<number, AbortController>()

function send(wc: RemoteClient, channel: string, data: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, data)
}

/**
 * The same card/context, with the diff emptied — what a remote client gets.
 *
 * `PrContext.diff` is the FULL unified diff and screening defaults to every org
 * where you're a reviewer, so a board is dozens of complete diffs pushed down a
 * WebSocket to a phone that will open one of them. The field is emptied rather
 * than dropped so the payload still is a `PrContext` (a missing-but-typed
 * `string` is the kind of lie that surfaces three call sites away); the client
 * fetches the real diff with `screenprs:pr-diff` when it opens a PR.
 */
function withoutDiff<T extends PrContext>(value: T): T {
  return { ...value, diff: '' }
}

/** Push `local` to the window's renderer and the diff-less `remote` to sockets. */
function sendSplit(wc: RemoteClient, channel: string, local: unknown, remote: unknown): void {
  if (wc.isDestroyed()) return
  if (wc.sendSplit) wc.sendSplit(channel, local, remote)
  else wc.send(channel, local)
}
function sendStatus(wc: RemoteClient, status: ScreenPrsRunStatus, extra: { error?: string; total?: number } = {}): void {
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

export function currentTriageFingerprint(instructions: string): string {
  const model = getModelConfig().defaults.screenPrs ?? DEFAULT_TRIAGE_MODEL
  return analysisFingerprint({
    target: targetFromModelRef(model),
    promptVersion: TRIAGE_PROMPT_VERSION,
    schemaVersion: 2,
    instructions: instructionsHash(instructions),
  })
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

export async function startScreening(filters: ScreenPrsFilters, webContents: RemoteClient): Promise<void> {
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
      sendSplit(webContents, 'screenprs:card', { card }, { card: withoutDiff(card) })
    }

    // Cache hit (same head SHA and base) → reuse the diff + triage, no model
    // call. Miss (or ⌥-force) → gather the diff and queue it for the model.
    // Resolved once so the fingerprint and every model call see the same text.
    const instructions = resolveInstructions('triage').text
    const triageFingerprint = currentTriageFingerprint(instructions)
    const resolver = createBaseResolver()
    const baseKeys = new Map<string, string>()
    await mapLimit(metas, 5, async (m) => baseKeys.set(m.url, await baseKey(m, resolver)))
    if (controller.signal.aborted) return
    const toTriage: PrMeta[] = []
    for (const meta of metas) {
      const key = baseKeys.get(meta.url) ?? ''
      const cached = filters.force ? undefined : getCached(meta.url, meta.headSha, triageFingerprint, key)
      if (cached) emitCard(withReviewDiff(meta, cached), cached.triage)
      else toTriage.push(meta)
    }

    // Fetch diffs only for the misses, emitting each PR into the "Screening…"
    // section as its diff lands (as "scheduled" — waiting for the model).
    const contexts = (
      await mapLimit(toTriage, 5, async (m) => {
        const ctx: PrContext = withReviewDiff(m, await getReviewDiff(m, resolver, metas))
        if (!controller.signal.aborted) {
          sendSplit(webContents, 'screenprs:screening', { context: ctx }, { context: withoutDiff(ctx) })
        }
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
      for await (const ev of runFanout(makeTriageTask(instructions), contexts, {
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
            putTriage(ctx.url, ctx.headSha, ctx.diff, result, triageFingerprint, {
              key: baseKeys.get(ctx.url) ?? '',
              analysis: ctx.base,
            })
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

/**
 * The review diff for the phone, which opens one PR at a time and fetches its
 * diff on demand. The cached diff at this head is what the board it is looking
 * at was screened from; without a hit, it is recomputed.
 */
export async function reviewDiffFor(pr: { url: string; headSha?: string }): Promise<string> {
  const cached = pr.headSha ? getCachedDiff(pr.url, pr.headSha) : undefined
  return cached ?? getReviewDiffByUrl(pr.url)
}

export function cancelScreening(webContents: RemoteClient): void {
  activeRuns.get(webContents.id)?.abort()
  activeRuns.delete(webContents.id)
}

export function cancelAllScreening(): void {
  for (const c of activeRuns.values()) c.abort()
  activeRuns.clear()
}
