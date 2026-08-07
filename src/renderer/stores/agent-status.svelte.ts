import type { AgentStatus } from '../../shared/ipc-types'

/**
 * Per-terminal agent status. The worktree-level status shown in the sidebar
 * and worktree picker is derived from these: a worktree is "active" when ANY
 * of its agent terminals is non-idle.
 *
 * Keying by terminalId (rather than collapsing straight to worktreePath) fixes
 * two problems with the old last-writer-wins record:
 *  - #114: when an agent tab closes mid-run, its terminal is pruned on
 *    pty:exit, so the worktree correctly drops back to idle instead of
 *    sticking at "running" forever. (main sends a final agent lifecycle
 *    event before pty:exit, but under the old worktree-keyed record a
 *    *different* still-running tab could have been the last writer, leaving
 *    the worktree stuck. Pruning on pty:exit removes the dead terminal
 *    outright so the derived status can't be wrong.)
 *  - two agent tabs in the same worktree no longer clobber each other's
 *    status — the worktree stays "running" until the LAST one goes idle.
 */
interface TerminalStatus {
  worktreePath: string
  status: AgentStatus
  precise: boolean
}

let byTerminal = $state<Record<string, TerminalStatus>>({})

/** Non-idle "an agent is doing something" states. */
function isActive(status: AgentStatus): boolean {
  return status === 'initializing' || status === 'running' || status === 'waiting'
}

/**
 * Worktree-level status. Active (running/waiting) wins — if any terminal in
 * the worktree is active, return that. Otherwise surface an error if one is
 * present, else idle.
 */
export function getAgentStatus(worktreePath: string): AgentStatus {
  let sawError = false
  for (const t of Object.values(byTerminal)) {
    if (t.worktreePath !== worktreePath) continue
    if (isActive(t.status)) return t.status
    if (t.status === 'error') sawError = true
  }
  return sawError ? 'error' : 'idle'
}

/** Session-level status: the status of one terminal, idle until reported. */
export function getAgentStatusForTerminal(terminalId: string): AgentStatus {
  return byTerminal[terminalId]?.status ?? 'idle'
}

/** Drop a terminal from status tracking (called when its tab/PTY goes away). */
export function clearAgentStatusForTerminal(terminalId: string): void {
  if (!(terminalId in byTerminal)) return
  const { [terminalId]: _removed, ...rest } = byTerminal
  byTerminal = rest
}

/**
 * Initialize IPC listeners for agent lifecycle events.
 * Call once during app startup.
 */
export function initAgentStatusListeners(): () => void {
  const offStatus = window.api.on('agent:status', (data) => {
    if (byTerminal[data.terminalId]?.precise && !data.precise) return
    byTerminal = {
      ...byTerminal,
      [data.terminalId]: { worktreePath: data.worktreePath, status: data.status, precise: data.precise },
    }
  })
  // When a PTY exits its terminal can no longer be active — prune it so the
  // worktree status recomputes without the dead terminal. (#114)
  const offExit = window.api.on('pty:exit', ({ id }) => {
    clearAgentStatusForTerminal(id)
  })
  return () => {
    offStatus()
    offExit()
  }
}
