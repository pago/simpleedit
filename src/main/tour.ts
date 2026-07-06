import * as crypto from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { WebContents } from 'electron'
import type { Tour, TourTopic, TourStatus, ModelRef } from '../shared/ipc-types'
import { getModelConfig } from './models/config'
import { ClaudeCodeRunner, DirectRunner, type Runner } from './agent-tasks/runner'
import { runTask } from './agent-tasks/orchestrator'
import { tourTask, type TourContext } from './tasks/tour-task'

export function tourKey(worktreePath: string, commitHash: string | null): string {
  return `${worktreePath}:${commitHash ?? 'staging'}`
}

const activeTours = new Map<string, { abort: () => void }>()

function send(wc: WebContents, channel: string, data: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, data)
}

function sendStatus(wc: WebContents, key: string, status: TourStatus, error?: string): void {
  send(wc, 'tour:status', { key, status, error })
}

function sendOverview(wc: WebContents, key: string, overview: string): void {
  send(wc, 'tour:overview', { key, overview })
}

function sendTopic(wc: WebContents, key: string, topic: TourTopic): void {
  send(wc, 'tour:topic', { key, topic })
}

// ── Persistence ──────────────────────────────────────────

function tourCacheDir(): string {
  const dir = join(app.getPath('userData'), 'config', 'tours')
  mkdirSync(dir, { recursive: true })
  return dir
}

function tourCacheFile(worktreePath: string, commitHash: string | null): string {
  const key = tourKey(worktreePath, commitHash)
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  return join(tourCacheDir(), `${hash}.json`)
}

export function saveTour(worktreePath: string, commitHash: string | null, tour: Tour): void {
  try {
    writeFileSync(tourCacheFile(worktreePath, commitHash), JSON.stringify(tour, null, 2), 'utf-8')
  } catch (err) {
    console.error('[tour] save error:', err)
  }
}

export function loadTour(worktreePath: string, commitHash: string | null): Tour | null {
  try {
    const raw = readFileSync(tourCacheFile(worktreePath, commitHash), 'utf-8')
    return JSON.parse(raw) as Tour
  } catch {
    return null
  }
}

export function saveOverview(worktreePath: string, commitHash: string | null, overview: string): void {
  const existing = loadTour(worktreePath, commitHash)
  if (existing) {
    saveTour(worktreePath, commitHash, { ...existing, overview })
  }
}

// ── Runner selection ─────────────────────────────────────

/**
 * Pick the runner from the configured Tour default. Unset or `anthropic` keeps
 * today's cloud harness (`--model` added only when a Claude model is chosen;
 * unset ⇒ byte-for-byte the previous behaviour). `ollama` routes to the
 * harness-free DirectRunner against Ollama's native `/api/chat`.
 */
export function selectRunner(worktreePath: string): { runner: Runner; model?: ModelRef } {
  const def = getModelConfig().defaults.tour
  if (def?.provider === 'ollama') {
    return { runner: new DirectRunner(), model: def }
  }
  return { runner: new ClaudeCodeRunner({ cwd: worktreePath }), model: def }
}

// ── Tour generation ──────────────────────────────────────

export async function startTour(
  worktreePath: string,
  commitHash: string | null,
  webContents: WebContents,
  overrideOverview?: string
): Promise<void> {
  const key = tourKey(worktreePath, commitHash)

  // Cancel any in-progress tour for this target before starting fresh.
  cancelTour(worktreePath, commitHash)

  sendStatus(webContents, key, 'running')

  let ctx: TourContext
  try {
    ctx = await tourTask.buildContext({ worktreePath, commitHash, overrideOverview })
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
  activeTours.set(key, { abort: () => controller.abort() })

  let topicCounter = 0
  const accumulatedTour: Tour = { overview: '', topics: [] }

  try {
    for await (const item of runTask(
      tourTask,
      { worktreePath, commitHash, overrideOverview },
      { runner, model, signal: controller.signal, context: ctx }
    )) {
      if (item.kind === 'overview') {
        accumulatedTour.overview = item.overview
        sendOverview(webContents, key, item.overview)
      } else {
        const full: TourTopic = { ...item.topic, id: `${key}:${topicCounter++}` }
        accumulatedTour.topics.push(full)
        sendTopic(webContents, key, full)
      }
    }
    activeTours.delete(key)
    if (accumulatedTour.topics.length > 0) {
      saveTour(worktreePath, commitHash, accumulatedTour)
    }
    sendStatus(webContents, key, 'done')
  } catch (err: unknown) {
    activeTours.delete(key)
    // A user-initiated cancel aborts the runner, which surfaces as a throw here.
    // That's not a failure — report a neutral 'done' rather than 'error'.
    if (controller.signal.aborted) {
      sendStatus(webContents, key, 'done')
    } else {
      sendStatus(webContents, key, 'error', err instanceof Error ? err.message : String(err))
    }
  }
}

export function cancelTour(worktreePath: string, commitHash: string | null): void {
  const key = tourKey(worktreePath, commitHash)
  activeTours.get(key)?.abort()
  activeTours.delete(key)
}

export function cancelAllTours(): void {
  for (const { abort } of activeTours.values()) abort()
  activeTours.clear()
}
