/**
 * Sending thread messages to their agent session, and attaching its answers.
 *
 * Unlike agent mail (`agent-wake.ts`) a thread message is the user's own, sent
 * while they are present, so it is submitted like a typed prompt. It still
 * never races the agent's TUI. A session's held messages go out together, as
 * one submitted prompt, only when ALL of these hold:
 *
 *  - Its last turn ended (a `Stop`, or Claude's idle-prompt reminder) and
 *    nothing has happened since. A busy session is never written to, so a
 *    message is never queued mid-turn, steered into a running turn, or merged
 *    with the user's own prompt.
 *  - No dialog is up. Claude's `PermissionRequest` and `PreToolUse` on a
 *    dialog tool arrive before their dialog renders; a Codex or OpenCode
 *    `waiting` likewise. A dialog clears only when the engine moves past it
 *    (the tool's result, a `Stop`, a submitted prompt), never on a mere
 *    `running`: a parallel sub-agent can report running with the dialog up.
 *  - The user has nothing typed in the prompt. Any key that didn't go to a
 *    dialog counts, and stays counted until a prompt is submitted: a bracketed
 *    paste plus Enter would submit their draft merged with the comment. The
 *    user can vouch for an empty prompt (`forceSend`). OpenCode is exempt; its
 *    messages go over HTTP and never touch the TUI's input.
 *
 * Delivery is confirmed, not assumed: the `UserPromptSubmit` whose prompt
 * carries a thread's header marks its messages `delivered` and arms the turn.
 * A write that isn't confirmed in CONFIRM_MS is `failed`, with a retry. When an
 * armed turn ends, each thread the agent didn't answer with `reply_to_thread`
 * gets the turn's final text; a turn that ends any other way leaves them
 * `unanswered`. Arming on confirmation, not on write, is what keeps another
 * turn's answer out of the thread.
 */
import type { AgentStatus } from '../shared/ipc-types'
import { agentSubmitWrite } from '../shared/agent-submit'
import {
  DIALOG_TOOLS,
  formatThreadsPrompt,
  newMessageId,
  threadIdsInPrompt,
  type AgentThread,
  type HeldReason,
  type ThreadChange,
} from '../shared/agent-threads'
import {
  appendAgentMessage,
  getThread,
  messagesInState,
  sessionsWithMessagesIn,
  setDelivery,
  type DeliveryPatch,
} from './agent-threads-store'

export const SEND_SETTLE_MS = 750
export const CONFIRM_MS = 10_000

export interface DeliveryEvent {
  eventName: string | null
  prompt?: string | null
  toolName?: string | null
  toolUseId?: string | null
  notificationType?: string | null
  message?: string | null
}

interface Track {
  status?: AgentStatus
  /** The last turn ended and nothing has happened in the session since. */
  turnEnded: boolean
  /** A dialog is up; the tool call that raised it, when known. */
  dialog: { toolUseId: string | null } | null
  draft: boolean
  stopsInFlight: number
  /** Messages written and awaiting their `UserPromptSubmit`. */
  sending: Set<string>
  confirmTimer?: ReturnType<typeof setTimeout>
  settleTimer?: ReturnType<typeof setTimeout>
  /** Delivered this turn, by thread. */
  armed: Map<string, string[]>
  replied: Set<string>
}

export interface DeliveryDeps {
  /** The provider driving a session, or null when it isn't an agent session SimpleEdit knows. */
  provider: (sessionId: string) => string | null
  /** A PTY write. */
  write: (sessionId: string, data: string) => void
  /** A provider's own way in, when it has one (OpenCode's `prompt_async`). */
  push: (sessionId: string, text: string) => Promise<boolean> | null
  broadcast: (changes: ThreadChange[]) => void
}

const tracks = new Map<string, Track>()
/** Null until `initThreadDelivery`, or for good when the database didn't open: every signal is then ignored. */
let deps: DeliveryDeps | null = null

function track(id: string): Track {
  let t = tracks.get(id)
  if (!t) {
    t = { turnEnded: false, dialog: null, draft: false, stopsInFlight: 0, sending: new Set(), armed: new Map(), replied: new Set() }
    tracks.set(id, t)
  }
  return t
}

function emit(changes: ThreadChange[] | ThreadChange | null): void {
  if (!deps || !changes) return
  const list = Array.isArray(changes) ? changes : [changes]
  if (list.length) deps.broadcast(list)
}

function patch(ids: Iterable<string>, p: DeliveryPatch): void {
  emit(setDelivery(ids, p))
}

/**
 * Wire up delivery. Messages left `sending` or `delivered` by a previous run
 * can never be confirmed or answered now, so they are settled first.
 */
export function initThreadDelivery(d: DeliveryDeps): void {
  deps = d
  for (const sessionId of sessionsWithMessagesIn(['sending', 'delivered'])) {
    const stale = messagesInState(sessionId, ['sending', 'delivered'])
    patch(
      stale.filter((p) => p.message.delivery === 'sending').map((p) => p.message.id),
      { delivery: 'failed', failedReason: 'SimpleEdit restarted before the agent received it' },
    )
    patch(
      stale.filter((p) => p.message.delivery === 'delivered').map((p) => p.message.id),
      { delivery: 'unanswered', failedReason: 'SimpleEdit restarted before the agent answered' },
    )
  }
  for (const sessionId of sessionsWithMessagesIn(['held'])) refreshHeld(sessionId)
}

// -- Signals -------------------------------------------------------------

export function noteThreadStatus(sessionId: string, status: AgentStatus): void {
  if (!deps) return
  if (status === 'exited') {
    sessionGone(sessionId)
    return
  }
  const t = track(sessionId)
  t.status = status
  // Claude and Codex report dialogs through hooks, which say when each one
  // closes. OpenCode has only its status, and Claude's `waiting` also covers
  // the idle-prompt reminder, so only OpenCode's status means a dialog.
  if (deps?.provider(sessionId) === 'opencode') {
    if (status === 'waiting') t.dialog ??= { toolUseId: null }
    else if (status === 'running') t.dialog = null
  }
  requestSend(sessionId)
}

/** A key (or anything else the user sent) reached the session's PTY. */
export function noteThreadUserInput(sessionId: string): void {
  if (!deps) return
  const t = track(sessionId)
  // Keys pressed while a dialog is up answered the dialog; they leave nothing in the prompt.
  if (!t.dialog) t.draft = true
  requestSend(sessionId)
}

/** A hook, or a provider event translated into one, for this session. */
export function noteThreadSignal(sessionId: string, e: DeliveryEvent): void {
  if (!deps) return
  const t = track(sessionId)
  switch (e.eventName) {
    case 'UserPromptSubmit':
      t.turnEnded = false
      t.draft = false
      t.dialog = null
      promptSubmitted(sessionId, t, e.prompt ?? '')
      break
    case 'PermissionRequest':
      t.turnEnded = false
      t.dialog = { toolUseId: e.toolUseId ?? null }
      break
    case 'PreToolUse':
      t.turnEnded = false
      if (e.toolName && (DIALOG_TOOLS as readonly string[]).includes(e.toolName)) t.dialog = { toolUseId: e.toolUseId ?? null }
      break
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      t.turnEnded = false
      if (t.dialog && (!t.dialog.toolUseId || !e.toolUseId || t.dialog.toolUseId === e.toolUseId)) t.dialog = null
      break
    case 'Notification': {
      const idlePrompt = e.notificationType
        ? e.notificationType === 'idle_prompt'
        : e.message === 'Claude is waiting for your input'
      if (!idlePrompt) t.dialog ??= { toolUseId: null }
      else if (t.status !== 'running' && !t.dialog) t.turnEnded = true
      break
    }
    case 'StopFailure':
      t.dialog = null
      t.turnEnded = true
      settleArms(sessionId, t, null, 'The turn failed before the agent answered')
      break
  }
  requestSend(sessionId)
}

export function beginThreadStop(sessionId: string): void {
  if (!deps) return
  const t = track(sessionId)
  t.stopsInFlight += 1
  t.dialog = null
}

/**
 * A `Stop` was answered. `continued`: the answer continued the turn (a
 * Stop-hook block), so it hasn't really ended and its arms stay.
 */
export function endThreadStop(sessionId: string, opts: { continued: boolean; lastAssistantMessage: string | null }): void {
  if (!deps) return
  const t = track(sessionId)
  t.stopsInFlight = Math.max(0, t.stopsInFlight - 1)
  if (opts.continued) return
  t.turnEnded = true
  settleArms(sessionId, t, opts.lastAssistantMessage, null)
  requestSend(sessionId)
}

function sessionGone(sessionId: string): void {
  const t = tracks.get(sessionId)
  if (!t) return
  clearTimeout(t.confirmTimer)
  clearTimeout(t.settleTimer)
  patch(t.sending, { delivery: 'failed', failedReason: 'The session ended before the agent received it' })
  settleArms(sessionId, t, null, 'The session ended before the agent answered')
  tracks.delete(sessionId)
  refreshHeld(sessionId)
}

// -- Replies -------------------------------------------------------------

export type ReplyResult = { ok: true } | { ok: false; error: string }

export function replyToThread(sessionId: string, threadId: string, body: string): ReplyResult {
  if (!deps) return { ok: false, error: 'Agent threads are unavailable in this SimpleEdit session.' }
  const thread = getThread(threadId)
  if (!thread) return { ok: false, error: `Unknown thread "${threadId}".` }
  if (thread.sessionId !== sessionId) {
    return {
      ok: false,
      error:
        `Thread "${threadId}" belongs to another session, not this one (a fork or hand-off shares the conversation, not its threads). ` +
        'Answer in your terminal instead.',
    }
  }
  if (!body.trim()) return { ok: false, error: 'reply_to_thread needs a non-empty `body`.' }
  emit(appendAgentMessage(threadId, newMessageId(), body))
  const t = tracks.get(sessionId)
  const armed = t?.armed.get(threadId)
  if (t && armed) {
    t.replied.add(threadId)
    patch(armed, { delivery: 'answered' })
  }
  return { ok: true }
}

function settleArms(sessionId: string, t: Track, lastAssistantMessage: string | null, reason: string | null): void {
  if (t.armed.size === 0) return
  const text = lastAssistantMessage?.trim() ? lastAssistantMessage : null
  for (const [threadId, messageIds] of t.armed) {
    if (t.replied.has(threadId)) continue
    if (text && !reason) {
      emit(appendAgentMessage(threadId, newMessageId(), text))
      patch(messageIds, { delivery: 'answered-implicitly' })
    } else {
      patch(messageIds, { delivery: 'unanswered', failedReason: reason ?? 'The turn ended without an answer' })
    }
  }
  console.log(`[Threads] Turn ended for ${sessionId}: ${[...t.armed.keys()].map((id) => `${id}=${t.replied.has(id) ? 'replied' : text && !reason ? 'implicit' : 'unanswered'}`).join(', ')}`)
  t.armed.clear()
  t.replied.clear()
}

function promptSubmitted(sessionId: string, t: Track, prompt: string): void {
  // A new turn: whatever was armed for the last one and never answered stays unanswered.
  settleArms(sessionId, t, null, 'The turn was interrupted before the agent answered')
  const ids = new Set(threadIdsInPrompt(prompt))
  if (ids.size === 0) return
  const confirmed: string[] = []
  for (const { thread, message } of messagesInState(sessionId, ['sending'])) {
    if (!ids.has(thread.id)) continue
    confirmed.push(message.id)
    t.sending.delete(message.id)
    const list = t.armed.get(thread.id) ?? []
    list.push(message.id)
    t.armed.set(thread.id, list)
  }
  if (t.sending.size === 0) clearTimeout(t.confirmTimer)
  patch(confirmed, { delivery: 'delivered' })
  console.log(`[Threads] Delivered to ${sessionId}: ${confirmed.join(', ') || '(no message in sending)'}`)
}

// -- Sending -------------------------------------------------------------

/** Why held messages can't go out now, or null when they can. */
function heldReason(sessionId: string, t: Track | undefined): HeldReason | null {
  const provider = deps?.provider(sessionId) ?? null
  if (!t || !provider || t.status === undefined) return 'not-running'
  if (t.dialog) return 'dialog'
  if (t.draft && provider !== 'opencode') return 'draft'
  if (!t.turnEnded || t.status === 'running' || t.stopsInFlight > 0 || t.sending.size > 0) return 'busy'
  return null
}

function refreshHeld(sessionId: string): void {
  const held = messagesInState(sessionId, ['held'])
  if (held.length === 0) return
  const reason = heldReason(sessionId, tracks.get(sessionId)) ?? 'busy'
  patch(
    held.filter((p) => p.message.heldReason !== reason).map((p) => p.message.id),
    { delivery: 'held', heldReason: reason },
  )
}

export function requestSend(sessionId: string): void {
  if (!deps) return
  refreshHeld(sessionId)
  const t = tracks.get(sessionId)
  if (!t || heldReason(sessionId, t) !== null || t.settleTimer) return
  if (messagesInState(sessionId, ['held']).length === 0) return
  t.settleTimer = setTimeout(() => {
    t.settleTimer = undefined
    void fire(sessionId)
  }, SEND_SETTLE_MS)
}

async function fire(sessionId: string): Promise<void> {
  const t = tracks.get(sessionId)
  if (!deps || !t || heldReason(sessionId, t) !== null) return
  const held = messagesInState(sessionId, ['held'])
  if (held.length === 0) return
  const byThread = new Map<string, { thread: AgentThread; newMessageIds: Set<string> }>()
  for (const { thread, message } of held) {
    const entry = byThread.get(thread.id) ?? { thread, newMessageIds: new Set<string>() }
    entry.newMessageIds.add(message.id)
    byThread.set(thread.id, entry)
  }
  const prompt = formatThreadsPrompt([...byThread.values()])
  const ids = held.map((p) => p.message.id)
  t.turnEnded = false
  console.log(`[Threads] Sending to ${sessionId}: ${[...byThread.keys()].join(', ')}`)

  const pushed = deps.push(sessionId, prompt)
  if (pushed) {
    // No prompt hook to confirm by: the push succeeding is the delivery.
    patch(ids, { delivery: 'sending' })
    if (await pushed) promptSubmitted(sessionId, trackWithSending(t, ids), prompt)
    else patch(ids, { delivery: 'failed', failedReason: 'The agent did not accept the message' })
    return
  }

  for (const id of ids) t.sending.add(id)
  patch(ids, { delivery: 'sending' })
  deps.write(sessionId, agentSubmitWrite(prompt))
  clearTimeout(t.confirmTimer)
  t.confirmTimer = setTimeout(() => confirmTimedOut(sessionId), CONFIRM_MS)
}

function trackWithSending(t: Track, ids: string[]): Track {
  for (const id of ids) t.sending.add(id)
  return t
}

function confirmTimedOut(sessionId: string): void {
  const t = tracks.get(sessionId)
  if (!t || t.sending.size === 0) return
  console.log(`[Threads] Not confirmed by ${sessionId}: ${[...t.sending].join(', ')}`)
  patch(t.sending, { delivery: 'failed', failedReason: "The agent didn't receive it. Check its prompt: the comment may still be there." })
  t.sending.clear()
  // No turn started, so the write may be sitting unsubmitted in the prompt (a
  // TUI that read the Enter as a newline). Writing again would double it, so a
  // retry waits like any draft until the user submits or vouches it is empty.
  t.draft = true
  t.turnEnded = true
  requestSend(sessionId)
}

// -- User actions --------------------------------------------------------

/** Retry a failed or unanswered message: it is held and sent at the next safe moment. */
export function retryMessage(sessionId: string, messageId: string): boolean {
  const pending = messagesInState(sessionId, ['failed', 'unanswered']).find((p) => p.message.id === messageId)
  if (!pending) return false
  patch([messageId], { delivery: 'held', heldReason: 'busy' })
  requestSend(sessionId)
  return true
}

/** The user vouches that the prompt is empty: forget the draft and send what's held. */
export function forceSend(sessionId: string): void {
  const t = tracks.get(sessionId)
  if (!t) return
  t.draft = false
  requestSend(sessionId)
}

/** A thread's owner now is another session (hand-off): carry the delivery state across. */
export function moveSession(from: string, to: string): void {
  const t = tracks.get(from)
  if (t && t.armed.size) settleArms(from, t, null, 'The session was handed off before the agent answered')
  requestSend(to)
}

/** Test seam. */
export function resetThreadDelivery(): void {
  for (const t of tracks.values()) {
    clearTimeout(t.confirmTimer)
    clearTimeout(t.settleTimer)
  }
  tracks.clear()
  deps = null
}
