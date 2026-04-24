/**
 * Helpers for opening diff, plan, and tour tabs. The historical
 * `diffReviewStore` with its hash sentinel and save-and-restore dance is gone
 * — every first-class view is now a tab on {@link tabsStore}, and call sites
 * reach for these helpers to avoid re-deriving the `tabIdFor(...)` + `open(...)`
 * shape everywhere.
 */

import { tabsStore, tabIdFor, type DiffTab, type PlanTab, type TourTab, type OpenOptions } from './tabsStore.svelte'

export interface OpenDiffOptions extends OpenOptions {
  /** Hint the Findings section to show immediately after the diff loads. */
  showFindings?: boolean
}

export function openDiffTab(
  worktreePath: string,
  commitHash: string | null,
  commitMessage: string,
  opts: OpenDiffOptions = {},
): DiffTab {
  const { showFindings, ...openOpts } = opts
  const tab: DiffTab = {
    kind: 'diff',
    id: tabIdFor({ kind: 'diff', commitHash }),
    commitHash,
    commitMessage,
    initialTab: showFindings ? 'findings' : undefined,
  }
  return tabsStore.open(worktreePath, tab, openOpts) as DiffTab
}

export function openTourTab(
  worktreePath: string,
  commitHash: string | null,
  commitMessage: string,
  opts: OpenOptions = {},
): TourTab {
  const tab: TourTab = {
    kind: 'tour',
    id: tabIdFor({ kind: 'tour', commitHash }),
    commitHash,
    commitMessage,
  }
  return tabsStore.open(worktreePath, tab, opts) as TourTab
}

export interface OpenPlanOptions extends OpenOptions {
  /** Terminal that originated a Claude plan, if any. */
  claudeTerminalId?: string | null
}

export function openPlanTab(
  worktreePath: string,
  planHash: string,
  label: string,
  opts: OpenPlanOptions = {},
): PlanTab {
  const { claudeTerminalId, ...openOpts } = opts
  const tab: PlanTab = {
    kind: 'plan',
    id: tabIdFor({ kind: 'plan', planHash }),
    planHash,
    label,
    claudeTerminalId: claudeTerminalId ?? null,
  }
  return tabsStore.open(worktreePath, tab, openOpts) as PlanTab
}

/** The hash of the currently-active diff tab for a worktree, if any. */
export function activeDiffHash(worktreePath: string): string | null | undefined {
  const active = tabsStore.active(worktreePath)
  if (!active || active.kind !== 'diff') return undefined
  return active.commitHash
}
