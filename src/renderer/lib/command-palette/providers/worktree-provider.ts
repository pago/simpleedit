import type { PaletteProvider, PaletteItem, PaletteContext } from '../types'
import type { WorktreeInfo } from '../../../../shared/ipc-types'
import { fuzzyMatch } from '../fuzzy-match'
import { worktreeList } from '../../../stores/worktrees.svelte'
import { sessionsStore } from '../../../stores/sessions.svelte'

export const worktreeProvider: PaletteProvider = {
  category: 'worktree',

  search(query: string): PaletteItem[] {
    const worktrees = worktreeList()

    if (query.length === 0) {
      return worktrees.map(toItem)
    }

    const results: { item: PaletteItem; score: number }[] = []
    for (const wt of worktrees) {
      const match = fuzzyMatch(query, wt.branch)
      if (match) {
        results.push({
          item: {
            id: `worktree:${wt.path}`,
            category: 'worktree',
            label: wt.branch,
            description: wt.isMain ? 'main worktree' : undefined,
            matchIndices: match.indices,
            data: wt
          },
          score: match.score
        })
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item)
  },

  execute(item: PaletteItem, _context: PaletteContext): void {
    const wt = item.data as WorktreeInfo
    // Repoint the active session's workspace at the picked worktree.
    sessionsStore.setActiveSessionWorktree(wt.path)
  }
}

function toItem(wt: WorktreeInfo): PaletteItem {
  return {
    id: `worktree:${wt.path}`,
    category: 'worktree',
    label: wt.branch,
    description: wt.isMain ? 'main worktree' : undefined,
    data: wt
  }
}
