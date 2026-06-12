import type { PaletteProvider, PaletteItem, PaletteContext } from '../types'
import { fuzzyMatch } from '../fuzzy-match'
import { dispatchPaletteAction } from '../../../stores/commandPalette.svelte'

const cache = new Map<string, { files: string[]; timestamp: number }>()
const CACHE_TTL = 30_000

function getWorktreePath(context: PaletteContext): string | null {
  return context.worktreePath
}

async function getFiles(worktreePath: string): Promise<string[]> {
  const cached = cache.get(worktreePath)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.files
  }

  const files = await window.api.invoke('fs:list-all', worktreePath)
  cache.set(worktreePath, { files, timestamp: Date.now() })
  return files
}

export function invalidateFileCache(worktreePath: string): void {
  cache.delete(worktreePath)
}

export const fileProvider: PaletteProvider = {
  category: 'file',

  async search(query: string, context: PaletteContext): Promise<PaletteItem[]> {
    const worktreePath = getWorktreePath(context)
    if (!worktreePath) return []

    const files = await getFiles(worktreePath)

    if (query.length === 0) {
      return files.slice(0, 20).map((f) => toItem(f))
    }

    const results: { item: PaletteItem; score: number }[] = []
    for (const filePath of files) {
      const pathMatch = fuzzyMatch(query, filePath)
      if (!pathMatch) continue

      const parts = filePath.split('/')
      const filename = parts[parts.length - 1]
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : ''

      // Bonus: also score against just the filename — if the query matches
      // the filename, that file is more relevant than one where the query
      // only matches directory segments.
      let score = pathMatch.score
      const filenameMatch = fuzzyMatch(query, filename)
      if (filenameMatch) {
        score += filenameMatch.score * 1.5
      }

      results.push({
        item: {
          id: `file:${filePath}`,
          category: 'file',
          label: filename,
          description: dir,
          matchIndices: pathMatch.indices,
          data: filePath
        },
        score
      })
    }

    return results
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item)
  },

  execute(item: PaletteItem, context: PaletteContext): void {
    const relativePath = item.data as string
    const worktreePath = getWorktreePath(context)
    if (!worktreePath || !context.activeSessionId) return
    dispatchPaletteAction({
      type: 'open-file',
      workspaceKey: context.activeSessionId,
      filePath: `${worktreePath}/${relativePath}`
    })
  }
}

function toItem(filePath: string): PaletteItem {
  const parts = filePath.split('/')
  const filename = parts[parts.length - 1]
  const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : ''

  return {
    id: `file:${filePath}`,
    category: 'file',
    label: filename,
    description: dir,
    data: filePath
  }
}
