import type { PaletteProvider, PaletteItem, PaletteContext } from '../types'
import type { GitCommitInfo } from '../../../../shared/ipc-types'
import { fuzzyMatch } from '../fuzzy-match'
import { openDiffTab } from '../../../stores/diffReview.svelte'

const cache = new Map<string, { files: GitCommitInfo[]; timestamp: number }>()
const CACHE_TTL = 30_000

function getWorktreePath(context: PaletteContext): string | null {
  return context.worktreePath
}

async function getCommits(worktreePath: string): Promise<GitCommitInfo[]> {
  const cached = cache.get(worktreePath)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.files
  }

  const commits = await window.api.invoke('git:log', worktreePath, 50)
  cache.set(worktreePath, { files: commits, timestamp: Date.now() })
  return commits
}

export function invalidateCommitCache(worktreePath: string): void {
  cache.delete(worktreePath)
}

export const commitProvider: PaletteProvider = {
  category: 'commit',

  async search(query: string, context: PaletteContext): Promise<PaletteItem[]> {
    const worktreePath = getWorktreePath(context)
    if (!worktreePath) return []

    const commits = await getCommits(worktreePath)

    if (query.length === 0) {
      return commits.slice(0, 10).map(toItem)
    }

    const results: { item: PaletteItem; score: number }[] = []
    for (const commit of commits) {
      const searchText = `${commit.hash.slice(0, 7)} ${commit.message}`
      const match = fuzzyMatch(query, searchText)
      if (match) {
        const labelMatch = fuzzyMatch(query, commit.message)
        results.push({
          item: {
            id: `commit:${commit.hash}`,
            category: 'commit',
            label: commit.message,
            description: `${commit.hash.slice(0, 7)} by ${commit.author}`,
            matchIndices: labelMatch?.indices,
            data: commit
          },
          score: match.score
        })
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item)
  },

  execute(item: PaletteItem, context: PaletteContext): void {
    const commit = item.data as GitCommitInfo
    const worktreePath = getWorktreePath(context)
    if (!worktreePath || !context.activeSessionId) return
    openDiffTab(context.activeSessionId, worktreePath, commit.hash, commit.message)
  }
}

function toItem(commit: GitCommitInfo): PaletteItem {
  return {
    id: `commit:${commit.hash}`,
    category: 'commit',
    label: commit.message,
    description: `${commit.hash.slice(0, 7)} by ${commit.author}`,
    data: commit
  }
}
