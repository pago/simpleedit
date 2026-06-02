import { watch, type FSWatcher } from 'chokidar'
import { dirname } from 'path'
import type { WebContents } from 'electron'

/**
 * Watches the project root for worktree add/remove/move performed *outside*
 * SimpleEdit (e.g. `git worktree add/remove/move` from a terminal) and tells
 * the renderer to refresh its worktree list (#120).
 *
 * Worktrees live as siblings of the bare repo, so an add/remove/move surfaces
 * as an `addDir`/`unlinkDir` of a direct child of the project root. We watch
 * non-recursively (`depth: 0`) so we react to those directory-level events
 * without drowning in change events for files *inside* each worktree — and so
 * commits/staging inside the bare repo (handled separately by `watchGitRefs`)
 * don't spuriously trigger a worktree-list refresh.
 *
 * Keyed by `webContents.id` so each window owns its watcher, mirroring the MCP
 * bridge lifecycle (`startBridge`/`stopBridge`).
 */

const DEBOUNCE_MS = 150

interface WorktreeListWatchState {
  watcher: FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<number, WorktreeListWatchState>()

export function watchWorktreeList(
  webContentsId: number,
  bareRepoPath: string,
  webContents: WebContents
): void {
  // Don't double-watch a window that's already being watched.
  if (watchers.has(webContentsId)) return

  const projectRoot = dirname(bareRepoPath)

  const watcher = watch(projectRoot, {
    ignoreInitial: true,
    persistent: true,
    depth: 0
  })

  const state: WorktreeListWatchState = { watcher, debounceTimer: null }

  // Coalesce the multi-step file operations a single `git worktree` command
  // performs (create dir, write admin files, …) into one refresh.
  const emit = (): void => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null
      if (!webContents.isDestroyed()) {
        webContents.send('worktree:list-changed', { repoPath: bareRepoPath })
      }
    }, DEBOUNCE_MS)
  }

  watcher.on('addDir', emit)
  watcher.on('unlinkDir', emit)

  watchers.set(webContentsId, state)
}

export function unwatchWorktreeList(webContentsId: number): void {
  const state = watchers.get(webContentsId)
  if (state) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    void state.watcher.close()
    watchers.delete(webContentsId)
  }
}

export function unwatchAllWorktreeLists(): void {
  for (const state of watchers.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    void state.watcher.close()
  }
  watchers.clear()
}
