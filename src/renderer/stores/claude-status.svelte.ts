import type { ClaudeStatus } from '../../shared/ipc-types'

const TOUCH_TIMEOUT_MS = 5000

/** Per-worktree Claude status */
const statusMap = $state<Map<string, ClaudeStatus>>(new Map())

/** Per-worktree set of recently touched files, with auto-expiry timers */
const touchedFilesMap = $state<Map<string, Set<string>>>(new Map())

/** Timers for auto-removing touched files */
const touchTimers = new Map<string, ReturnType<typeof setTimeout>>()

function timerKey(worktreePath: string, filePath: string): string {
  return `${worktreePath}::${filePath}`
}

export function getClaudeStatus(worktreePath: string): ClaudeStatus {
  return statusMap.get(worktreePath) ?? 'idle'
}

export function getTouchedFiles(worktreePath: string): Set<string> {
  return touchedFilesMap.get(worktreePath) ?? new Set()
}

/**
 * Initialize IPC listeners for Claude stream events.
 * Call once during app startup.
 */
export function initClaudeStatusListeners(): () => void {
  const unsubStatus = window.api.on('claude:status', (data) => {
    statusMap.set(data.worktreePath, data.status)
  })

  const unsubTouch = window.api.on('claude:file-touch', (data) => {
    const { worktreePath, filePath } = data

    // Add file to the touched set
    let files = touchedFilesMap.get(worktreePath)
    if (!files) {
      files = new Set()
      touchedFilesMap.set(worktreePath, files)
    }
    files.add(filePath)

    // Force reactivity by replacing the set in the map
    touchedFilesMap.set(worktreePath, new Set(files))

    // Reset the auto-remove timer for this file
    const key = timerKey(worktreePath, filePath)
    const existing = touchTimers.get(key)
    if (existing) clearTimeout(existing)

    touchTimers.set(
      key,
      setTimeout(() => {
        const current = touchedFilesMap.get(worktreePath)
        if (current) {
          current.delete(filePath)
          // Force reactivity
          touchedFilesMap.set(worktreePath, new Set(current))
        }
        touchTimers.delete(key)
      }, TOUCH_TIMEOUT_MS)
    )
  })

  return () => {
    unsubStatus()
    unsubTouch()
    // Clear all timers
    for (const timer of touchTimers.values()) {
      clearTimeout(timer)
    }
    touchTimers.clear()
  }
}
