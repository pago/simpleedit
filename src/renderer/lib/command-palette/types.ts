import type { GitCommitInfo } from '../../../shared/ipc-types'

export type PaletteCategory = 'file' | 'worktree' | 'action' | 'commit'

export interface PaletteItem {
  id: string
  category: PaletteCategory
  label: string
  description?: string
  /** Indices of matched characters in label, for highlighting */
  matchIndices?: number[]
  /** Original data attached to the item for execute() */
  data?: unknown
}

export interface PaletteContext {
  /** The active session's id — the tabsStore key all opens target. */
  activeSessionId: string | null
  /** The active session's selected worktree (git context for searches). */
  worktreePath: string | null
}

export interface PaletteProvider {
  category: PaletteCategory
  search(query: string, context: PaletteContext): PaletteItem[] | Promise<PaletteItem[]>
  execute(item: PaletteItem, context: PaletteContext): void
}

export type PaletteAction =
  | { type: 'open-file'; workspaceKey: string; filePath: string }

export type PalettePrefix = '>' | '@' | '#' | null

export function parseQuery(raw: string): { prefix: PalettePrefix; query: string } {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('>')) return { prefix: '>', query: trimmed.slice(1).trimStart() }
  if (trimmed.startsWith('@')) return { prefix: '@', query: trimmed.slice(1).trimStart() }
  if (trimmed.startsWith('#')) return { prefix: '#', query: trimmed.slice(1).trimStart() }
  return { prefix: null, query: trimmed }
}

export const PREFIX_CATEGORY_MAP: Record<string, PaletteCategory> = {
  '>': 'action',
  '@': 'worktree',
  '#': 'commit'
}

export const CATEGORY_LABELS: Record<PaletteCategory, string> = {
  file: 'Files',
  worktree: 'Worktrees',
  action: 'Actions',
  commit: 'Commits'
}

export const CATEGORY_PREFIXES: Record<PaletteCategory | 'all', string> = {
  all: '',
  file: '',
  worktree: '@',
  action: '>',
  commit: '#'
}

/** Max results per category in "all" mode (no prefix) */
export const ALL_MODE_LIMITS: Record<PaletteCategory, number> = {
  file: 7,
  worktree: 3,
  action: 5,
  commit: 5
}
