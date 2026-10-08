/**
 * Helpers for opening diff and tour tabs. Every first-class view is a
 * tab on {@link tabsStore}; call sites reach for these helpers to avoid
 * re-deriving the `tabIdFor(...)` + `open(...)` shape everywhere.
 *
 * Tabs live in per-SESSION lists (`workspaceKey` = session id) while their
 * git context (`worktreePath`) travels inside the tab — one session can
 * review several worktrees without its tabs dangling.
 */

import { tabsStore, tabIdFor, type DiffTab, type TourTab, type OpenOptions, type MemoryScope } from './tabsStore.svelte'

export interface OpenDiffOptions extends OpenOptions {
  /** Hint the Findings section to show immediately after the diff loads. */
  showFindings?: boolean
  /** Open a Claude-memory diff limited to the memory dir. */
  memoryScope?: MemoryScope
}

export function openDiffTab(
  workspaceKey: string,
  worktreePath: string,
  commitHash: string | null,
  commitMessage: string,
  opts: OpenDiffOptions = {},
): DiffTab {
  const { showFindings, memoryScope, ...openOpts } = opts
  const tab: DiffTab = {
    kind: 'diff',
    id: tabIdFor({ kind: 'diff', worktreePath, commitHash, memoryScope }),
    worktreePath,
    commitHash,
    commitMessage,
    initialTab: showFindings ? 'findings' : undefined,
    ...(memoryScope ? { memoryScope } : {}),
  }
  return tabsStore.open(workspaceKey, tab, openOpts) as DiffTab
}

export function openTourTab(
  workspaceKey: string,
  worktreePath: string,
  commitHash: string | null,
  commitMessage: string,
  opts: OpenOptions = {},
): TourTab {
  const tab: TourTab = {
    kind: 'tour',
    id: tabIdFor({ kind: 'tour', worktreePath, commitHash }),
    worktreePath,
    commitHash,
    commitMessage,
  }
  return tabsStore.open(workspaceKey, tab, opts) as TourTab
}

/**
 * The hash of the currently-active diff tab in a workspace, scoped to one
 * worktree — a diff for another worktree shouldn't light up this one's log,
 * nor a memory-scoped diff an unscoped log of the same repo (or vice versa).
 */
export function activeDiffHash(
  workspaceKey: string,
  worktreePath: string,
  memoryScoped = false,
): string | null | undefined {
  const active = tabsStore.active(workspaceKey)
  if (!active || active.kind !== 'diff') return undefined
  if (active.worktreePath !== worktreePath) return undefined
  if (!!active.memoryScope !== memoryScoped) return undefined
  return active.commitHash
}
