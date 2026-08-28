/**
 * The picker arithmetic behind the review surface, kept out of the component.
 *
 * Everything here is pure and total: given a trail, a worktree list and a log,
 * it says what the two pickers offer and which entry a freshly opened worktree
 * lands on. None of it fetches, and none of it can decide to write.
 */
import type { GitCommitInfo, SessionRepoTrail, WorktreeInfo } from '../../shared/ipc-types'

export interface RepoChoice {
  repoPath: string
  name: string
}

export interface WorktreeChoice {
  path: string
  name: string
  /** This session has actually worked here, so it is offered first. */
  touched: boolean
}

/**
 * One reviewable thing in a worktree.
 *
 * `uncommitted` carries no identity beyond its kind — there is only ever one,
 * and it names a moving target, which is why the surface treats what it shows
 * as a snapshot rather than a document.
 */
export type ReviewEntry =
  | { kind: 'uncommitted' }
  | { kind: 'commit'; hash: string; message: string; author: string; date: string }

/** Stable key for an entry, for keyed lists and staleness comparisons. */
export function entryKey(entry: ReviewEntry): string {
  return entry.kind === 'uncommitted' ? 'uncommitted' : `commit:${entry.hash}`
}

export function sameEntry(a: ReviewEntry | null, b: ReviewEntry | null): boolean {
  if (a === null || b === null) return a === b
  return entryKey(a) === entryKey(b)
}

/**
 * The project's name, from the bare repo beside it — the same derivation the
 * desktop repo picker uses, so the two never disagree about what a repo is
 * called.
 */
export function repoName(repoPath: string): string {
  return repoPath.replace(/\/[^/]*\.git$/, '').split('/').pop() ?? repoPath
}

/** Enough of a worktree path to tell two of them apart on a narrow screen. */
export function worktreeName(worktree: string): string {
  return worktree.split('/').filter(Boolean).slice(-2).join('/')
}

export function repoChoices(trail: SessionRepoTrail[]): RepoChoice[] {
  return trail.map((repo) => ({ repoPath: repo.repoPath, name: repoName(repo.repoPath) }))
}

/**
 * Which repo of the trail a worktree belongs to, or null when the trail has
 * never seen it.
 *
 * Null is the honest answer and callers must handle it: a session whose viewer
 * was pointed at a worktree by hand can sit outside its own trail.
 */
export function repoForWorktree(trail: SessionRepoTrail[], worktree: string): string | null {
  return trail.find((repo) => repo.worktrees.includes(worktree))?.repoPath ?? null
}

/** The trail's worktrees for one repo, most-recently-first. */
export function trailWorktrees(trail: SessionRepoTrail[], repoPath: string | null): string[] {
  if (repoPath === null) return []
  return trail.find((repo) => repo.repoPath === repoPath)?.worktrees ?? []
}

/**
 * Worktrees to offer: the ones this session has touched, in trail order, then
 * the rest of the repo alphabetically.
 *
 * The touched ones come first for the same reason they do on the desktop —
 * they are where the work is. The listed ones are what makes the picker
 * complete, and they are additive: `worktree:list` answers `[]` on failure, so
 * the trail is the floor this can never fall below.
 */
export function worktreeChoices(touched: string[], listed: WorktreeInfo[]): WorktreeChoice[] {
  const seen = new Set<string>()
  const choices: WorktreeChoice[] = []
  for (const path of touched) {
    if (seen.has(path)) continue
    seen.add(path)
    choices.push({ path, name: worktreeName(path), touched: true })
  }
  for (const worktree of [...listed].sort((a, b) => a.path.localeCompare(b.path))) {
    if (seen.has(worktree.path)) continue
    seen.add(worktree.path)
    choices.push({ path: worktree.path, name: worktree.branch || worktreeName(worktree.path), touched: false })
  }
  return choices
}

/**
 * Where a worktree opens: its uncommitted changes, as at the desk.
 *
 * With a clean tree there is nothing to review there, so the newest commit
 * takes its place — the same substitution `GitLog` makes when the working tree
 * goes clean under it.
 */
export function defaultEntry(hasUncommitted: boolean, commits: GitCommitInfo[]): ReviewEntry | null {
  if (hasUncommitted) return { kind: 'uncommitted' }
  const newest = commits[0]
  if (!newest) return null
  return { kind: 'commit', hash: newest.hash, message: newest.message, author: newest.author, date: newest.date }
}

export function entryTitle(entry: ReviewEntry): string {
  if (entry.kind === 'uncommitted') return 'Uncommitted changes'
  return entry.message.split('\n')[0] || entry.hash.slice(0, 7)
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

/** Coarse ages, because on this screen the exact minute never changes a decision. */
export function relativeTime(date: string, now: number): string {
  const then = new Date(date).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.floor((now - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 52) return `${weeks}w ago`
  return new Date(then).toLocaleDateString()
}
