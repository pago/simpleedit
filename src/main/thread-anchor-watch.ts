/**
 * Keeps working-copy threads on their code as files change: every file with
 * such a thread is watched (open in an editor or not), re-anchored once at
 * startup and after each change, and moves are persisted and broadcast. The
 * list and the follow-up headers (`formatThreadForAgent`) read the stored
 * anchor, so they follow.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { getThreadAnchor, listThreadAnchors, setThreadAnchor } from './agent-threads-store'
import { watchFileInMain } from './editor-watcher'
import { followsWorkingCopy, reanchor } from './thread-reanchor'
import type { ThreadAnchor, ThreadChange } from '../shared/agent-threads'

type Broadcast = (changes: ThreadChange[]) => void

let broadcast: Broadcast = () => {}
/** Thread id → the absolute file it follows. */
const fileOf = new Map<string, string>()
/** Absolute file → its unwatch. */
const watches = new Map<string, () => void>()
const running = new Map<string, Promise<void>>()
const rerun = new Set<string>()

function followedFile(worktreePath: string, anchor: ThreadAnchor): string | null {
  return followsWorkingCopy(anchor) ? join(worktreePath, anchor.path) : null
}

function track(threadId: string, file: string | null): void {
  const old = fileOf.get(threadId) ?? null
  if (old === file) return
  if (file) fileOf.set(threadId, file)
  else fileOf.delete(threadId)
  if (file && !watches.has(file)) watches.set(file, watchFileInMain(file, () => void reanchorFile(file)))
  if (old && ![...fileOf.values()].includes(old)) {
    watches.get(old)?.()
    watches.delete(old)
  }
}

async function readContent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
    throw err
  }
}

async function reanchorOnce(file: string): Promise<void> {
  let content: string | null
  try {
    content = await readContent(file)
  } catch (err) {
    console.warn(`[Threads] Could not read ${file} to re-anchor:`, err)
    return
  }
  // Synchronous from here: nothing can change the threads between reading an
  // anchor and storing its successor.
  const changes: ThreadChange[] = []
  for (const [threadId, f] of fileOf) {
    if (f !== file) continue
    const stored = getThreadAnchor(threadId)
    const next = stored ? reanchor(stored.anchor, content) : null
    if (!next) continue
    const change = setThreadAnchor(threadId, next)
    if (!change) continue
    console.log(
      next.orphaned
        ? `[Threads] Orphaned ${threadId}: its code in ${file} has moved or changed`
        : `[Threads] Re-anchored ${threadId} to ${file}:${next.startLine}-${next.endLine}`,
    )
    changes.push(change)
  }
  if (changes.length) broadcast(changes)
}

/**
 * Re-anchor every thread in `file`. One pass at a time per file: a change
 * during a pass runs one more, so an older read never lands last.
 */
export function reanchorFile(file: string): Promise<void> {
  const inFlight = running.get(file)
  if (inFlight) {
    rerun.add(file)
    return inFlight
  }
  const run = (async () => {
    do {
      rerun.delete(file)
      try {
        await reanchorOnce(file)
      } catch (err) {
        console.error(`[Threads] Re-anchoring ${file} failed:`, err)
      }
    } while (rerun.has(file))
  })().finally(() => running.delete(file))
  running.set(file, run)
  return run
}

/** Every change main broadcasts passes through here, so a new, moved or removed thread is (un)watched. */
export function noteAnchorChanges(changes: readonly ThreadChange[]): void {
  for (const c of changes) track(c.threadId, c.thread ? followedFile(c.thread.worktreePath, c.thread.anchor) : null)
}

/** Watch every followed file and re-anchor each once, for edits made while the app was closed. */
export async function startThreadAnchorWatch(deps: { broadcast: Broadcast }): Promise<void> {
  broadcast = deps.broadcast
  for (const t of listThreadAnchors()) track(t.threadId, followedFile(t.worktreePath, t.anchor))
  await Promise.all([...watches.keys()].map(reanchorFile))
}

export function stopThreadAnchorWatch(): void {
  for (const unwatch of watches.values()) unwatch()
  watches.clear()
  fileOf.clear()
  rerun.clear()
}
