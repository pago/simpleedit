/**
 * Where a thread's code is now, after its file changed on disk. Pure: the
 * caller reads the file (`thread-anchor-watch.ts`) and persists the result.
 *
 * Matching is exact and line-based, and a match counts only when it is
 * unique: a thread that can't be placed with certainty is orphaned (keeping
 * its old lines) rather than pinned to the wrong code.
 */
import type { ThreadAnchor } from '../shared/agent-threads'

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

function locate(file: string[], snippet: string[], anchor: ThreadAnchor): number | null {
  const before = contextLines(anchor.before)
  const after = contextLines(anchor.after)
  if (before.length || after.length) {
    const at = uniqueMatch(file, [...before, ...snippet, ...after])
    if (at !== null) return at + before.length
  }
  return substantial(snippet) ? uniqueMatch(file, snippet) : null
}

function orphan(anchor: ThreadAnchor): ThreadAnchor | null {
  return anchor.orphaned ? null : { ...anchor, orphaned: true }
}

/**
 * The anchor for the file's current content (`null` content: the file is
 * gone), or `null` when it stays as stored.
 */
export function reanchor(anchor: ThreadAnchor, content: string | null): ThreadAnchor | null {
  if (content === null) return orphan(anchor)
  const file = splitLines(content)
  const snippet = splitLines(anchor.snippet)
  const stored = anchor.startLine - 1
  const start = matchesAt(file, snippet, stored) ? stored : locate(file, snippet, anchor)
  if (start === null) return orphan(anchor)

  const { orphaned: _, ...placed } = anchor
  if (start === stored) {
    const endLine = start + snippet.length
    return anchor.orphaned || anchor.endLine !== endLine ? { ...placed, endLine } : null
  }
  const end = start + snippet.length
  // The surroundings at the new place: a later edit is then matched against
  // what is around the code now, not where it was first commented on.
  return {
    ...placed,
    startLine: start + 1,
    endLine: end,
    before: file.slice(Math.max(0, start - CONTEXT_LINES), start).join('\n'),
    after: file.slice(end, end + CONTEXT_LINES).join('\n'),
  }
}
