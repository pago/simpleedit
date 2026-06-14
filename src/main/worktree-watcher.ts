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

// Keyed by `${webContentsId}::${bareRepoPath}` so a window can watch the
// project root of every repo its sessions point at (multi-repo), while a
// closing window can tear down all of its watchers via the id prefix.
const watchers = new Map<string, WorktreeListWatchState>()

function watcherKey(webContentsId: number, bareRepoPath: string): string {
  return `${webContentsId}::${bareRepoPath}`
}

export function watchWorktreeList(
  webContentsId: number,
  bareRepoPath: string,
  webContents: WebContents
): void {
  const key = watcherKey(webContentsId, bareRepoPath)
  // Don't double-watch a (window, repo) pair that's already being watched.
  if (watchers.has(key)) return

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

  watchers.set(key, state)
}

/** Stop watching one repo for one window. Omit `bareRepoPath` to stop every
 * watcher the window owns (window close / repo switch). */
export function unwatchWorktreeList(webContentsId: number, bareRepoPath?: string): void {
  if (bareRepoPath !== undefined) {
    const state = watchers.get(watcherKey(webContentsId, bareRepoPath))
    if (state) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer)
      void state.watcher.close()
      watchers.delete(watcherKey(webContentsId, bareRepoPath))
    }
    return
  }
  unwatchAllWorktreeListsForWindow(webContentsId)
}

/** Tear down every watcher owned by a window (matched by id prefix). */
export function unwatchAllWorktreeListsForWindow(webContentsId: number): void {
  const prefix = `${webContentsId}::`
  for (const [key, state] of watchers) {
    if (!key.startsWith(prefix)) continue
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    void state.watcher.close()
    watchers.delete(key)
  }
}

export function unwatchAllWorktreeLists(): void {
  for (const state of watchers.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    void state.watcher.close()
  }
  watchers.clear()
}
