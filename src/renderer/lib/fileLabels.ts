/**
 * Smart labels for a list of file paths shown in a narrow column (the diff
 * file list). Two problems are solved together:
 *
 *  1. Context-less names. Files like `index.ts`, `mod.rs`, `__init__.py` or the
 *     Next.js app-router family (`page.tsx`, `route.ts`, …) are meaningless on
 *     their own, so the immediate parent directory is folded into the primary
 *     label: `DiffReview/index.tsx`.
 *  2. Collisions. When two visible files still share the same primary label, we
 *     grow each one segment at a time until they're unique — the same scheme
 *     VS Code uses to disambiguate editor tabs.
 *
 * The remaining leading directory becomes the dimmed `secondary` text, which is
 * the part that absorbs truncation.
 */

/** Basenames (sans extension) that carry no meaning without their directory. */
const CONTEXT_LESS = new Set([
  'index',
  'mod',
  '__init__',
  '__main__',
  // Next.js / Remix app-router conventions
  'page',
  'route',
  'layout',
  'loading',
  'error',
  'template',
  'default',
])

export interface FileLabel {
  /** The prominent, never-dimmed portion — always includes the filename. */
  primary: string
  /** Leading directory, dimmed; absorbs truncation. Empty for root files. */
  secondary: string
}

/** Strip the extension chain so `index.test.tsx` and `__init__.py` reduce to their stem. */
function stem(base: string): string {
  const dot = base.indexOf('.')
  return dot === -1 ? base : base.slice(0, dot)
}

/**
 * Compute a {@link FileLabel} for every path. The result depends on the whole
 * set, since collision disambiguation needs to see sibling paths.
 */
export function computeFileLabels(paths: string[]): Map<string, FileLabel> {
  const partsOf = new Map<string, string[]>()
  // How many trailing segments belong in the primary label.
  const segCount = new Map<string, number>()

  for (const path of paths) {
    const parts = path.split('/')
    partsOf.set(path, parts)
    const base = parts[parts.length - 1] ?? path
    const wantsParent = CONTEXT_LESS.has(stem(base)) && parts.length > 1
    segCount.set(path, Math.min(wantsParent ? 2 : 1, parts.length))
  }

  // Grow colliding labels one segment at a time until each primary is unique
  // (or its full path is exhausted and can grow no further).
  let changed = true
  while (changed) {
    changed = false
    const groups = new Map<string, string[]>()
    for (const path of paths) {
      const primary = primaryOf(partsOf.get(path)!, segCount.get(path)!)
      const bucket = groups.get(primary)
      if (bucket) bucket.push(path)
      else groups.set(primary, [path])
    }
    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue
      for (const path of bucket) {
        const parts = partsOf.get(path)!
        const n = segCount.get(path)!
        if (n < parts.length) {
          segCount.set(path, n + 1)
          changed = true
        }
      }
    }
  }

  const labels = new Map<string, FileLabel>()
  for (const path of paths) {
    const parts = partsOf.get(path)!
    const n = segCount.get(path)!
    const lead = parts.slice(0, parts.length - n).join('/')
    labels.set(path, {
      primary: primaryOf(parts, n),
      secondary: lead ? lead + '/' : '',
    })
  }
  return labels
}

function primaryOf(parts: string[], segCount: number): string {
  return parts.slice(parts.length - segCount).join('/')
}
