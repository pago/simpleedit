import type { WorktreeInfo } from '../../shared/ipc-types'

let _worktreeList = $state<WorktreeInfo[]>([])
let _activeWorktree = $state<WorktreeInfo | null>(null)
let _secondPaneWorktree = $state<WorktreeInfo | null>(null)
let _focusedPane = $state<'primary' | 'secondary'>('primary')

/**
 * Reactive accessors. In Svelte 5 .svelte.ts modules, exported functions
 * that read $state will be reactive when called in component templates
 * or $derived/$effect blocks.
 */
export function worktreeList(): WorktreeInfo[] {
  return _worktreeList
}

export function activeWorktree(): WorktreeInfo | null {
  return _activeWorktree
}

export function setActiveWorktree(worktree: WorktreeInfo | null): void {
  _activeWorktree = worktree
}

export function secondPaneWorktree(): WorktreeInfo | null {
  return _secondPaneWorktree
}

export function setSecondaryWorktree(worktree: WorktreeInfo | null): void {
  _secondPaneWorktree = worktree
  if (worktree === null) {
    _focusedPane = 'primary'
  }
}

export function focusedPane(): 'primary' | 'secondary' {
  return _focusedPane
}

export function setFocusedPane(pane: 'primary' | 'secondary'): void {
  _focusedPane = pane
}

export async function refreshWorktrees(): Promise<void> {
  const list = await window.api.invoke('worktree:list')
  _worktreeList = list

  // If the active worktree was removed, clear it
  if (_activeWorktree && !list.some((w) => w.path === _activeWorktree!.path)) {
    _activeWorktree = null
  }

  // Auto-select first worktree if none is active
  if (!_activeWorktree && list.length > 0) {
    _activeWorktree = list[0]
  }

  // If the secondary pane's worktree was removed, close the second pane
  if (_secondPaneWorktree && !list.some((w) => w.path === _secondPaneWorktree!.path)) {
    _secondPaneWorktree = null
    _focusedPane = 'primary'
  }
}

/**
 * Optimistically drop a worktree from the list — the UI updates immediately
 * so the user can fire off more deletes without waiting on `git worktree
 * remove`. The returned `rollback` undoes the change in-place (preserving the
 * original list position) for the caller to invoke if the IPC fails. Returns
 * `null` when the path isn't in the list.
 */
export function optimisticRemoveWorktree(path: string): { rollback: () => void } | null {
  const idx = _worktreeList.findIndex((w) => w.path === path)
  if (idx < 0) return null
  const removed = _worktreeList[idx]
  const wasActive = _activeWorktree?.path === path
  const wasSecondary = _secondPaneWorktree?.path === path
  const prevFocused = _focusedPane

  _worktreeList = [..._worktreeList.slice(0, idx), ..._worktreeList.slice(idx + 1)]

  if (wasActive) {
    _activeWorktree = _worktreeList[0] ?? null
  }
  if (wasSecondary) {
    _secondPaneWorktree = null
    _focusedPane = 'primary'
  }

  return {
    rollback(): void {
      // Re-insert at the original index. If concurrent deletes have shifted
      // the list, the index is clamped to keep the entry visible.
      const insertAt = Math.min(idx, _worktreeList.length)
      _worktreeList = [..._worktreeList.slice(0, insertAt), removed, ..._worktreeList.slice(insertAt)]
      if (wasActive) _activeWorktree = removed
      if (wasSecondary) {
        _secondPaneWorktree = removed
        _focusedPane = prevFocused
      }
    },
  }
}
