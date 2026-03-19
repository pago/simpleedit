import type { WorktreeInfo } from '../../shared/ipc-types'

let _worktreeList = $state<WorktreeInfo[]>([])
let _activeWorktree = $state<WorktreeInfo | null>(null)

/** Reactive accessor — use in $derived or template to track changes */
export const worktreeStore = {
  get list(): WorktreeInfo[] {
    return _worktreeList
  },
  get active(): WorktreeInfo | null {
    return _activeWorktree
  }
}

// Keep old function API for components that already use it
export function getWorktreeList(): WorktreeInfo[] {
  return _worktreeList
}

export function getActiveWorktree(): WorktreeInfo | null {
  return _activeWorktree
}

export function setActiveWorktree(worktree: WorktreeInfo | null): void {
  _activeWorktree = worktree
}

export async function refreshWorktrees(): Promise<void> {
  console.log('[SimpleEdit] refreshWorktrees called')
  const list = await window.api.invoke('worktree:list')
  console.log('[SimpleEdit] Got worktrees:', list)
  _worktreeList = list

  // If the active worktree was removed, clear it
  if (_activeWorktree && !list.some((w) => w.path === _activeWorktree!.path)) {
    _activeWorktree = null
  }

  // Auto-select first worktree if none is active
  if (!_activeWorktree && list.length > 0) {
    _activeWorktree = list[0]
  }
}
