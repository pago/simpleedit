/**
 * Where a `path:line` citation lands in a parsed diff, shared by the desktop
 * `UnifiedDiffView` and the phone's `PrDiff` so both jump to the same row.
 *
 * A citation's line is a new-file line number, but the diff only holds the
 * hunks around the change. So the target is the exact row when the hunks
 * include it, else the row with the closest new-file number — the reader lands
 * on the change nearest the line the model meant. A file with no new-side rows
 * (binary, deleted), or a citation with no line, lands on the file header.
 */
import { parseLineAnchor } from '../../shared/screenprs'
import type { DiffFile } from './parseDiff'

export interface RevealTarget {
  path: string
  /** Index into the file's `rows`; null means the file header. */
  row: number | null
}

/** How long a revealed row or header stays highlighted. */
export const REVEAL_FLASH_MS = 1400

export function findRevealTarget(files: DiffFile[], path: string, line?: string | number): RevealTarget | null {
  const file = files.find((f) => f.path === path) ?? files.find((f) => f.oldPath === path)
  if (!file) return null
  const wanted = typeof line === 'number' ? (line > 0 ? line : null) : parseLineAnchor(line)
  if (wanted === null || file.binary) return { path: file.path, row: null }

  let best: number | null = null
  let bestDistance = Infinity
  file.rows.forEach((r, i) => {
    if (r.newNo === undefined) return
    const distance = Math.abs(r.newNo - wanted)
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  })
  return { path: file.path, row: best }
}

export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
