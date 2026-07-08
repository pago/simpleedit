/**
 * Screen PRs orchestration: fetch the review queue → gather each PR's context
 * over `gh` → `runFanout` the diff-only triage judgment → derive buckets → stream
 * cards to the renderer. Mirrors review.ts's per-window streaming shape, but
 * fanned out over PRs (plans/screen-prs.md §3.1).
 */
import { tmpdir } from 'os'
import type { WebContents } from 'electron'
import type { ModelRef, ScreenPrsFilters, ScreenPrsRunStatus } from '../shared/ipc-types'
import type { PrContext, ScreenPrCard, TriageResult } from '../shared/screenprs'
import { bucketOf } from '../shared/screenprs'
import { getModelConfig } from './models/config'
import { DEFAULT_TRIAGE_MODEL } from './models/claude-catalog'
import { ClaudeCodeRunner, DirectRunner, type Runner } from './agent-tasks/runner'
import { runFanout } from './agent-tasks/orchestrator'
import { triageTask } from './tasks/triage-task'
import { currentHandle, searchReviewRequestedPrs, getPrContext } from './github/gh'

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
function selectTriageRunner(): { runner: Runner; model?: ModelRef; concurrency: number } {
  // Fall back to Haiku (not the CLI's implicit default) when unconfigured.
  const def = getModelConfig().defaults.screenPrs ?? DEFAULT_TRIAGE_MODEL
  if (def.provider === 'ollama') return { runner: new DirectRunner(), model: def, concurrency: 1 }
  // Triage is self-contained (diff in the prompt), so the harness needs no real
  // worktree — a throwaway cwd is fine.
  return { runner: new ClaudeCodeRunner({ cwd: tmpdir() }), model: def, concurrency: 4 }
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

    // Gather each PR's context (bounded), emitting a placeholder card as each
    // lands so the queue fills before the model judgments arrive.
    const gathered = await mapLimit(refs, 5, (ref) => getPrContext(ref, handle))
    if (controller.signal.aborted) return
    const contexts: PrContext[] = gathered.filter((c): c is PrContext => c !== null)
    for (const ctx of contexts) send(webContents, 'screenprs:screening', { context: ctx })

    const { runner, model, concurrency } = selectTriageRunner()
    const results: (TriageResult | null)[] = new Array(contexts.length).fill(null)

    for await (const ev of runFanout(triageTask, contexts, { runner, model, concurrency, signal: controller.signal })) {
      if (ev.kind === 'item') {
        results[ev.index] = ev.item ?? null
      } else if (ev.kind === 'done' || ev.kind === 'error') {
        // A model failure (or empty output) still yields a card — bucketed from
        // metadata alone (impact 'low', no findings) so the PR isn't dropped.
        const result: TriageResult = results[ev.index] ?? { impact: 'low', findings: [] }
        const card: ScreenPrCard = { ...ev.input, ...result, bucket: bucketOf({ ...ev.input, ...result }) }
        send(webContents, 'screenprs:card', { card })
      }
    }

    if (!controller.signal.aborted) sendStatus(webContents, 'done', { total: contexts.length })
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
