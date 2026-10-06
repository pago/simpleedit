/**
 * Waking an idle session that has mail.
 *
 * A session sitting at its prompt fires no hooks, so mail delivered only at
 * `Stop` would wait until a human started a turn there. Instead, when a session
 * is idle and has queued mail, we submit a one-line notice into its PTY that
 * tells the agent to call `check_inbox`. The idle prompt is the one moment PTY
 * input does not race the TUI.
 *
 * The user's own prompt wins: if they have typed into it since the last turn,
 * a bracketed paste would be appended to their text and submitted with it, so
 * the wake is skipped and the mail rides the `Stop` of the turn they start.
 */
import type { AgentStatus } from '../shared/ipc-types'
import { agentSubmitWrite } from '../shared/agent-submit'
import { onAgentStatus } from './agent-status'
import { formatWakeNotice, getPeer, hasWakeable, takeWakeable } from './agent-bus'

/**
 * Status arrives from more than one reporter (OSC title, hooks), so a turn's
 * end can briefly look idle while its Stop hook is still being answered. Wait
 * this long and re-check rather than writing on the first idle edge.
 */
export const WAKE_SETTLE_MS = 750
/**
 * A notice the TUI swallowed (a dialog open at the prompt) produces no status
 * change, and the OSC reporter only emits changes. Without this the session
 * would look busy until the user's next turn.
 */
export const WAKE_UNANSWERED_MS = 30_000

interface Track {
  status?: AgentStatus
  precise: boolean
  /** The user typed into the prompt since it was last submitted or cleared. */
  inputPending: boolean
  /** Last character typed, so backslash-Enter reads as a newline, not a submit. */
  lastChar: string
  /** Stop hooks being answered. A wake waits for them: the hook may still deliver by block. */
  stopsInFlight: number
  timer?: ReturnType<typeof setTimeout>
  /** Set after our own notice, until a real status arrives. */
  unanswered?: ReturnType<typeof setTimeout>
}

const tracks = new Map<string, Track>()
let write: (terminalId: string, data: string) => void = () => {}

function track(terminalId: string): Track {
  let t = tracks.get(terminalId)
  if (!t) {
    t = { precise: false, inputPending: false, lastChar: '', stopsInFlight: 0 }
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
    clearTimeout(tracks.get(terminalId)?.unanswered)
    tracks.delete(terminalId)
    return
  }
  const t = track(terminalId)
  // Same rule as the renderer's status store: once a precise reporter has
  // spoken, a coarse one can't override it.
  if (t.precise && !precise) return
  clearTimeout(t.unanswered)
  t.unanswered = undefined
  t.precise ||= precise
  t.status = status
  if (status === 'idle') requestWake(terminalId)
}

/**
 * One token of PTY input, in order: a whole bracketed paste, Meta-Enter, any
 * other escape sequence, or a single character. Escape sequences are not
 * typing: xterm answers focus reports, colour queries and device attributes
 * through the same channel, and arrow keys and mouse reports arrive the same
 * way. X10 mouse reports carry three raw bytes after `ESC[M`.
 */
const INPUT_TOKEN =
  /\x1b\[200~[\s\S]*?\x1b\[201~|\x1b\r|\x1b\[M[\s\S]{3}|\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|O.|.)|[\s\S]/g

/** Called for every write the user (or the renderer on their behalf) makes to a PTY. */
export function noteUserInput(terminalId: string, data: string): void {
  const t = track(terminalId)
  for (const [token] of data.matchAll(INPUT_TOKEN)) {
    if (token.startsWith('\x1b[200~')) {
      // A paste leaves its text in the prompt; its newlines are not submits.
      if (token.length > 12) t.inputPending = true
      t.lastChar = ''
    } else if (token === '\x1b\r') {
      t.inputPending = true
    } else if (token === '\r') {
      // Claude Code reads backslash-Enter as a newline in the prompt.
      t.inputPending = t.lastChar === '\\'
      t.lastChar = ''
    } else if (token === '\x03' || token === '\x15') {
      // Ctrl-C and Ctrl-U clear the prompt.
      t.inputPending = false
      t.lastChar = ''
    } else if (!token.startsWith('\x1b') && /[^\x00-\x1f\x7f]/.test(token)) {
      t.inputPending = true
      t.lastChar = token
    }
  }
}

/**
 * Whether queued mail for this session will be picked up by a wake, so the
 * `Stop` hook needn't deliver it as a block. Requires a known status: without
 * one, idle can't be detected and the mail would never move.
 */
export function canWake(terminalId: string): boolean {
  const t = tracks.get(terminalId)
  return !!getPeer(terminalId)?.provider && t?.status !== undefined && !t.inputPending && hasWakeable(terminalId)
}

/** What will happen to mail queued for this session now, for tool results. */
export function wakeOutlook(terminalId: string): 'waking' | 'busy' | 'typing' | 'unknown' {
  const t = tracks.get(terminalId)
  if (!t?.status || !getPeer(terminalId)?.provider) return 'unknown'
  if (t.inputPending) return 'typing'
  return t.status === 'idle' ? 'waking' : 'busy'
}

/**
 * Bracket the answering of a `Stop` hook. The idle title can land before the
 * hook does, and the hook may still continue the turn with a block, so a wake
 * must not fire in between.
 */
export function beginStop(terminalId: string): void {
  track(terminalId).stopsInFlight += 1
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
  if (!t || t.status !== 'idle' || t.timer || t.stopsInFlight > 0) return
  if (!hasWakeable(terminalId)) return
  t.timer = setTimeout(() => {
    t.timer = undefined
    fire(terminalId)
  }, WAKE_SETTLE_MS)
}

function fire(terminalId: string): void {
  const t = tracks.get(terminalId)
  if (!t || t.status !== 'idle' || t.inputPending || t.stopsInFlight > 0 || !getPeer(terminalId)?.provider) return
  const messages = takeWakeable(terminalId)
  if (messages.length === 0) return
  // Our own submit starts a turn; don't wake again until the next idle edge.
  t.status = 'running'
  t.unanswered = setTimeout(() => {
    t.unanswered = undefined
    if (tracks.get(terminalId) !== t) return
    t.status = 'idle'
    requestWake(terminalId)
  }, WAKE_UNANSWERED_MS)
  console.log(`[AgentWake] Waking ${terminalId} for ${messages.map((m) => m.id).join(', ')}`)
  write(terminalId, agentSubmitWrite(formatWakeNotice(messages)))
}

/** Test seam. */
export function resetAgentWake(): void {
  for (const t of tracks.values()) {
    clearTimeout(t.timer)
    clearTimeout(t.unanswered)
  }
  tracks.clear()
  write = () => {}
}
