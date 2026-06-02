import type { WorktreeInfo } from '../../shared/ipc-types'

/**
 * Directory basename of a worktree path — the last non-empty path segment.
 * Falls back to the raw path if it has no separators.
 */
export function worktreeDirName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Sidebar label for a worktree (#121).
 *
 * The on-disk directory is the primary handle, with the checked-out branch in
 * parentheses when the two differ — e.g. directory `improvements/` holding
 * branch `main` renders as `improvements (main)`. When the directory name and
 * branch match (the common case), only the single name is shown so we don't
 * print `main (main)`.
 */
export function worktreeLabel(worktree: WorktreeInfo): string {
  const dir = worktreeDirName(worktree.path)
  return dir === worktree.branch ? dir : `${dir} (${worktree.branch})`
}
