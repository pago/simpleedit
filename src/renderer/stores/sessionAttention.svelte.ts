import type { AgentStatus } from '../../shared/ipc-types'
import { getAgentStatusForTerminal, onAgentStatusTransition } from './agent-status.svelte'
import { sessionsStore, type Session } from './sessions.svelte'
import { workflowsStore } from './workflows.svelte'
import { uiView } from './uiView.svelte'
import {
  sessionAttentionLevel,
  sessionsAttention,
  type AttentionLevel,
  type SessionAttentionSummary,
  type SessionsAttention,
} from '../lib/sessionsAttention'

/**
 * Agent sessions whose turn finished while the user wasn't looking at them.
 * In memory only: a restart starts with nothing unseen.
 */
let unseen = $state<Record<string, true>>({})

/** The session the user is looking at right now, or null. */
let onScreenId = $state<string | null>(null)

export function isUnseen(terminalId: string): boolean {
  return unseen[terminalId] === true
}

function drop(terminalId: string): void {
  if (!unseen[terminalId]) return
  const { [terminalId]: _removed, ...rest } = unseen
  unseen = rest
}

// Not `initializing`: a fresh session reaches its empty prompt as initializing → idle,
// and nothing has finished yet.
function wasWorking(status: AgentStatus | undefined): boolean {
  return status === 'running'
}

export function noteAgentStatusTransition(
  terminalId: string,
  prev: AgentStatus | undefined,
  next: AgentStatus | undefined,
): void {
  if (next === undefined) {
    drop(terminalId)
    return
  }
  if (next !== 'idle' || !wasWorking(prev) || terminalId === onScreenId) return
  unseen = { ...unseen, [terminalId]: true }
}

export function setOnScreenSession(terminalId: string | null): void {
  onScreenId = terminalId
  if (terminalId) drop(terminalId)
}

function workspaceSession(): string | null {
  return uiView.current() === 'workspace' ? sessionsStore.activeSessionId() : null
}

/**
 * Tracks which session is on screen (shown in the workspace AND the window is
 * focused) and marks agent turns that end anywhere else. Call once at startup.
 * `shown` is injectable for tests; the default reads uiView + the active session.
 */
export function initSessionAttention(shown: () => string | null = workspaceSession): () => void {
  let focused = $state(document.hasFocus())
  const onFocus = (): void => {
    focused = true
  }
  const onBlur = (): void => {
    focused = false
  }
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  const offTransition = onAgentStatusTransition(noteAgentStatusTransition)
  const disposeEffect = $effect.root(() => {
    $effect(() => {
      setOnScreenSession(focused ? shown() : null)
    })
  })
  return () => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
    offTransition()
    disposeEffect()
    onScreenId = null
  }
}

/** Plain terminals and not-yet-resumed sessions have no agent status; only a crash counts for them. */
function summaryFor(session: Session): SessionAttentionSummary {
  if (session.pendingResume || session.kind === 'terminal') {
    return { exited: !!session.exited, status: 'idle', unseen: false }
  }
  return {
    exited: !!session.exited,
    status: getAgentStatusForTerminal(session.id),
    unseen: isUnseen(session.id),
  }
}

/**
 * A workflow worker is never on screen in the sidebar, so "finished, unseen"
 * means nothing for it; a task left waiting (a turn ended without a result)
 * is waiting even though the agent's own status reads idle.
 */
function workerSummary(worker: Session): SessionAttentionSummary {
  const own = summaryFor(worker)
  return { exited: own.exited, status: workflowsStore.waitsOnUser(worker) ? 'waiting' : own.status, unseen: false }
}

/** A lead's level includes its workflow workers': they have no row of their own. */
export function sessionAttentionLevelFor(session: Session): AttentionLevel {
  const workers = workflowsStore.workersOf(session)
  if (workers.length === 0) return sessionAttentionLevel(summaryFor(session))
  return sessionsAttention([summaryFor(session), ...workers.map(workerSummary)]).level
}

/** The aggregate over every current session, for the Sessions header dot. */
export function currentSessionsAttention(): SessionsAttention {
  const visible = sessionsStore.visibleSessions()
  return sessionsAttention([...visible.map(summaryFor), ...visible.flatMap((s) => workflowsStore.workersOf(s)).map(workerSummary)])
}

export function _resetSessionAttentionForTests(): void {
  unseen = {}
  onScreenId = null
}
