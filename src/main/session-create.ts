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
import { SESSION_BRIEF_MAX, labelFromBrief } from '../shared/brief'
import { SESSION_CREATE_REUSED, SESSION_CREATE_UNWITNESSED, isReasoningEffort } from '../shared/ipc-types'
import type {
  InteractiveTarget,
  ModelRef,
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
 * in the composer that produced it; low enough that nothing pathological
 * reaches a PTY.
 */
const BRIEF_MAX = SESSION_BRIEF_MAX
const LABEL_MAX = 120
/**
 * A model id becomes the value of a `--model` flag. Ids in the wild are
 * `claude-sonnet-4-6`, `qwen3:8b`, `hf.co/org/name:Q4_K_M` and
 * `opencode/deepseek-v4-flash-free`; a leading dash or whitespace is never one.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/

function modelId(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !MODEL_ID.test(value)) throw new Error(`${what} isn't a model id.`)
  return value
}

/**
 * The agent a remote client asked for, rebuilt from known fields only. Throws
 * the reason. A Claude model may be cloud or local Ollama, but never with an
 * endpoint: a phone has no way to pick one, so one arriving is not the user's.
 */
export function parseCreateTarget(raw: unknown): InteractiveTarget {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('The agent to start must be an object.')
  const { provider, model, reasoningEffort } = raw as Record<string, unknown>
  if (provider === 'claude') {
    if (model === undefined) return { provider: 'claude' }
    if (typeof model !== 'object' || model === null) throw new Error("That Claude model isn't a model.")
    const ref = model as Record<string, unknown>
    if (ref.provider !== 'anthropic' && ref.provider !== 'ollama') throw new Error("Claude can't run that model.")
    const id = modelId(ref.model, 'That Claude model')
    if (!id) throw new Error('That Claude model has no id.')
    const out: ModelRef = { provider: ref.provider, model: id }
    return { provider: 'claude', model: out }
  }
  if (provider === 'codex' || provider === 'opencode') {
    const id = modelId(model, `That ${provider} model`)
    if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) throw new Error("That reasoning effort isn't one SimpleEdit knows.")
    return {
      provider,
      ...(id ? { model: id } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    }
  }
  throw new Error("SimpleEdit can't start that agent.")
}

/** A session name from a remote client: one line, bounded. Throws the reason. */
export function parseCreateLabel(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new Error('A session name must be text.')
  // eslint-disable-next-line no-control-regex
  const label = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!label) return undefined
  if (label.length > LABEL_MAX) throw new Error(`That session name is ${label.length} characters; the limit is ${LABEL_MAX}.`)
  return label
}

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
  /** What the intent asked for, so a reused id carrying a different request is refused, not answered. */
  fingerprint: string
}

/**
 * The models a remote client may start, as main lists them: the same Claude
 * catalog, Codex catalog and installed tool-capable Ollama models the phone's
 * picker is built from. A shape check alone would accept a model that is not
 * there, and the session would die at launch where the phone can't see why.
 */
export interface ModelCatalog {
  claude(): Promise<string[]>
  codex(): Promise<string[]>
  ollama(): Promise<string[]>
}

/** Why `target` can't be started from a remote client, or null when it can. */
export async function unknownModelReason(target: InteractiveTarget, catalog: ModelCatalog): Promise<string | null> {
  if (target.provider === 'claude') {
    if (!target.model) return null
    const { provider, model } = target.model
    const known = provider === 'ollama' ? await catalog.ollama() : await catalog.claude()
    if (!model || known.includes(model)) return null
    return provider === 'ollama'
      ? `“${model}” isn't an installed local model that can drive an agent.`
      : `Claude Code doesn't offer the model “${model}”.`
  }
  if (target.provider === 'codex') {
    if (!target.model || (await catalog.codex()).includes(target.model)) return null
    return `Codex doesn't offer the model “${target.model}”.`
  }
  return `${target.provider} sessions can't be started from the phone; pick a model from the list.`
}

/** Canonical JSON: the same request from any client gives the same string, whatever its key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function fingerprintOf(request: SessionCreateRequest): string {
  const brief = typeof request.brief === 'string' ? request.brief.trim() : request.brief
  return canonical({ brief, target: request.target, label: request.label })
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
  catalog?: ModelCatalog,
): Promise<SessionCreateResult> {
  const requestId = typeof request?.requestId === 'string' ? request.requestId.trim() : ''
  if (!requestId) throw new Error('session:create requires a requestId')

  const now = Date.now()
  prune(now)

  const fingerprint = fingerprintOf(request)
  const seen = byRequestId.get(requestId)
  if (seen && seen.fingerprint !== fingerprint) {
    // Answering would hand back a session the caller didn't ask for; starting
    // one would break the one-intent-one-session rule. A client reusing an id
    // for a new request is a bug, so it is told so.
    throw new Error(SESSION_CREATE_REUSED)
  }
  // The intent is registered BEFORE the first await, so a second call that
  // arrives while the first is still in flight joins it instead of racing it.
  // An unexpected throw (a renderer destroyed between the check and the send)
  // is a failure that started nothing — and it must not be cached as a
  // permanently rejected promise, which would make the intent unretryable.
  const attempt =
    seen?.attempt ??
    run(request, renderer, catalog).catch(
      (err: unknown): Attempt => ({
        ok: false,
        retryable: true,
        reason: err instanceof Error ? err.message : String(err),
      }),
    )
  if (!seen) byRequestId.set(requestId, { at: now, attempt, fingerprint })

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
  catalog: ModelCatalog | undefined,
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
  let target: InteractiveTarget | undefined
  let fixedLabel: string | undefined
  try {
    target = request.target === undefined ? undefined : parseCreateTarget(request.target)
    fixedLabel = parseCreateLabel(request.label)
  } catch (err) {
    return { ok: false, retryable: true, reason: err instanceof Error ? err.message : String(err) }
  }
  if (target && catalog) {
    const reason = await unknownModelReason(target, catalog)
    if (reason) return { ok: false, retryable: true, reason }
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

  const label = fixedLabel ?? labelFromBrief(brief)
  renderer.send('session:create-request', {
    correlationId,
    brief,
    ...(label ? { label } : {}),
    ...(fixedLabel ? { labelFixed: true } : {}),
    ...(target ? { target } : {}),
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
