/**
 * The Review Room companion's lifecycle, main side: claim, create, end,
 * rebind on resume, and the launch options its terminal id gets.
 *
 * A companion is an owned session in one window's renderer, but whether a
 * terminal id IS a companion is main's call, from the review store: the
 * read-only launch flags are derived here for the reserved id and never taken
 * from a spawn payload, which the phone can send too.
 */
import { randomUUID } from 'crypto'
import type { AgentStatus, AgentStatusEvent, InteractiveTarget, ModelConfig } from '../shared/ipc-types'
import type { ReviewAgent, Review, ReviewChange } from '../shared/review-room'
import type { ReviewCompanionCreateOutcome, ReviewCompanionCreateRequest, ReviewCompanionInfo, ReviewCompanionStatus } from '../shared/review-room-ipc'
import { buildCompanionBrief } from '../shared/pr-brief'
import { parseSessionOwner } from '../shared/session-owner'
import { parseCreateTarget, unknownModelReason, type ModelCatalog } from './session-create'
import { registeredProviderIds, tryGetProvider, type ReviewCompanionLaunch } from './agents/provider'
import {
  claimCompanion,
  clearCompanion,
  getReview,
  openReviewActivity,
  rebindCompanion,
  reviewsWithCompanion,
  reviewsWithCompanionSession,
  setCompanionAgent,
} from './review-room-store'
import { ensureReviewCheckoutDir, setProtectedReviews, sweepReviewCheckouts } from './review-checkout'
import { fetchReviewRubric, renderRubricBlock } from './github/review-rubric'

export interface ReviewCompanionDeps {
  /** Send to that window's own renderer. False when the window is gone. */
  sendCreateRequest(windowId: number, request: ReviewCompanionCreateRequest): boolean
  broadcast(changes: ReviewChange[]): void
  /** The delivery core: send what is held for this session once it can take it. */
  requestSend(sessionId: string): void
  isLive(sessionId: string): boolean
  kill(sessionId: string): void
  modelConfig(): ModelConfig | null
  /** The repo's rubric block for the brief; default fetches the top layer's REVIEW.md. */
  rubric?(review: Review): Promise<string | undefined>
}

let deps: ReviewCompanionDeps | null = null
let quitting = false

export function initReviewCompanion(d: ReviewCompanionDeps): void {
  deps = d
  // A live companion may be reading its checkout: the repo cache keeps it.
  setProtectedReviews(() =>
    new Set(reviewsWithCompanion().filter((r) => r.status === 'open' && r.companion && isLiveOrResuming(r.companion.sessionId)).map((r) => r.id)),
  )
}

function need(): ReviewCompanionDeps {
  if (!deps) throw new Error('The Review Room companion is unavailable in this SimpleEdit session.')
  return deps
}

/** Quit is not a session end: the claim survives it, for Resume after restart. */
export function markCompanionQuitting(): void {
  quitting = true
}

/**
 * Whether a PTY exit should settle that session's deliveries. Not while
 * quitting: a question held for a companion must survive the restart, and
 * what was in flight is settled at the next start.
 */
export function exitSettlesDelivery(): boolean {
  return !quitting
}

/** Test seam. */
export function resetReviewCompanion(): void {
  deps = null
  quitting = false
  inFlight.clear()
  waiters.clear()
  resuming.clear()
  statuses.clear()
}

// -- agent <-> stored companion agent --------------------------------------

const DEFAULT_MODEL = 'default'

/**
 * `ReviewAgent` stores provider + model as two strings. Claude's model is
 * `<anthropic|ollama>:<id>`; a native one is `<id>[#<effort>]`; `default`
 * means the provider's own default. `#` is never part of a model id.
 */
export function reviewAgentFromTarget(target: InteractiveTarget): ReviewAgent {
  if (target.provider === 'claude') {
    return { provider: 'claude', model: target.model ? `${target.model.provider}:${target.model.model}` : DEFAULT_MODEL }
  }
  return {
    provider: target.provider,
    model: `${target.model ?? DEFAULT_MODEL}${target.reasoningEffort ? `#${target.reasoningEffort}` : ''}`,
  }
}

/** The stored agent as a launch target, validated like any client's. Throws the reason. */
export function targetFromReviewAgent(agent: ReviewAgent): InteractiveTarget {
  if (agent.provider === 'claude') {
    if (agent.model === DEFAULT_MODEL) return { provider: 'claude' }
    const colon = agent.model.indexOf(':')
    return parseCreateTarget({
      provider: 'claude',
      model: { provider: agent.model.slice(0, colon), model: agent.model.slice(colon + 1) },
    })
  }
  const [model, reasoningEffort] = agent.model.split('#')
  return parseCreateTarget({
    provider: agent.provider,
    ...(model && model !== DEFAULT_MODEL ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  })
}

/**
 * What a new review's companion starts as: Settings' choice, else what a
 * plain new session would start (the last-used agent), else Claude.
 */
export function defaultCompanionAgent(config: ModelConfig | null = deps?.modelConfig() ?? null): ReviewAgent {
  return reviewAgentFromTarget(defaultCompanionTarget(config))
}

function defaultCompanionTarget(config: ModelConfig | null): InteractiveTarget {
  try {
    if (config?.reviewCompanion) return parseCreateTarget(config.reviewCompanion)
    const last = config?.lastUsed
    if (!last) return { provider: 'claude' }
    if (last.provider === 'anthropic' || last.provider === 'ollama') {
      return parseCreateTarget({ provider: 'claude', model: { provider: last.provider, model: last.model } })
    }
    const provider = registeredProviderIds().find((id) => tryGetProvider(id)?.capabilities.nativeModelBrand === last.provider)
    if (!provider) return { provider: 'claude' }
    return parseCreateTarget({
      provider,
      ...(last.model ? { model: last.model } : {}),
      ...(last.reasoningEffort ? { reasoningEffort: last.reasoningEffort } : {}),
    })
  } catch {
    return { provider: 'claude' }
  }
}

export function companionReadOnly(provider: string): ReviewCompanionInfo['readOnly'] {
  return tryGetProvider(provider)?.reviewCompanionReadOnly ?? 'by-instruction'
}

// -- launch -------------------------------------------------------------------

/**
 * The companion launch options for `terminalId`, when it is the claimed
 * companion of an open review. Creates the review's checkout dir: the agent
 * is granted read access to it at launch.
 */
export function companionLaunchFor(terminalId: string): ReviewCompanionLaunch | undefined {
  const review = reviewsWithCompanionSession(terminalId).find((candidate) => candidate.status === 'open')
  if (!review) return undefined
  return { reviewId: review.id, extraReadDir: ensureReviewCheckoutDir(review.id) }
}

/**
 * The launch an `agent:spawn` for `terminalId` gets, or a refusal. A claimed
 * id launches only as its review's companion. The payload's `owner` can only
 * add a restriction: an owned spawn with no open claim behind it (the claim
 * ended, timed out or moved meanwhile) is refused rather than started writable.
 */
export function companionSpawnFor(terminalId: string, owner: unknown): ReviewCompanionLaunch | undefined {
  const launch = companionLaunchFor(terminalId)
  if (launch) {
    if (owner !== undefined && parseSessionOwner(owner)?.reviewId !== launch.reviewId) throw new Error('That session belongs to another review')
    return launch
  }
  assertUnclaimed(terminalId)
  if (owner !== undefined) throw new Error("This review companion's claim has ended; start a new one from the review")
  return undefined
}

/** Any other spawn path (plain terminal, Agent View) may not take an id a companion claim names. */
export function assertUnclaimed(terminalId: unknown): void {
  if (typeof terminalId === 'string' && reviewsWithCompanionSession(terminalId).length) {
    throw new Error('That terminal id belongs to a review companion')
  }
}

// -- create ---------------------------------------------------------------------

/** How long the claiming window gets to create the session, as `session:create`. */
export const COMPANION_CREATE_TIMEOUT_MS = 15_000
const RUBRIC_TIMEOUT_MS = 10_000

const inFlight = new Map<string, Promise<string>>()
/**
 * Ids a resume just rebound a claim to, until their spawn is live. Between the
 * rebind and the spawn there is no PTY, and an Ask in that gap must not take
 * the claim as stale and replace it.
 */
const resuming = new Map<string, number>()
export const RESUME_GRACE_MS = 30_000

function isLiveOrResuming(sessionId: string): boolean {
  if (need().isLive(sessionId)) {
    resuming.delete(sessionId)
    return true
  }
  const until = resuming.get(sessionId)
  if (until === undefined) return false
  if (Date.now() < until) return true
  resuming.delete(sessionId)
  return false
}
const waiters = new Map<string, (outcome: ReviewCompanionCreateOutcome) => void>()

function parseOutcome(raw: unknown): ReviewCompanionCreateOutcome {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const { ok, reason } = raw as Record<string, unknown>
    if (ok === true) return { ok: true }
    if (ok === false) return { ok: false, reason: typeof reason === 'string' ? reason.slice(0, 500) : 'The window could not start the companion' }
  }
  return { ok: false, reason: 'The window sent an unreadable answer' }
}

/** Who called: a real window has no `clientKey`, every remote transport does. */
export interface CompanionCaller {
  id: number
  clientKey?: string
}

function refuseRemote(caller: CompanionCaller, channel: string): void {
  if (caller.clientKey !== undefined) throw new Error(`${channel} is not available to remote clients`)
}

/** The claiming renderer's answer. A late or unknown one is dropped. Desktop only. */
export function resolveCompanionCreated(caller: CompanionCaller, correlationId: unknown, outcome: unknown): void {
  refuseRemote(caller, 'review:companion-created')
  if (typeof correlationId !== 'string') return
  const waiter = waiters.get(correlationId)
  if (!waiter) return
  waiters.delete(correlationId)
  waiter(parseOutcome(outcome))
}

function askWindow(windowId: number, request: ReviewCompanionCreateRequest): Promise<ReviewCompanionCreateOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(request.correlationId)
      resolve({ ok: false, reason: 'The window did not start the companion in time' })
    }, COMPANION_CREATE_TIMEOUT_MS)
    waiters.set(request.correlationId, (outcome) => {
      clearTimeout(timer)
      resolve(outcome)
    })
    if (!need().sendCreateRequest(windowId, request)) {
      clearTimeout(timer)
      waiters.delete(request.correlationId)
      resolve({ ok: false, reason: 'That SimpleEdit window is gone' })
    }
  })
}

async function defaultRubric(review: Review): Promise<string | undefined> {
  const top = review.layers.at(-1)
  if (!top) return undefined
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), RUBRIC_TIMEOUT_MS).unref?.())
  const rubric = await Promise.race([fetchReviewRubric(top.url, top.headSha, []), timeout])
  return renderRubricBlock(rubric) || undefined
}

function companionLabel(review: Review): string {
  const repo = review.repo.replace(/^github\.com\//, '')
  const numbers = review.layers.map((layer) => `#${layer.number}`)
  return `Review companion · ${repo}${numbers.length > 3 ? `${numbers[0]}–${numbers.at(-1)}` : numbers.join(' ')}`
}

function broadcastChange(change: ReviewChange | null): void {
  if (change) need().broadcast([change])
}

/**
 * The review's live companion, starting one in `windowId` when there is none
 * (a claim without a live PTY is stale and replaced). Concurrent calls share
 * one start, and only the claim's winner asks its window to create. Rejects
 * with the reason; a failed start leaves no claim behind.
 */
export function ensureCompanion(reviewId: string, windowId: number, requestId: string = randomUUID()): Promise<string> {
  const pending = inFlight.get(reviewId)
  if (pending) return pending
  need()
  const review = getReview(reviewId)
  if (!review || review.status !== 'open') return Promise.reject(new Error('That review is not open'))
  if (review.companion) {
    if (isLiveOrResuming(review.companion.sessionId)) return Promise.resolve(review.companion.sessionId)
    broadcastChange(clearCompanion(reviewId, review.companion.sessionId))
  }
  const run = startCompanion(reviewId, windowId, requestId).finally(() => inFlight.delete(reviewId))
  inFlight.set(reviewId, run)
  return run
}

async function startCompanion(reviewId: string, windowId: number, requestId: string): Promise<string> {
  const d = need()
  const before = getReview(reviewId)
  if (!before || before.status !== 'open') throw new Error('That review is not open')
  // Before claiming: the claim's create window must be the renderer's alone.
  const rubric = await (d.rubric ?? defaultRubric)(before).catch(() => undefined)
  const claim = claimCompanion(reviewId, windowId, requestId)
  broadcastChange(claim.change)
  if (!claim.companion) throw new Error('That review is not open')
  if (!claim.won || !claim.change) return claim.companion.sessionId
  const { sessionId, agent } = claim.companion
  const review = getReview(reviewId)
  try {
    if (!review) throw new Error('That review is gone')
    ensureReviewCheckoutDir(reviewId)
    const target = targetFromReviewAgent(agent)
    const brief = buildCompanionBrief({
      reviewId,
      layers: review.layers,
      ...(rubric ? { rubric } : {}),
      ...(review.focus ? { focus: review.focus } : {}),
      readOnlyEnforced: companionReadOnly(target.provider) === 'enforced',
    })
    const outcome = await askWindow(windowId, {
      correlationId: randomUUID(),
      reviewId,
      sessionId,
      target,
      brief,
      label: companionLabel(review),
    })
    if (!outcome.ok) throw new Error(outcome.reason)
  } catch (err) {
    console.warn(`[ReviewRoom] Companion ${sessionId} for ${reviewId} did not start:`, err)
    // The renderer spawns before it answers, so a refusal or a timeout can
    // follow a launch. Killed first: once unclaimed, the bridge no longer
    // treats the id as read-only.
    if (d.isLive(sessionId)) d.kill(sessionId)
    broadcastChange(clearCompanion(reviewId, sessionId))
    throw err
  }
  console.log(`[ReviewRoom] Companion ${sessionId} started for ${reviewId} in window ${windowId}`)
  // Questions asked before it existed are held; they go out once the brief's turn ends.
  d.requestSend(sessionId)
  return sessionId
}

// -- end, rebind, switch ------------------------------------------------------------

function endClaim(review: Review): void {
  const companion = review.companion
  if (!companion) return
  if (need().isLive(companion.sessionId)) need().kill(companion.sessionId)
  broadcastChange(clearCompanion(review.id, companion.sessionId))
}

/** Submit or discard: the review's companion, live or not, ends now. */
export function endReviewCompanion(reviewId: string): void {
  const review = getReview(reviewId)
  if (review) endClaim(review)
}

// -- status ---------------------------------------------------------------------

/** Each companion's last reported status, by terminal id. */
const statuses = new Map<string, AgentStatus>()

/**
 * An `agent:status` report. A companion's goes to every client as
 * `review:companion-status` (returned here for the caller to broadcast), since
 * the event itself reaches only the hosting window and its phones. Null when
 * it isn't a companion or nothing changed.
 */
export function noteCompanionStatus(event: AgentStatusEvent): ReviewCompanionStatus | null {
  if (statuses.get(event.terminalId) === event.status) return null
  const review = reviewsWithCompanionSession(event.terminalId)[0]
  if (!review) return null
  statuses.set(event.terminalId, event.status)
  return { reviewId: review.id, sessionId: event.terminalId, status: event.status }
}

/** A PTY exited (exit, kill). Its claims end, unless the app is quitting. */
export function onCompanionExited(sessionId: string): void {
  statuses.delete(sessionId)
  if (quitting || !deps) return
  for (const review of reviewsWithCompanionSession(sessionId)) {
    console.log(`[ReviewRoom] Companion ${sessionId} of ${review.id} ended`)
    broadcastChange(clearCompanion(review.id, sessionId))
  }
}

/** A window closed while the app runs: the companions it hosted end with it. */
export function endCompanionsOfWindow(windowId: number): void {
  if (quitting || !deps) return
  for (const review of reviewsWithCompanion()) {
    if (review.companion?.windowId === windowId) endClaim(review)
  }
}

/**
 * Resume of a restored companion placeholder: the claim moves to the new
 * terminal id and the resuming window. Compare-and-set on the old id; false
 * means the placeholder is no longer this review's companion.
 */
export function rebindCompanionSession(caller: CompanionCaller, reviewId: unknown, fromSessionId: unknown, toSessionId: unknown): boolean {
  refuseRemote(caller, 'review:companion-rebind')
  const windowId = caller.id
  if (typeof reviewId !== 'string' || typeof fromSessionId !== 'string' || typeof toSessionId !== 'string') return false
  // A live from-id is a running companion, not a placeholder being resumed.
  if (need().isLive(toSessionId) || need().isLive(fromSessionId)) return false
  let change: ReviewChange | null
  try {
    change = rebindCompanion(reviewId, fromSessionId, toSessionId, windowId)
  } catch {
    return false
  }
  broadcastChange(change)
  if (change) resuming.set(toSessionId, Date.now() + RESUME_GRACE_MS)
  if (change) console.log(`[ReviewRoom] Companion of ${reviewId} rebound ${fromSessionId} → ${toSessionId} in window ${windowId}`)
  return change !== null
}

/** Settings → which agent the companion is. A running one ends; the next Ask starts the new agent. */
export async function setReviewCompanionAgent(reviewId: unknown, rawTarget: unknown, catalog?: ModelCatalog): Promise<void> {
  if (typeof reviewId !== 'string') throw new Error('Malformed review id')
  // null is the picker's "Default": what Settings (or a plain new session) would start.
  const target = rawTarget === null ? null : parseCreateTarget(rawTarget)
  // Refused here, where the client sees why, not at launch inside a hidden session.
  const unknownModel = target && catalog ? await unknownModelReason(target, catalog) : null
  if (unknownModel) throw new Error(unknownModel)
  const agent = target ? reviewAgentFromTarget(target) : defaultCompanionAgent()
  const review = getReview(reviewId)
  if (!review) throw new Error('That review is gone')
  const change = setCompanionAgent(reviewId, agent)
  if (!change) return
  broadcastChange(change)
  const current = getReview(reviewId)
  if (current) endClaim(current)
}

export function companionInfo(reviewId: unknown, askingWindowId: number): ReviewCompanionInfo | null {
  if (typeof reviewId !== 'string') return null
  const companion = getReview(reviewId)?.companion
  if (!companion) return null
  return {
    reviewId,
    sessionId: companion.sessionId,
    windowId: companion.windowId,
    hostedHere: companion.windowId === askingWindowId,
    live: need().isLive(companion.sessionId),
    readOnly: companionReadOnly(companion.agent.provider),
    ...(statuses.has(companion.sessionId) ? { status: statuses.get(companion.sessionId) } : {}),
  }
}

/** Startup: checkouts of reviews no longer open, or idle too long, go. */
export function sweepCompanionCheckouts(): Promise<void> {
  return sweepReviewCheckouts(openReviewActivity())
}
