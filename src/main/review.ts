import type { WebContents } from 'electron'
import type { ReviewFinding, ReviewStatus, ModelRef } from '../shared/ipc-types'
import { getModelConfig } from './models/config'
import type { Runner } from './agent-tasks/runner'
import { createTaskExecution, targetFromModelRef } from './agent-tasks/registry'
import { runTask } from './agent-tasks/orchestrator'
import { reviewTask, type ReviewContext } from './tasks/review-task'

export function reviewKey(worktreePath: string, commitHash: string | null): string {
  return `${worktreePath}:${commitHash ?? 'staging'}`
}

const activeReviews = new Map<string, { abort: () => void }>()

function send(wc: WebContents, channel: string, data: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, data)
}

function sendStatus(wc: WebContents, key: string, status: ReviewStatus, error?: string): void {
  send(wc, 'review:status', { key, status, error })
}

function sendFinding(wc: WebContents, key: string, finding: ReviewFinding): void {
  send(wc, 'review:finding', { key, finding })
}

/**
 * Pick the runner from the configured Review default. Unset or `anthropic`
 * keeps today's cloud harness (`--model` added only when a Claude model is
 * chosen; unset ⇒ byte-for-byte the previous behaviour). `ollama` routes to the
 * harness-free DirectRunner against Ollama's native `/api/chat`.
 */
export function selectRunner(worktreePath: string): { runner: Runner; model?: ModelRef } {
  const def = getModelConfig().defaults.review
  const { runner, model } = createTaskExecution(targetFromModelRef(def), { cwd: worktreePath })
  return { runner, model }
}

export async function startReview(
  worktreePath: string,
  commitHash: string | null,
  webContents: WebContents
): Promise<void> {
  const key = reviewKey(worktreePath, commitHash)

  // Cancel any in-progress review for this target before starting fresh
  cancelReview(worktreePath, commitHash)

  sendStatus(webContents, key, 'running')

  let ctx: ReviewContext
  try {
    ctx = await reviewTask.buildContext({ worktreePath, commitHash })
  } catch (err: unknown) {
    sendStatus(webContents, key, 'error', String(err))
    return
  }

  if (!ctx.diff.trim()) {
    sendStatus(webContents, key, 'done')
    return
  }

  const { runner, model } = selectRunner(worktreePath)
  const controller = new AbortController()
  activeReviews.set(key, { abort: () => controller.abort() })

  let counter = 0
  try {
    for await (const raw of runTask(
      reviewTask,
      { worktreePath, commitHash },
      { runner, model, signal: controller.signal, context: ctx }
    )) {
      const finding: ReviewFinding = { ...raw, id: `${key}:${counter++}` }
      sendFinding(webContents, key, finding)
    }
    activeReviews.delete(key)
    sendStatus(webContents, key, 'done')
  } catch (err: unknown) {
    activeReviews.delete(key)
    // A user-initiated cancel aborts the runner, which surfaces as a throw here.
    // That's not a failure — report a neutral 'done' rather than 'error'.
    if (controller.signal.aborted) {
      sendStatus(webContents, key, 'done')
    } else {
      sendStatus(webContents, key, 'error', err instanceof Error ? err.message : String(err))
    }
  }
}

export function cancelReview(worktreePath: string, commitHash: string | null): void {
  const key = reviewKey(worktreePath, commitHash)
  activeReviews.get(key)?.abort()
  activeReviews.delete(key)
}

export function cancelAllReviews(): void {
  for (const { abort } of activeReviews.values()) abort()
  activeReviews.clear()
}
