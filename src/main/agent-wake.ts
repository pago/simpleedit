/**
 * Waking an idle session that has mail.
 *
 * A session sitting at its prompt fires no hooks, so mail delivered only at
 * `Stop` would wait until a human started a turn there. Instead, when a session
 * is idle and has queued mail, we submit a one-line notice into its PTY that
 * tells the agent to call `check_inbox`. The idle prompt is the one moment PTY
 * input does not race the TUI.
 *
 * When in doubt, don't wake. Leaving mail queued, and saying so, is always
 * safe; typing into the wrong UI is not. So any key the user pressed since the
 * last turn started, or a dialog the agent raised, rules a wake out, and the
 * mail rides the `Stop` of the next turn instead.
 */
import type { AgentStatus } from '../shared/ipc-types'
import { agentSubmitWrite } from '../shared/agent-submit'
import { onAgentStatus } from './agent-status'
import { formatWakeNotice, getPeer, hasWakeable, resetChain, takeWakeable } from './agent-bus'

/**
 * Status arrives from more than one reporter (OSC title, hooks), so a turn's
 * end can briefly look idle while its Stop hook is still being answered. Wait
 * this long and re-check rather than writing on the first idle edge.
 */
export const WAKE_SETTLE_MS = 750

interface Track {
  status?: AgentStatus
  precise: boolean
  /**
   * Any key reached the PTY since the last turn started. Not only typed text:
   * an arrow key recalls history, Esc-Esc opens the rewind picker, `/model`
   * leaves a picker up — and the wake's Enter would submit or select there.
   */
  inputPending: boolean
  /** A `waiting` that isn't the idle-prompt reminder: a permission or question dialog is up. */
  blocked: boolean
  /**
   * Claude said, through its idle-prompt Notification, that it is at its
   * prompt. Its title reads idle under a permission or question dialog too, so
   * for Claude only this explicit signal makes a session wakeable — at the
   * cost of up to a minute's wait after its turn ends.
   */
  idleConfirmed: boolean
  /**
   * This session has sent an idle-prompt Notification at least once, so one
   * can be relied on to come. Until then its `Stop` delivers by block: a
   * CLI that never sends one would otherwise leave mail queued for good.
   */
  idlePromptSeen: boolean
  /** Stop hooks being answered. A wake waits for them: the hook may still deliver by block. */
  stopsInFlight: number
  timer?: ReturnType<typeof setTimeout>
}

const tracks = new Map<string, Track>()
let write: (terminalId: string, data: string) => void = () => {}

function track(terminalId: string): Track {
  let t = tracks.get(terminalId)
  if (!t) {
    t = { precise: false, inputPending: false, blocked: false, idleConfirmed: false, idlePromptSeen: false, stopsInFlight: 0 }
    tracks.set(terminalId, t)
  }
  return t
}

export function initAgentWake(writer: (terminalId: string, data: string) => void): () => void {
  write = writer
  return onAgentStatus((event) => noteStatus(event.terminalId, event.status, event.precise))
}

export function noteStatus(terminalId: string, status: AgentStatus, precise: boolean): void {
  if (status === 'exited') {
    clearTimeout(tracks.get(terminalId)?.timer)
    tracks.delete(terminalId)
    return
  }
  const t = track(terminalId)
  // Same rule as the renderer's status store: once a precise reporter has
  // spoken, a coarse one can't override it.
  if (t.precise && !precise) return
  t.precise ||= precise
  t.status = status
  if (status === 'running') {
    // A turn the user started begins a fresh message chain.
    if (t.inputPending) resetChain(terminalId)
    t.inputPending = false
    t.blocked = false
    t.idleConfirmed = false
  }
  if (status === 'waiting') {
    t.blocked = true
    t.idleConfirmed = false
  }
  if (status === 'idle') requestWake(terminalId)
}

/**
 * A `Notification` hook. Claude reports a prompt left idle for about a minute
 * as `waiting`, after which its title never changes again — so that one kind
 * must count as idle, or a session idle for a minute could never be woken.
 * Anything else (a permission or question dialog) blocks wakes until the turn
 * moves on. When the kind can't be told, it blocks.
 */
export function noteNotification(terminalId: string, notificationType: string | null, message: string | null): void {
  const idlePrompt = notificationType
    ? notificationType === 'idle_prompt'
    : message === 'Claude is waiting for your input'
  const t = track(terminalId)
  if (!idlePrompt) {
    t.blocked = true
    return
  }
  t.blocked = false
  t.idleConfirmed = true
  t.idlePromptSeen = true
  t.status = 'idle'
  requestWake(terminalId)
}

/**
 * What xterm sends on its own, not the user: focus reports, device-attribute,
 * cursor-position and mode replies, and OSC/DCS answers to colour and setting
 * queries. Everything else reaching the PTY is a key.
 */
const TERMINAL_REPLY =
  /\x1b\[[IO]|\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R|\x1b\[\d*n|\x1b\[\??[\d;]*\$y|\x1b\[[\d;]*t|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g

/** Called for every write the user (or the renderer on their behalf) makes to a PTY. */
export function noteUserInput(terminalId: string, data: string): void {
  if (data.replace(TERMINAL_REPLY, '').length > 0) track(terminalId).inputPending = true
}

/** Claude's idle comes from its title, which can't tell its prompt from a dialog. */
function needsIdleConfirmation(terminalId: string): boolean {
  return getPeer(terminalId)?.provider === 'claude'
}

function wakeable(terminalId: string, t: Track | undefined): t is Track {
  return (
    t?.status === 'idle' &&
    !t.inputPending &&
    !t.blocked &&
    t.stopsInFlight === 0 &&
    (t.idleConfirmed || !needsIdleConfirmation(terminalId))
  )
}

/**
 * Whether queued mail for this session will be picked up by a wake, so the
 * `Stop` hook needn't deliver it as a block. Requires a known status: without
 * one, idle can't be detected and the mail would never move.
 */
export function canWake(terminalId: string): boolean {
  const t = tracks.get(terminalId)
  return (
    !!getPeer(terminalId)?.provider &&
    t?.status !== undefined &&
    !t.inputPending &&
    !t.blocked &&
    (t.idlePromptSeen || !needsIdleConfirmation(terminalId)) &&
    hasWakeable(terminalId)
  )
}

/** What will happen to mail queued for this session now, for tool results. */
export function wakeOutlook(terminalId: string): 'waking' | 'confirming' | 'busy' | 'typing' | 'blocked' | 'unknown' {
  const t = tracks.get(terminalId)
  if (!t?.status || !getPeer(terminalId)?.provider) return 'unknown'
  if (t.blocked) return 'blocked'
  if (t.inputPending) return 'typing'
  if (t.status !== 'idle') return 'busy'
  return t.idleConfirmed || !needsIdleConfirmation(terminalId) ? 'waking' : 'confirming'
}

/**
 * Bracket the answering of a `Stop` hook. The idle title can land before the
 * hook does, and the hook may still continue the turn with a block, so a wake
 * must not fire in between. A Stop also means any dialog the turn raised is gone.
 */
export function beginStop(terminalId: string): void {
  const t = track(terminalId)
  t.stopsInFlight += 1
  t.blocked = false
  t.idleConfirmed = false
}

export function endStop(terminalId: string): void {
  const t = tracks.get(terminalId)
  if (!t) return
  t.stopsInFlight = Math.max(0, t.stopsInFlight - 1)
  requestWake(terminalId)
}

/** The session is about to start a turn without passing through our wake. */
export function noteBusy(terminalId: string): void {
  const t = tracks.get(terminalId)
  if (t) t.status = 'running'
}

export function requestWake(terminalId: string): void {
  const t = tracks.get(terminalId)
  if (!wakeable(terminalId, t) || t.timer || !hasWakeable(terminalId)) return
  t.timer = setTimeout(() => {
    t.timer = undefined
    fire(terminalId)
  }, WAKE_SETTLE_MS)
}

function fire(terminalId: string): void {
  const t = tracks.get(terminalId)
  if (!wakeable(terminalId, t) || !getPeer(terminalId)?.provider) return
  const messages = takeWakeable(terminalId)
  if (messages.length === 0) return
  // Our own submit starts a turn; don't wake again until the next idle edge.
  // A notice the TUI swallowed is not retried: the mail stays queued, reported
  // as `notified`, until the session's next turn ends.
  t.status = 'running'
  t.idleConfirmed = false
  console.log(`[AgentWake] Waking ${terminalId} for ${messages.map((m) => m.id).join(', ')}`)
  write(terminalId, agentSubmitWrite(formatWakeNotice(messages)))
}

/** Test seam. */
export function resetAgentWake(): void {
  for (const t of tracks.values()) clearTimeout(t.timer)
  tracks.clear()
  write = () => {}
}
