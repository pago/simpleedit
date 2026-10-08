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
 *    dialog tool arrive before their dialog renders; as does Codex's
 *    `PermissionRequest`; OpenCode reports one only as its `waiting` status. A dialog clears only when the engine moves past it
 *    (the tool's result, a `Stop`, a submitted prompt), never on a mere
 *    `running`: a parallel sub-agent can report running with the dialog up.
 *  - The user has nothing typed in the prompt and no picker is up, as far as
 *    the keys they sent tell (`prompt-model.ts`): a bracketed paste plus Enter
 *    would submit their draft merged with the comment. What the model can't
 *    follow counts as a draft until a prompt is submitted or the user vouches
 *    for an empty prompt (`forceSend`). OpenCode is exempt; its messages go
 *    over HTTP and never touch the TUI's input.
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
import { EMPTY_PROMPT, applyKeys, isDraft, type PromptModel } from './prompt-model'
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
  hasMessagesInState,
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
  prompt: PromptModel
  /** A key arrived since our last write, so a draft may follow our own submit. */
  inputSinceWrite: boolean
  stopsInFlight: number
  /** Messages written and awaiting their `UserPromptSubmit`. */
  sending: Set<string>
  /** Messages whose confirmation timed out; a late one still counts. */
  timedOut: Set<string>
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
    t = {
      turnEnded: false,
      dialog: null,
      prompt: EMPTY_PROMPT,
      inputSinceWrite: false,
      stopsInFlight: 0,
      sending: new Set(),
      timedOut: new Set(),
      armed: new Map(),
      replied: new Set(),
    }
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
 * Every entry point runs through this. They are called from the PTY write
 * path, the hook endpoint and the status funnel, so a thread failure (a
 * database error above all) must never cost a keystroke, a hook answer or a
 * piece of agent mail.
 */
function safely(what: string, fn: () => void): void {
  if (!deps) return
  try {
    fn()
  } catch (err) {
    console.error(`[Threads] ${what} failed:`, err)
  }
}

/**
 * Notification kinds that ask nothing of the user. Anything else, including a
 * kind this list doesn't know yet, counts as a dialog until Claude moves on:
 * when in doubt, don't type. Claude's idle-prompt reminder, sent only at its
 * input prompt, clears a dialog that never reported closing (a denied
 * permission fires no hook).
 */
const NOT_A_DIALOG = new Set(['idle_prompt', 'agent_completed', 'auth_success', 'elicitation_complete', 'push_notification', 'computer_use_exit'])

/**
 * Wire up delivery. Messages left `sending` or `delivered` by a previous run
 * can never be confirmed or answered now, so they are settled first.
 */
export function initThreadDelivery(d: DeliveryDeps): void {
  // `deps` is set only once the database answered: until then every entry point is inert.
  deps = null
  const restarted: Array<[string[], DeliveryPatch]> = []
  for (const sessionId of sessionsWithMessagesIn(['sending', 'delivered'])) {
    const stale = messagesInState(sessionId, ['sending', 'delivered'])
    restarted.push(
      [stale.filter((p) => p.message.delivery === 'sending').map((p) => p.message.id), { delivery: 'failed', failedReason: 'SimpleEdit restarted before the agent received it' }],
      [stale.filter((p) => p.message.delivery === 'delivered').map((p) => p.message.id), { delivery: 'unanswered', failedReason: 'SimpleEdit restarted before the agent answered' }],
    )
  }
  for (const [ids, p] of restarted) setDelivery(ids, p)
  const held = sessionsWithMessagesIn(['held'])
  deps = d
  for (const sessionId of held) safely('refreshHeld', () => refreshHeld(sessionId))
}

// -- Signals -------------------------------------------------------------

export function noteThreadStatus(sessionId: string, status: AgentStatus): void {
  safely('status', () => {
    if (status === 'exited') {
      sessionGone(sessionId)
      return
    }
    const t = track(sessionId)
    t.status = status
    const provider = deps?.provider(sessionId)
    // Claude's idle comes from its title, which also reads idle under a
    // dialog, and its `waiting` also covers the idle-prompt reminder; its
    // hooks are what count. Codex's and OpenCode's statuses are exact: an
    // `idle` is a finished turn (also one from before this run, which no Stop
    // will ever report), and OpenCode reports dialogs only as `waiting`.
    if (provider && provider !== 'claude' && status === 'idle') t.turnEnded = true
    if (provider === 'opencode') {
      if (status === 'waiting') t.dialog ??= { toolUseId: null }
      else if (status === 'running') t.dialog = null
    }
    requestSendNow(sessionId)
  })
}

/** A key (or anything else the user sent) reached the session's PTY. */
export function noteThreadUserInput(sessionId: string, keys: string): void {
  safely('input', () => {
    const t = track(sessionId)
    // Keys pressed while a dialog is up answered the dialog; they leave nothing in the prompt.
    if (t.dialog) return
    const was = isDraft(t.prompt)
    t.prompt = applyKeys(t.prompt, keys)
    t.inputSinceWrite = true
    if (was !== isDraft(t.prompt)) {
      console.log(`[Threads] Prompt of ${sessionId}: ${t.prompt.state}`)
      requestSendNow(sessionId)
    }
  })
}

/** A hook, or a provider event translated into one, for this session. */
export function noteThreadSignal(sessionId: string, e: DeliveryEvent): void {
  safely(e.eventName ?? 'signal', () => signal(sessionId, e))
}

function signal(sessionId: string, e: DeliveryEvent): void {
  const t = track(sessionId)
  switch (e.eventName) {
    case 'UserPromptSubmit': {
      t.turnEnded = false
      t.dialog = null
      const ours = promptSubmitted(sessionId, t, e.prompt ?? '')
      // The user's own submit empties the prompt. Ours does too, but keys that
      // arrived after our write are a new draft.
      if (!ours || !t.inputSinceWrite) t.prompt = EMPTY_PROMPT
      break
    }
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
      if (idlePrompt) {
        if (t.status === 'running') break
        t.dialog = null
        t.turnEnded = true
        // A turn interrupted with Esc fires no Stop; this is the first sign it's over.
        settleArms(sessionId, t, null, 'The turn was interrupted before the agent answered')
      } else if (!e.notificationType || !NOT_A_DIALOG.has(e.notificationType)) {
        t.dialog ??= { toolUseId: null }
      }
      break
    }
    case 'StopFailure':
      t.dialog = null
      t.turnEnded = true
      settleArms(sessionId, t, null, 'The turn failed before the agent answered')
      break
  }
  requestSendNow(sessionId)
}

export function beginThreadStop(sessionId: string): void {
  safely('beginStop', () => {
    const t = track(sessionId)
    t.stopsInFlight += 1
    t.dialog = null
  })
}

/**
 * A `Stop` was answered. `continued`: the answer continued the turn (a
 * Stop-hook block), so it hasn't really ended and its arms stay.
 */
export function endThreadStop(sessionId: string, opts: { continued: boolean; lastAssistantMessage: string | null }): void {
  safely('endStop', () => {
    const t = track(sessionId)
    t.stopsInFlight = Math.max(0, t.stopsInFlight - 1)
    if (opts.continued) return
    t.turnEnded = true
    settleArms(sessionId, t, opts.lastAssistantMessage, null)
    requestSendNow(sessionId)
  })
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

/** Returns whether the prompt was one of ours (it carried a thread header). */
function promptSubmitted(sessionId: string, t: Track, prompt: string): boolean {
  // A new turn: whatever was armed for the last one and never answered stays unanswered.
  settleArms(sessionId, t, null, 'The turn was interrupted before the agent answered')
  const ids = new Set(threadIdsInPrompt(prompt))
  if (ids.size === 0) return false
  const confirmed: string[] = []
  for (const { thread, message } of messagesInState(sessionId, ['sending', 'failed'])) {
    if (!ids.has(thread.id)) continue
    // A slow hook can confirm after we gave up; the agent has it all the same.
    if (message.delivery === 'failed' && !t.timedOut.has(message.id)) continue
    confirmed.push(message.id)
    t.sending.delete(message.id)
    t.timedOut.delete(message.id)
    const list = t.armed.get(thread.id) ?? []
    list.push(message.id)
    t.armed.set(thread.id, list)
  }
  if (t.sending.size === 0) clearTimeout(t.confirmTimer)
  patch(confirmed, { delivery: 'delivered' })
  console.log(`[Threads] Delivered to ${sessionId}: ${confirmed.join(', ') || '(no message in sending)'}`)
  return true
}

// -- Sending -------------------------------------------------------------

/** Why held messages can't go out now, or null when they can. */
function heldReason(sessionId: string, t: Track | undefined): HeldReason | null {
  const provider = deps?.provider(sessionId) ?? null
  if (!t || !provider || t.status === undefined) return 'not-running'
  if (t.dialog) return 'dialog'
  if (isDraft(t.prompt) && provider !== 'opencode') return 'draft'
  if (!t.turnEnded || t.status === 'running' || t.stopsInFlight > 0 || t.sending.size > 0) return 'busy'
  return null
}

function refreshHeld(sessionId: string): void {
  if (!hasMessagesInState(sessionId, ['held'])) return
  const held = messagesInState(sessionId, ['held'])
  if (held.length === 0) return
  const reason = heldReason(sessionId, tracks.get(sessionId)) ?? 'busy'
  patch(
    held.filter((p) => p.message.heldReason !== reason).map((p) => p.message.id),
    { delivery: 'held', heldReason: reason },
  )
}

/** A message was queued for this session: send it at the next safe moment. */
export function requestSend(sessionId: string): void {
  safely('requestSend', () => requestSendNow(sessionId))
}

function requestSendNow(sessionId: string): void {
  if (!hasMessagesInState(sessionId, ['held'])) return
  refreshHeld(sessionId)
  const t = tracks.get(sessionId)
  if (!t || heldReason(sessionId, t) !== null || t.settleTimer) return
  t.settleTimer = setTimeout(() => {
    t.settleTimer = undefined
    fire(sessionId).catch((err: unknown) => console.error('[Threads] Send failed:', err))
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
    if (await pushed) {
      promptSubmitted(sessionId, trackWithSending(t, ids), prompt)
    } else {
      patch(ids, { delivery: 'failed', failedReason: 'The agent did not accept the message' })
      // Nothing started, so the session is as idle as it was.
      t.turnEnded = true
    }
    return
  }

  for (const id of ids) t.sending.add(id)
  t.inputSinceWrite = false
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
  for (const id of t.sending) t.timedOut.add(id)
  t.sending.clear()
  // No turn started, so the write may be sitting unsubmitted in the prompt (a
  // TUI that read the Enter as a newline). Writing again would double it, so a
  // retry waits like any draft until the user submits or vouches it is empty.
  t.prompt = { state: 'unknown', typed: null, escs: 0 }
  t.turnEnded = true
  requestSendNow(sessionId)
}

// -- User actions --------------------------------------------------------

/** Retry a failed or unanswered message: it is held and sent at the next safe moment. */
export function retryMessage(sessionId: string, messageId: string): boolean {
  if (!deps) return false
  const pending = messagesInState(sessionId, ['failed', 'unanswered']).find((p) => p.message.id === messageId)
  if (!pending) return false
  tracks.get(sessionId)?.timedOut.delete(messageId)
  patch([messageId], { delivery: 'held', heldReason: 'busy' })
  requestSendNow(sessionId)
  return true
}

/** The user vouches that the prompt is empty: forget the draft and send what's held. */
export function forceSend(sessionId: string): void {
  const t = tracks.get(sessionId)
  if (!t) return
  t.prompt = EMPTY_PROMPT
  t.inputSinceWrite = false
  requestSendNow(sessionId)
}

/** A thread's owner now is another session (hand-off): carry the delivery state across. */
export function moveSession(from: string, to: string): void {
  const t = tracks.get(from)
  if (t && t.armed.size) settleArms(from, t, null, 'The session was handed off before the agent answered')
  requestSendNow(to)
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
