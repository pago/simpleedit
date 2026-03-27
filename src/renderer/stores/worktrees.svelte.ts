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
