/**
 * What the phone's Review Room keeps beside the shared stores
 * (`reviewRoom.svelte.ts`, `screenprs.svelte.ts`, reused verbatim):
 *
 *  1. **The companion's status.** The desktop reads it from its own
 *     `agent:status` store, but that event reaches only the hosting window's
 *     clients. Main relays a companion's status to every client
 *     (`review:companion-status`), and `review:companion-info` carries the
 *     last one for a screen that just opened.
 *  2. **Submissions.** One per review at a time, and its answer comes back
 *     over this socket, so a project switch waits for it (`PocketApp`).
 *  3. **An unknown outcome latches.** A submit whose answer never came back
 *     (the socket dropped after sending) may still be posting: main carries
 *     on without us. A second tap would race it, so Submit stays off until
 *     the user says they checked. Main resumes a timed-out layer by its
 *     marker, so a layer that answered `unknown` is not latched: its Retry is
 *     what resumes it.
 *
 * A reconnect keeps them. The latch also survives a reload of this tab
 * (sessionStorage): the version check reloads right after a reconnect, which
 * is exactly when an answer goes missing.
 */
import type { AgentStatus } from '../../shared/ipc-types'
import type { Review } from '../../shared/review-room'
import type { ReviewCompanionInfo } from '../../shared/review-room-ipc'

let infos = $state<Map<string, ReviewCompanionInfo | null>>(new Map())
let statuses = $state<Map<string, AgentStatus>>(new Map())

function setIn<K, V>(map: Map<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(map)
  next.set(key, value)
  return next
}

export const companionState = {
  /** Main's last answer for the review's companion; `null`: none claimed; undefined: not asked yet. */
  info(reviewId: string): ReviewCompanionInfo | null | undefined {
    return infos.get(reviewId)
  },
  /** The companion's last reported status, by terminal id. */
  status(sessionId: string): AgentStatus | undefined {
    return statuses.get(sessionId)
  },
  async load(reviewId: string): Promise<void> {
    try {
      const info = await window.api.invoke('review:companion-info', reviewId)
      infos = setIn(infos, reviewId, info)
      if (info?.status) statuses = setIn(statuses, info.sessionId, info.status)
    } catch (err) {
      console.warn('[review] loading the companion failed:', err)
    }
  },
  /** Tests only. */
  _reset(): void {
    infos = new Map()
    statuses = new Map()
  },
}

/** Subscribe to the relayed companion status. Call once at app start; returns an unsub. */
export function initCompanionStatusListener(): () => void {
  return window.api.on('review:companion-status', ({ sessionId, status }) => {
    statuses = setIn(statuses, sessionId, status)
  })
}

export interface CompanionLine {
  text: string
  tone: 'muted' | 'ok' | 'busy' | 'needs-you' | 'error'
  /** Offer to replace a companion that isn't running, in the window this phone is joined to. */
  canStart: boolean
}

/**
 * The companion bar, without the terminal: what the companion is doing, and
 * "needs you" sends the user to the Mac, since a dialog in its terminal can
 * only be answered there.
 */
export function companionLine(
  review: Pick<Review, 'companion' | 'status'>,
  info: ReviewCompanionInfo | null | undefined,
  status: AgentStatus | undefined,
): CompanionLine {
  if (review.status !== 'open') return { text: 'This review is closed; its companion has ended.', tone: 'muted', canStart: false }
  const companion = review.companion
  if (!companion) {
    return { text: 'No companion yet: it starts on your first question, on the Mac.', tone: 'muted', canStart: false }
  }
  // Main's answer is for an earlier claim: wait for the one about this one.
  if (!info || info.sessionId !== companion.sessionId) return { text: 'Companion…', tone: 'muted', canStart: false }
  if (!info.live) {
    return { text: 'The companion isn’t running. Resume it on the Mac, or start a new one that reads the threads back.', tone: 'error', canStart: true }
  }
  switch (status) {
    case 'waiting':
      return { text: 'The companion needs you: answer on the Mac.', tone: 'needs-you', canStart: false }
    case 'running':
      return { text: 'The companion is working…', tone: 'busy', canStart: false }
    case 'initializing':
      return { text: 'The companion is starting…', tone: 'busy', canStart: false }
    case 'error':
    case 'exited':
      return { text: 'The companion stopped.', tone: 'error', canStart: true }
    default:
      return { text: 'The companion is ready.', tone: 'ok', canStart: false }
  }
}

const LATCH_KEY = 'simpleedit.reviewSubmitLatch'

function loadLatched(): Set<string> {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(LATCH_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveLatched(ids: Set<string>): void {
  try {
    if (ids.size) sessionStorage.setItem(LATCH_KEY, JSON.stringify([...ids]))
    else sessionStorage.removeItem(LATCH_KEY)
  } catch {
    // Storage blocked: the latch still holds for this page.
  }
}

let submitting = $state<Set<string>>(new Set())
let unknown = $state<Set<string>>(loadLatched())

function withOut(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  next.delete(id)
  return next
}

export const reviewSubmits = {
  /** A submit of this review is waiting for its answer. */
  inFlight: (reviewId: string): boolean => submitting.has(reviewId),
  any: (): boolean => submitting.size > 0,
  begin(reviewId: string): void {
    submitting = new Set(submitting).add(reviewId)
  },
  end(reviewId: string): void {
    submitting = withOut(submitting, reviewId)
  },
  /** The last submit of this review was sent and never answered. */
  latched: (reviewId: string): boolean => unknown.has(reviewId),
  latch(reviewId: string): void {
    unknown = new Set(unknown).add(reviewId)
    saveLatched(unknown)
  },
  /** "I checked": or a submit that did come back. */
  unlatch(reviewId: string): void {
    if (!unknown.has(reviewId)) return
    unknown = withOut(unknown, reviewId)
    saveLatched(unknown)
  },
  /** Tests only. */
  _reset(): void {
    submitting = new Set()
    unknown = new Set()
    saveLatched(unknown)
  },
}
