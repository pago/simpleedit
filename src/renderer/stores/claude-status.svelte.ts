import type { ClaudeStatus } from '../../shared/ipc-types'

/** Per-worktree Claude status, keyed by worktree path */
let statusRecord = $state<Record<string, ClaudeStatus>>({})

export function getClaudeStatus(worktreePath: string): ClaudeStatus {
  return statusRecord[worktreePath] ?? 'idle'
}

/**
 * Initialize IPC listeners for Claude stream events.
 * Call once during app startup.
 */
export function initClaudeStatusListeners(): () => void {
  return window.api.on('claude:status', (data) => {
    statusRecord = { ...statusRecord, [data.worktreePath]: data.status }
  })
}
