/**
 * Starting a backlog item: one session from its prompt and settings, after
 * which the item leaves the backlog.
 *
 * The session itself is made by `createSessionOnce`, which de-duplicates by
 * `requestId`. That alone is not enough here: once a start succeeds the item
 * is gone, so a replayed Start (a phone that reconnected) could no longer even
 * rebuild the request. So this module answers a known `requestId` before it
 * looks the item up, and locks the item while a start is in flight so the
 * desktop and the phone tapping Start at once make one session, not two.
 */
import {
  getBacklogItem,
  isStarting,
  recordStartIssue,
  removeStartedItem,
  setStarting,
} from './backlog-store'
import { SESSION_CREATE_REUSED, SESSION_CREATE_UNWITNESSED } from '../shared/ipc-types'
import type { SessionCreateRequest, SessionCreateResult } from '../shared/ipc-types'

export interface StartDeps {
  createSession(request: SessionCreateRequest): Promise<SessionCreateResult>
  /** The project's backlog changed. */
  changed(): void
}

export interface StartRequest {
  id: string
  requestId: string
}

const REMEMBERED_MAX = 64
const REMEMBERED_TTL_MS = 30 * 60_000

interface Remembered {
  itemId: string
  at: number
  attempt: Promise<SessionCreateResult>
}

const byRequestId = new Map<string, Remembered>()

function prune(now: number): void {
  for (const [key, entry] of byRequestId) if (now - entry.at > REMEMBERED_TTL_MS) byRequestId.delete(key)
  while (byRequestId.size > REMEMBERED_MAX) {
    const oldest = byRequestId.keys().next()
    if (oldest.done) break
    byRequestId.delete(oldest.value)
  }
}

export function parseStartRequest(raw: unknown): StartRequest {
  if (typeof raw !== 'object' || raw === null) throw new Error('Malformed backlog start')
  const { id, requestId } = raw as Record<string, unknown>
  if (typeof id !== 'string' || !id || typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) {
    throw new Error('Malformed backlog start')
  }
  return { id, requestId: requestId.trim() }
}

export async function startBacklogItem(project: string, request: StartRequest, deps: StartDeps, now = Date.now()): Promise<SessionCreateResult> {
  prune(now)
  const key = `${project}\n${request.requestId}`
  const seen = byRequestId.get(key)
  if (seen) {
    if (seen.itemId !== request.id) throw new Error(SESSION_CREATE_REUSED)
    return seen.attempt
  }

  const item = getBacklogItem(project, request.id)
  if (!item) throw new Error('That backlog item is gone. It may have been started or removed already.')
  if (isStarting(item.id)) throw new Error('That backlog item is already being started.')
  // Refused like a stale edit, not recorded as a failed start: nothing was attempted.
  if (!item.prompt.trim()) throw new Error('Write a prompt before starting this item.')

  setStarting(item.id, true)
  deps.changed()
  const attempt = deps.createSession({
    // Its own namespace: the phone's `session:create` mints ids from the same cache.
    requestId: `backlog:${request.requestId}`,
    brief: item.prompt,
    ...(item.label ? { label: item.label } : {}),
    ...(item.target ? { target: item.target } : {}),
  })
  byRequestId.set(key, { itemId: item.id, at: now, attempt })

  let result: SessionCreateResult
  try {
    result = await attempt
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const unconfirmed = reason === SESSION_CREATE_UNWITNESSED
    recordStartIssue(project, item.id, { outcome: unconfirmed ? 'unconfirmed' : 'failed', reason, at: new Date(now).toISOString() })
    // An unconfirmed start stays remembered, so a replay repeats the
    // uncertainty instead of starting a second session. A new Start from the
    // user is a new requestId and may go ahead.
    if (!unconfirmed) byRequestId.delete(key)
    setStarting(item.id, false)
    deps.changed()
    throw err
  }
  try {
    removeStartedItem(project, item.id)
  } catch (err) {
    // The session exists. Keeping the item flagged, rather than plainly
    // failed, is what stops the user from starting it a second time unawares.
    console.error('[backlog] started, but removing the item failed:', err)
    try {
      recordStartIssue(project, item.id, { outcome: 'unconfirmed', reason: `Started as “${result.label}”, but it couldn't leave the backlog.`, at: new Date(now).toISOString() })
    } catch { /* the database is failing; the log above is all there is */ }
  }
  setStarting(item.id, false)
  deps.changed()
  return result
}

/** Test seam. */
export function _resetBacklogStartForTests(): void {
  byRequestId.clear()
}
