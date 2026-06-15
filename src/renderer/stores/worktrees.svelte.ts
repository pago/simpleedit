import type { WorktreeInfo } from '../../shared/ipc-types'

let _worktreeList = $state<WorktreeInfo[]>([])
/** Parent directory of the bare repo — the project's home. Claude sessions
 * launch here so all work shares one Claude memory (keyed by cwd). */
let _projectRoot = $state<string | null>(null)
/** The window's PRIMARY bare repo (the one opened from Welcome). Sessions that
 * point at another repo carry their own `repoPath`; this is the default. */
let _primaryRepo = $state<string | null>(null)
/**
 * Per-repo worktree lists for multi-repo sessions (Stage 4). The primary
 * repo's list is mirrored here too, so `worktreeListFor(primary)` and the
 * legacy `worktreeList()` always agree. Keyed by bare-repo path.
 */
let _worktreesByRepo = $state<Record<string, WorktreeInfo[]>>({})

/**
 * Reactive accessors. In Svelte 5 .svelte.ts modules, exported functions
 * that read $state will be reactive when called in component templates
 * or $derived/$effect blocks.
 */
export function worktreeList(): WorktreeInfo[] {
  return _worktreeList
}

export function projectRoot(): string | null {
  return _projectRoot
}

/** The window's primary bare repo (default for sessions without an explicit repo). */
export function primaryRepo(): string | null {
  return _primaryRepo
}

/** The directory beside a bare repo — its project home (Claude memory locality). */
export function projectRootForRepo(bareRepoPath: string): string {
  const idx = bareRepoPath.lastIndexOf('/')
  return idx > 0 ? bareRepoPath.slice(0, idx) : bareRepoPath
}

export function setProjectRoot(bareRepoPath: string | null): void {
  if (!bareRepoPath) {
    _projectRoot = null
    _primaryRepo = null
    _worktreesByRepo = {}
    return
  }
  _primaryRepo = bareRepoPath
  _projectRoot = projectRootForRepo(bareRepoPath)
}

/** Worktrees of a specific repo (multi-repo sessions). Falls back to the
 * primary repo's list when the repo matches the primary, so callers can pass a
 * session's `repoPath` uniformly. */
export function worktreeListFor(repoPath: string | null | undefined): WorktreeInfo[] {
  if (!repoPath || repoPath === _primaryRepo) return _worktreeList
  return _worktreesByRepo[repoPath] ?? []
}

/** Load + cache a non-primary repo's worktree list. Idempotent; safe to call
 * on every session activation. */
export async function refreshWorktreesFor(repoPath: string): Promise<WorktreeInfo[]> {
  if (repoPath === _primaryRepo) {
    await refreshWorktrees()
    return _worktreeList
  }
  const list = await window.api.invoke('worktree:list', repoPath)
  _worktreesByRepo = { ..._worktreesByRepo, [repoPath]: list }
  return list
}

/** Main worktree of a specific repo (default-branch, path-sorted fallback). */
export function mainWorktreeFor(repoPath: string | null | undefined): WorktreeInfo | null {
  const list = worktreeListFor(repoPath)
  return list.find((w) => w.isMain) ?? list[0] ?? null
}

/**
 * Which loaded repo owns `worktreePath`, in `Session.repoPath` terms: the
 * non-primary bare repo when the worktree belongs to one, else `undefined`
 * (primary repo, or not in any loaded list). Lets renderer-side repoint paths
 * (cwd tracking, open_worktree) derive the repo without the main process
 * having to thread it through — the per-repo lists already live here.
 */
export function repoForWorktree(worktreePath: string): string | undefined {
  for (const [repo, list] of Object.entries(_worktreesByRepo)) {
    if (repo === _primaryRepo) continue
    if (list.some((w) => w.path === worktreePath)) return repo
  }
  return undefined
}

/**
 * The bare repo that owns `worktreePath`, for grouping by repo: like
 * `repoForWorktree` but normalized to the primary repo when the worktree is the
 * primary's, so the session trail can bucket touched worktrees by repo. Null
 * only before any repo is opened.
 *
 * Caveat: a worktree from a non-primary repo whose list hasn't loaded yet falls
 * back to the primary key (we can't tell it apart until the list is cached) —
 * so right after restore, before `refreshWorktreesFor` resolves, a few trail
 * entries may bucket under the primary repo. It self-corrects reactively once
 * the lists arrive, and the pickers drop paths that resolve to nothing.
 */
export function repoKeyForWorktree(worktreePath: string): string | null {
  return repoForWorktree(worktreePath) ?? _primaryRepo
}

/** The default-branch worktree, with a path-sorted fallback. */
export function mainWorktree(): WorktreeInfo | null {
  return _worktreeList.find((w) => w.isMain) ?? _worktreeList[0] ?? null
}

export async function refreshWorktrees(): Promise<void> {
  _worktreeList = await window.api.invoke('worktree:list')
  if (_primaryRepo) {
    _worktreesByRepo = { ..._worktreesByRepo, [_primaryRepo]: _worktreeList }
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
