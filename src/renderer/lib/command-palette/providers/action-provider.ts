import type { PaletteProvider, PaletteItem, PaletteContext } from '../types'
import { fuzzyMatch } from '../fuzzy-match'
import {
  refreshWorktrees, setSecondaryWorktree,
  secondPaneWorktree, worktreeList
} from '../../../stores/worktrees.svelte'
import { openDiffTab, openTourTab } from '../../../stores/diffReview.svelte'
import { triggerTour } from '../../../stores/tourStore.svelte'

interface ActionDef {
  id: string
  label: string
  keywords: string
  execute: (context: PaletteContext) => void
}

function getWorktreePath(context: PaletteContext): string | null {
  if (context.focusedPane === 'secondary' && context.secondaryWorktree) {
    return context.secondaryWorktree.path
  }
  return context.activeWorktree?.path ?? null
}

const actions: ActionDef[] = [
  {
    id: 'action:tour-branch',
    label: 'Tour Branch',
    keywords: 'tour branch guided walkthrough',
    execute(context) {
      const path = getWorktreePath(context)
      if (!path) return
      openTourTab(path, 'branch', 'Branch tour')
      triggerTour(path, 'branch')
    }
  },
  {
    id: 'action:review-staging',
    label: 'Review Staging',
    keywords: 'review staging uncommitted changes diff',
    execute(context) {
      const path = getWorktreePath(context)
      if (!path) return
      openDiffTab(path, null, 'Uncommitted changes')
    }
  },
  {
    id: 'action:review-branch',
    label: 'Review Branch',
    keywords: 'review branch diff changes',
    execute(context) {
      const path = getWorktreePath(context)
      if (!path) return
      openDiffTab(path, 'branch', 'Branch changes')
    }
  },
  {
    id: 'action:split-pane',
    label: 'Split Pane',
    keywords: 'split view dual two pane side by side',
    execute() {
      const available = worktreeList().filter(
        (w) => w.path !== secondPaneWorktree()?.path
      )
      if (available.length > 0 && !secondPaneWorktree()) {
        setSecondaryWorktree(available[0])
      }
    }
  },
  {
    id: 'action:close-split',
    label: 'Close Split Pane',
    keywords: 'close split pane single view',
    execute() {
      setSecondaryWorktree(null)
    }
  },
  {
    id: 'action:refresh-worktrees',
    label: 'Refresh Worktrees',
    keywords: 'refresh reload worktrees sync',
    execute() {
      refreshWorktrees()
    }
  }
]

export const actionProvider: PaletteProvider = {
  category: 'action',

  search(query: string): PaletteItem[] {
    if (query.length === 0) {
      return actions.map((a) => ({
        id: a.id,
        category: 'action',
        label: a.label,
        data: a
      }))
    }

    const results: PaletteItem[] = []
    for (const action of actions) {
      const searchText = `${action.label} ${action.keywords}`
      const match = fuzzyMatch(query, searchText)
      if (match) {
        // Re-match against just the label for highlight indices
        const labelMatch = fuzzyMatch(query, action.label)
        results.push({
          id: action.id,
          category: 'action',
          label: action.label,
          matchIndices: labelMatch?.indices,
          data: action
        })
      }
    }

    return results
  },

  execute(item: PaletteItem, context: PaletteContext): void {
    const action = item.data as ActionDef
    action.execute(context)
  }
}
