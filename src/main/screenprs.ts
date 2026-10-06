/**
 * Screen PRs orchestration: fetch the review queue → gather each PR's context
 * over `gh` → `runFanout` the diff-only triage judgment → derive buckets → stream
 * cards to every client (plans/screen-prs.md §3.1).
 */
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import type { RemoteClient } from './client-hub'
import type { ModelRef, ScreenPrsFilters, ScreenPrsRunEntry, ScreenPrsRunStatus, ScreenPrsStartResult, ScreenPrsState } from '../shared/ipc-types'
import type { PrContext, PrRef, ScreenPrCard, TriageResult } from '../shared/screenprs'
import { bucketOf } from '../shared/screenprs'
import { getModelConfig } from './models/config'
import { DEFAULT_TRIAGE_MODEL } from './models/claude-catalog'
import type { Runner } from './agent-tasks/runner'
import { createTaskExecution, targetFromModelRef } from './agent-tasks/registry'
import { runFanout } from './agent-tasks/orchestrator'
import { makeTriageTask, TRIAGE_PROMPT_VERSION } from './tasks/triage-task'
import { resolveInstructions, instructionsHash } from './prompts/overrides'
import { currentHandle, searchReviewRequestedPrs, getPrMeta, withGhSignal, type PrMeta } from './github/gh'
import { baseKey, createBaseResolver, getReviewDiff, getReviewDiffByUrl, withReviewDiff } from './github/stack-base'
import { analysisFingerprint, getCached, getCachedDiff, putTriage } from './screenprs-cache'

/**
 * The app's one screening: the current run, or the last one to end.
 *
 * Runs belong to the app, not to a window: the queue is the user's, the filter
 * and the triage cache are shared, and every client shows the same board. So
 * every event goes to every client (`out`, which `index.ts` makes reach them
 * all), a second start while one runs joins it, and any client can stop it.
 * The board is kept here so a client that missed the events (a window opened
 * mid-run, a phone that reconnected or switched project) asks for it whole.
 */
interface Run {
  controller: AbortController
  filters: ScreenPrsFilters
  out: RemoteClient
  status: ScreenPrsRunStatus
  total?: number
  error?: string
  entries: Map<string, ScreenPrsRunEntry>
  triaging: Set<string>
}

let run: Run | null = null

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

/** Whether `r` may still report: neither stopped nor replaced. */
function live(r: Run): boolean {
  return run === r && !r.controller.signal.aborted
}

function setStatus(r: Run, status: ScreenPrsRunStatus, extra: { error?: string; total?: number } = {}): void {
  r.status = status
  if (extra.total !== undefined) r.total = extra.total
  r.error = extra.error
  r.out.send('screenprs:status', { status, ...extra })
}

/** `local` to each window's renderer, the diff-less `remote` to sockets. */
function sendSplit(r: Run, channel: string, local: unknown, remote: unknown): void {
  if (r.out.sendSplit) r.out.sendSplit(channel, local, remote)
  else r.out.send(channel, local)
}

function entry(r: Run, ref: PrRef): ScreenPrsRunEntry {
  const existing = r.entries.get(ref.url)
  if (existing) return existing
  const created: ScreenPrsRunEntry = { ref }
  r.entries.set(ref.url, created)
  return created
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

function sameFilters(a: ScreenPrsFilters, b: ScreenPrsFilters): boolean {
  return (a.owner ?? '') === (b.owner ?? '') && a.updatedSince === b.updatedSince && !!a.force === !!b.force
}

/**
 * Screen the review queue for every client. A start with the same filters
 * joins the run already going; one with different filters replaces it.
 * Settles when the run it started ends; a join settles at once.
 */
export async function startScreening(filters: ScreenPrsFilters, out: RemoteClient): Promise<ScreenPrsStartResult> {
  if (run?.status === 'running') {
    if (sameFilters(run.filters, filters)) return { joined: true }
    // The filter is shared, so a start that differs is the newer intent: it
    // replaces the run, and every client sees the stop and the restart.
    cancelScreening()
  }
  const r: Run = { controller: new AbortController(), filters, out, status: 'running', entries: new Map(), triaging: new Set() }
  run = r
  const { signal } = r.controller
  setStatus(r, 'running')

  return withGhSignal(signal, async () => {
    try {
      const handle = await currentHandle()
      const refs = await searchReviewRequestedPrs({ owner: filters.owner, updatedSince: filters.updatedSince })
      if (!live(r)) return { joined: false }
      if (refs.length === 0) {
        setStatus(r, 'done', { total: 0 })
        return { joined: false }
      }

      // Seed the queue immediately (before the slower context gather) so the UI
      // shows a "Screening…" placeholder per PR the moment the search returns.
      for (const ref of refs) entry(r, ref)
      r.total = refs.length
      out.send('screenprs:queued', { refs })

      // Always refetch the cheap metadata (CI/reviews/size/head SHA) — even a cached
      // PR gets a fresh bucket. The diff + model run are what the cache saves.
      const metas = (await mapLimit(refs, 5, (ref) => getPrMeta(ref, handle))).filter(
        (m): m is PrMeta => m !== null
      )
      if (!live(r)) return { joined: false }

      const emitCard = (ctx: PrContext, result: TriageResult): void => {
        if (!live(r)) return
        const card: ScreenPrCard = { ...ctx, ...result, bucket: bucketOf({ ...ctx, ...result }) }
        Object.assign(entry(r, card), { context: card, card })
        r.triaging.delete(card.url)
        sendSplit(r, 'screenprs:card', { card }, { card: withoutDiff(card) })
      }

      // Cache hit (same head SHA and base) → reuse the diff + triage, no model
      // call. Miss (or ⌥-force) → gather the diff and queue it for the model.
      // Resolved once so the fingerprint and every model call see the same text.
      const instructions = resolveInstructions('triage').text
      const triageFingerprint = currentTriageFingerprint(instructions)
      const resolver = createBaseResolver()
      const baseKeys = new Map<string, string>()
      await mapLimit(metas, 5, async (m) => baseKeys.set(m.url, await baseKey(m, resolver)))
      if (!live(r)) return { joined: false }
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
          if (live(r)) {
            entry(r, ctx).context = ctx
            sendSplit(r, 'screenprs:screening', { context: ctx }, { context: withoutDiff(ctx) })
          }
          return ctx
        })
      ).filter((c): c is PrContext => c !== null)
      if (!live(r)) return { joined: false }

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
          signal,
          timeoutMs: TRIAGE_TIMEOUT_MS,
        })) {
          if (ev.kind === 'start') {
            // The model has picked this PR up — promote it from scheduled to running.
            if (live(r)) {
              r.triaging.add(ev.input.url)
              out.send('screenprs:triaging', { url: ev.input.url })
            }
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

      if (live(r)) setStatus(r, 'done', { total: metas.length })
    } catch (err: unknown) {
      if (live(r)) setStatus(r, 'error', { error: err instanceof Error ? err.message : String(err) })
    }
    return { joined: false }
  })
}

/**
 * The current or last screening as `remote` (a socket client, so no diffs) or
 * a window's renderer sees it.
 */
export function screeningSnapshot(remote: boolean): ScreenPrsState['run'] {
  if (!run) return { status: 'idle', entries: [], triaging: [] }
  const strip = <T extends PrContext>(value: T | undefined): T | undefined =>
    value && remote ? withoutDiff(value) : value
  return {
    status: run.status,
    total: run.total,
    error: run.error,
    entries: [...run.entries.values()].map((e) => ({ ref: e.ref, context: strip(e.context), card: strip(e.card) })),
    triaging: [...run.triaging],
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

/** Stop the screening, whoever started it, and tell every client. */
export function cancelScreening(): void {
  if (run?.status !== 'running') return
  run.controller.abort()
  run.triaging.clear()
  setStatus(run, 'cancelled')
}

/** Abort at quit, killing its `gh` children: nobody is left to tell. */
export function cancelAllScreening(): void {
  run?.controller.abort()
}
