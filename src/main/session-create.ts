/**
 * Starting a session on behalf of a client that has none of its own.
 *
 * The phone can reach every IPC channel, but not the renderer's session store:
 * labels, the project root, the model defaults and the terminal id all live
 * there. So this asks the window's own renderer to do the creating and waits
 * for its answer, the same shape `spawn_session` already uses for the MCP
 * tool — a correlation id, because the id can only come back from the side
 * that mints it.
 *
 * ── The invariant this module exists for ────────────────────────────────
 * **A session is created exactly once per confirmed intent.** Three things
 * turn one confirmation into two spawns and none of them are visible from the
 * client: a double tap, a socket that drops after the request was handled but
 * before its answer arrived, and a frame replayed by a transport that
 * reconnected. Only main sees all three, so the de-duplication lives here and
 * is keyed by the client's `requestId` — which names the INTENT, not the call.
 *
 * The cache therefore has to answer for an attempt whose outcome nobody
 * witnessed, which is why a `retryable` failure (nothing was sent, so nothing
 * can have started) is forgotten while an unwitnessed one is remembered: a
 * retry of the latter must return the same uncertainty rather than spawn again.
 */
import { randomUUID } from 'crypto'
import { labelFromBrief } from '../shared/brief'
import { SESSION_CREATE_UNWITNESSED } from '../shared/ipc-types'
import type {
  SessionCreateOutcome,
  SessionCreateRequest,
  SessionCreateResult,
} from '../shared/ipc-types'

/** The one thing this module needs of a renderer: a way to talk to it. */
export interface SessionCreateTarget {
  send(channel: string, data: unknown): void
  isDestroyed(): boolean
}

/**
 * How long the renderer gets to answer.
 *
 * Generous: the renderer reads `models:config-get` before it can pick a
 * provider, and a busy window can be slow. Past it the request is not failed
 * so much as left uncertain — a session may well exist.
 */
export const CREATE_ANSWER_TIMEOUT_MS = 15_000

/**
 * A brief is arbitrary text from a socket, so it is bounded here rather than
 * in the composer that produced it. Far above anything dictated; low enough
 * that nothing pathological reaches a PTY.
 */
const BRIEF_MAX = 8_000

/** How many intents are remembered, and for how long. */
const REMEMBERED_MAX = 64
const REMEMBERED_TTL_MS = 30 * 60_000

type Attempt =
  | ({ ok: true } & SessionCreateResult)
  /** `retryable` = definitely nothing started, so the intent may be re-made. */
  | { ok: false; retryable: boolean; reason: string }

interface Remembered {
  at: number
  attempt: Promise<Attempt>
}

const byRequestId = new Map<string, Remembered>()
const waiters = new Map<string, (outcome: SessionCreateOutcome) => void>()

/** Test seam: forget every remembered intent and pending answer. */
export function resetSessionCreate(): void {
  byRequestId.clear()
  waiters.clear()
}

/**
 * The renderer's answer to a request. Late answers are dropped — the waiter
 * has already given up and its caller has been told the outcome is unknown.
 */
export function resolveSessionCreate(
  correlationId: string,
  outcome: SessionCreateOutcome,
): void {
  const waiter = waiters.get(correlationId)
  if (!waiter) return
  waiters.delete(correlationId)
  waiter(outcome)
}

/** Drop remembered intents that have aged out, then the oldest over the cap. */
function prune(now: number): void {
  for (const [key, entry] of byRequestId) {
    if (now - entry.at > REMEMBERED_TTL_MS) byRequestId.delete(key)
  }
  while (byRequestId.size > REMEMBERED_MAX) {
    const oldest = byRequestId.keys().next()
    if (oldest.done) break
    byRequestId.delete(oldest.value)
  }
}

/**
 * Start a session for `request`, or hand back what the same intent already
 * produced.
 *
 * Rejects with the reason on failure, so a client sees why rather than an
 * empty success.
 */
export async function createSessionOnce(
  request: SessionCreateRequest,
  renderer: SessionCreateTarget,
): Promise<SessionCreateResult> {
  const requestId = typeof request?.requestId === 'string' ? request.requestId.trim() : ''
  if (!requestId) throw new Error('session:create requires a requestId')

  const now = Date.now()
  prune(now)

  const seen = byRequestId.get(requestId)
  // The intent is registered BEFORE the first await, so a second call that
  // arrives while the first is still in flight joins it instead of racing it.
  // An unexpected throw (a renderer destroyed between the check and the send)
  // is a failure that started nothing — and it must not be cached as a
  // permanently rejected promise, which would make the intent unretryable.
  const attempt =
    seen?.attempt ??
    run(request, renderer).catch(
      (err: unknown): Attempt => ({
        ok: false,
        retryable: true,
        reason: err instanceof Error ? err.message : String(err),
      }),
    )
  if (!seen) byRequestId.set(requestId, { at: now, attempt })

  const outcome = await attempt
  if (outcome.ok) return { terminalId: outcome.terminalId, label: outcome.label }
  // Nothing was started, so the user may try the same intent again. An
  // outcome nobody witnessed stays remembered: repeating it is the honest
  // answer, and spawning a second agent is not.
  if (outcome.retryable) byRequestId.delete(requestId)
  throw new Error(outcome.reason)
}

async function run(
  request: SessionCreateRequest,
  renderer: SessionCreateTarget,
): Promise<Attempt> {
  const brief = typeof request?.brief === 'string' ? request.brief.trim() : ''
  if (!brief) {
    return { ok: false, retryable: true, reason: 'A session needs a brief to start from.' }
  }
  if (brief.length > BRIEF_MAX) {
    return {
      ok: false,
      retryable: true,
      reason: `That brief is ${brief.length} characters; the limit is ${BRIEF_MAX}.`,
    }
  }
  if (renderer.isDestroyed()) {
    return { ok: false, retryable: true, reason: 'That SimpleEdit window is gone.' }
  }

  const correlationId = randomUUID()
  const answer = new Promise<SessionCreateOutcome | null>((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(correlationId)
      resolve(null)
    }, CREATE_ANSWER_TIMEOUT_MS)
    waiters.set(correlationId, (outcome) => {
      clearTimeout(timer)
      resolve(outcome)
    })
  })

  const label = labelFromBrief(brief)
  renderer.send('session:create-request', {
    correlationId,
    brief,
    ...(label ? { label } : {}),
  })

  const outcome = await answer
  if (!outcome) {
    return {
      ok: false,
      // The request was delivered. A session may exist, so this must not be
      // retried into a second one.
      retryable: false,
      reason: SESSION_CREATE_UNWITNESSED,
    }
  }
  if (!outcome.ok) return { ok: false, retryable: true, reason: outcome.reason }
  return { ok: true, terminalId: outcome.terminalId, label: outcome.label }
}
