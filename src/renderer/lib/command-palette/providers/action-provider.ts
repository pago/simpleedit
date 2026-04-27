import type { PaletteProvider, PaletteItem, PaletteContext } from '../types'
import type { GitCommitInfo } from '../../../../shared/ipc-types'
import { fuzzyMatch } from '../fuzzy-match'
import {
  refreshWorktrees, setSecondaryWorktree,
  secondPaneWorktree, worktreeList
} from '../../../stores/worktrees.svelte'
import { openDiffTab, openTourTab } from '../../../stores/diffReview.svelte'
import { triggerTour, loadCachedTour, tourStore } from '../../../stores/tourStore.svelte'

interface ActionDef {
  id: string
  label: string
  description?: string
  keywords: string
  execute: (context: PaletteContext) => void
}

const tourCommitsCache = new Map<string, { commits: GitCommitInfo[]; timestamp: number }>()
const TOUR_COMMITS_CACHE_TTL = 30_000
const TOUR_COMMITS_MAX = 15

async function getRecentCommits(worktreePath: string): Promise<GitCommitInfo[]> {
  const cached = tourCommitsCache.get(worktreePath)
  if (cached && Date.now() - cached.timestamp < TOUR_COMMITS_CACHE_TTL) {
    return cached.commits
  }
  const commits = await window.api.invoke('git:log', worktreePath, TOUR_COMMITS_MAX)
  tourCommitsCache.set(worktreePath, { commits, timestamp: Date.now() })
  return commits
}

function buildTourCommitActions(worktreePath: string, commits: GitCommitInfo[]): ActionDef[] {
  return commits.map((commit) => {
    const firstLine = commit.message.split('\n')[0] ?? commit.message
    const label = `Tour: ${firstLine || commit.hash.slice(0, 7)}`
    const fallback = firstLine || commit.hash.slice(0, 7)
    return {
      id: `action:tour-commit:${commit.hash}`,
      label: `Tour commit: ${fallback}`,
      description: `${commit.hash.slice(0, 7)} by ${commit.author}`,
      keywords: `tour commit ${commit.hash.slice(0, 7)} ${commit.message} ${commit.author}`,
      execute(context) {
        const path = getWorktreePath(context)
        if (!path) return
        openTourTab(path, commit.hash, label)
        if (!tourStore.hasTourForCommit(path, commit.hash)) {
          loadCachedTour(path, commit.hash).catch(() => undefined)
        }
      },
    }
  })
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

function toItem(action: ActionDef, matchIndices?: number[]): PaletteItem {
  return {
    id: action.id,
    category: 'action',
    label: action.label,
    description: action.description,
    matchIndices,
    data: action,
  }
}

export const actionProvider: PaletteProvider = {
  category: 'action',

  async search(query: string, context: PaletteContext): Promise<PaletteItem[]> {
    const worktreePath = getWorktreePath(context)

    let tourCommitActions: ActionDef[] = []
    if (worktreePath) {
      try {
        const commits = await getRecentCommits(worktreePath)
        tourCommitActions = buildTourCommitActions(worktreePath, commits)
      } catch {
        tourCommitActions = []
      }
    }

    const allActions = [...actions, ...tourCommitActions]

    if (query.length === 0) {
      // Static actions only when no query — per-commit tour entries would
      // dominate the palette otherwise.
      return actions.map((a) => toItem(a))
    }

    const results: { item: PaletteItem; score: number }[] = []
    for (const action of allActions) {
      const searchText = `${action.label} ${action.keywords}`
      const match = fuzzyMatch(query, searchText)
      if (match) {
        const labelMatch = fuzzyMatch(query, action.label)
        results.push({
          item: toItem(action, labelMatch?.indices),
          score: match.score,
        })
      }
    }

    return results.sort((a, b) => b.score - a.score).map((r) => r.item)
  },

  execute(item: PaletteItem, context: PaletteContext): void {
    const action = item.data as ActionDef
    action.execute(context)
  }
}
