import type { WorktreeInfo } from '../../shared/ipc-types'

let _worktreeList = $state<WorktreeInfo[]>([])

/**
 * Reactive accessors. In Svelte 5 .svelte.ts modules, exported functions
 * that read $state will be reactive when called in component templates
 * or $derived/$effect blocks.
 */
export function worktreeList(): WorktreeInfo[] {
  return _worktreeList
}

export async function refreshWorktrees(): Promise<void> {
  _worktreeList = await window.api.invoke('worktree:list')
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

  _worktreeList = [..._worktreeList.slice(0, idx), ..._worktreeList.slice(idx + 1)]

  return {
    rollback(): void {
      // Re-insert at the original index. If concurrent deletes have shifted
      // the list, the index is clamped to keep the entry visible.
      const insertAt = Math.min(idx, _worktreeList.length)
      _worktreeList = [..._worktreeList.slice(0, insertAt), removed, ..._worktreeList.slice(insertAt)]
    },
  }
}
