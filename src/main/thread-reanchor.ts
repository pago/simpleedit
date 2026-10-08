/**
 * Where a thread's code is now, after its file changed on disk. Pure: the
 * caller reads the file (`thread-anchor-watch.ts`) and persists the result.
 *
 * Matching is exact and line-based, and a match counts only when it is
 * unique: a thread that can't be placed with certainty is orphaned (keeping
 * its old lines) rather than pinned to the wrong code.
 */
import { MAX_SNIPPET, type ThreadAnchor } from '../shared/agent-threads'

/** As many context lines as the client captures (`renderer/lib/thread-anchor.ts`). */
const CONTEXT_LINES = 3
const MIN_SNIPPET_LINES = 2
const MIN_SNIPPET_CHARS = 20

/**
 * Anchors on the working copy. `uncommitted` is the new side of the
 * working-tree diff, which is the working copy too, so its lines move with
 * edits exactly like a `file` anchor's. A commit's content never changes.
 */
export function followsWorkingCopy(anchor: ThreadAnchor): boolean {
  return anchor.context === 'file' || anchor.context.commit === 'uncommitted'
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Context is joined lines, so `''` is read as none: it can't be told apart from one blank line. */
function contextLines(text: string): string[] {
  return text === '' ? [] : splitLines(text)
}

function matchesAt(file: string[], needle: string[], at: number): boolean {
  if (at < 0 || at + needle.length > file.length) return false
  for (let i = 0; i < needle.length; i++) if (file[at + i] !== needle[i]) return false
  return true
}

function uniqueMatch(file: string[], needle: string[]): number | null {
  let found: number | null = null
  for (let at = 0; at + needle.length <= file.length; at++) {
    if (!matchesAt(file, needle, at)) continue
    if (found !== null) return null
    found = at
  }
  return found
}

/** A snippet distinctive enough to place on its own: never `}` or a blank line. */
function substantial(snippet: string[]): boolean {
  if (snippet.filter((l) => l.trim()).length >= MIN_SNIPPET_LINES) return true
  return snippet.join('').replace(/\s/g, '').length >= MIN_SNIPPET_CHARS
}

/**
 * The context still surrounds the code at `at`. Context cut off by the start
 * or end of the file counts as matching: the edge explains it.
 */
function contextHolds(file: string[], at: number, length: number, before: string[], after: string[]): boolean {
  const above = before.slice(Math.max(0, before.length - at))
  const end = at + length
  const below = after.slice(0, Math.max(0, file.length - end))
  return matchesAt(file, above, at - above.length) && matchesAt(file, below, end)
}

/**
 * Where the snippet is now. The stored range is trusted only with its context
 * around it: a short snippet such as `}` easily lands on an identical line
 * after an edit above it, and would otherwise read as unchanged.
 */
function locate(file: string[], snippet: string[], anchor: ThreadAnchor, stored: number, fileChanged: boolean): number | null {
  const before = contextLines(anchor.before)
  const after = contextLines(anchor.after)
  const inPlace = matchesAt(file, snippet, stored)
  // Nothing to check a short snippet against: only an untouched file vouches for it.
  if (!before.length && !after.length && !substantial(snippet)) return inPlace && !fileChanged ? stored : null
  if (inPlace && contextHolds(file, stored, snippet.length, before, after)) return stored
  if (before.length || after.length) {
    const at = uniqueMatch(file, [...before, ...snippet, ...after])
    if (at !== null) return at + before.length
  }
  // Without its context only a distinctive snippet is still itself: a `}`
  // there may well be another function's.
  if (!substantial(snippet)) return null
  return inPlace ? stored : uniqueMatch(file, snippet)
}

/**
 * The context on one side, keeping the lines nearest the snippet that fit
 * the cap `parseAnchor` enforces: a minified line can be megabytes, and
 * threads go to every phone. A line is kept whole or not at all, since a cut
 * one could never match again.
 */
function capContext(lines: string[], side: 'before' | 'after'): string {
  const outward = side === 'before' ? [...lines].reverse() : lines
  const kept: string[] = []
  let size = -1
  for (const line of outward) {
    size += line.length + 1
    if (size > MAX_SNIPPET) break
    kept.push(line)
  }
  return (side === 'before' ? kept.reverse() : kept).join('\n')
}

function orphan(anchor: ThreadAnchor): ThreadAnchor | null {
  return anchor.orphaned ? null : { ...anchor, orphaned: true }
}

/**
 * The anchor for the file's current content (`null` content: the file is
 * gone), or `null` when it stays as stored. `fileChanged`: whether the
 * content differs from when this anchor was last placed, as far as the caller
 * knows.
 */
export function reanchor(anchor: ThreadAnchor, content: string | null, fileChanged = true): ThreadAnchor | null {
  if (content === null) return orphan(anchor)
  const file = splitLines(content)
  const snippet = splitLines(anchor.snippet)
  const stored = anchor.startLine - 1
  const start = locate(file, snippet, anchor, stored, fileChanged)
  if (start === null) return orphan(anchor)

  const { orphaned: _, ...placed } = anchor
  const end = start + snippet.length
  const next: ThreadAnchor = { ...placed, startLine: start + 1, endLine: end }
  // The surroundings where the code is now: a later edit is then matched
  // against what is around it today, not where it was first commented on.
  const before = capContext(file.slice(Math.max(0, start - CONTEXT_LINES), start), 'before')
  const after = capContext(file.slice(end, end + CONTEXT_LINES), 'after')
  const contextChanged = before !== anchor.before || after !== anchor.after
  if (start !== stored || (contextChanged && substantial(snippet))) return { ...next, before, after }
  return anchor.orphaned || anchor.endLine !== end ? next : null
}
