import type { WorktreeInfo } from '../../shared/ipc-types'

let worktreeList = $state<WorktreeInfo[]>([])
let activeWorktree = $state<WorktreeInfo | null>(null)

export function getWorktreeList(): WorktreeInfo[] {
  return worktreeList
}

export function getActiveWorktree(): WorktreeInfo | null {
  return activeWorktree
}

export function setActiveWorktree(worktree: WorktreeInfo | null): void {
  activeWorktree = worktree
}

export async function refreshWorktrees(): Promise<void> {
  const list = await window.api.invoke('worktree:list')
  worktreeList = list

  // If the active worktree was removed, clear it
  if (activeWorktree && !list.some((w) => w.path === activeWorktree!.path)) {
    activeWorktree = null
  }

  // Auto-select first worktree if none is active
  if (!activeWorktree && list.length > 0) {
    activeWorktree = list[0]
  }
}
