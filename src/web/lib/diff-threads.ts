/**
 * Agent threads on the phone's session diff: the anchor a tapped line makes,
 * and which row each existing thread shows under. Pure, so the rules are
 * tested without rendering.
 */
import type { AgentThread, ThreadAnchor } from '../../shared/agent-threads'
import type { DiffFile, DiffRow } from '../../shared/parseDiff'

/** Lines kept above and below a thread's snippet, as `thread-anchor.ts` keeps them on the desktop. */
const CONTEXT_LINES = 3

/** What the diff on screen is the new side of: the working copy, or one commit. */
export type DiffView = { worktreePath: string; commit: 'uncommitted' | string }

const trimRoot = (p: string): string => p.replace(/\/+$/, '')

/** Only rows on the new side can carry a thread; a deletion has no line to anchor to. */
export function canAnchor(row: DiffRow): boolean {
  return (row.kind === 'add' || row.kind === 'ctx') && row.newNo !== undefined
}

function newSide(file: DiffFile): Map<number, string> {
  const lines = new Map<number, string>()
  for (const r of file.rows) if (canAnchor(r)) lines.set(r.newNo!, r.text)
  return lines
}

/**
 * The anchor for a tapped line. `before` and `after` are the new-side lines
 * the diff holds next to it, up to three each: a hunk's edge or a gap between
 * hunks ends them early, because the lines past it aren't known here.
 */
export function diffAnchor(file: DiffFile, row: DiffRow, view: DiffView): ThreadAnchor | null {
  if (!canAnchor(row)) return null
  const line = row.newNo!
  const lines = newSide(file)
  const before: string[] = []
  for (let l = line - 1; l >= line - CONTEXT_LINES && lines.has(l); l--) before.unshift(lines.get(l)!)
  const after: string[] = []
  for (let l = line + 1; l <= line + CONTEXT_LINES && lines.has(l); l++) after.push(lines.get(l)!)
  return {
    path: file.path,
    startLine: line,
    endLine: line,
    snippet: row.text,
    before: before.join('\n'),
    after: after.join('\n'),
    context: { commit: view.commit },
  }
}

/** A thread anchored in `view`: a working-copy thread in the uncommitted diff, a commit's in that commit's. */
function inView(t: AgentThread, view: DiffView): boolean {
  if (trimRoot(t.worktreePath) !== trimRoot(view.worktreePath) || t.anchor.orphaned) return false
  const ctx = t.anchor.context
  const workingCopy = ctx === 'file' || ctx.commit === 'uncommitted'
  return view.commit === 'uncommitted' ? workingCopy : ctx !== 'file' && ctx.commit === view.commit
}

export function rowKey(path: string, newNo: number): string {
  return `${path}\u0000${newNo}`
}

/**
 * The new-file line `thread` shows under in `files`: a range under its last
 * line, as on the desktop, or its first when the diff doesn't hold the last.
 * Null when the diff holds neither, or the thread belongs to another view;
 * the Threads tab still lists it.
 */
export function threadLine(thread: AgentThread, files: DiffFile[], view: DiffView): number | null {
  if (!inView(thread, view)) return null
  const file = files.find((f) => f.path === thread.anchor.path && !f.binary)
  if (!file) return null
  const lines = newSide(file)
  const { startLine, endLine } = thread.anchor
  return lines.has(endLine) ? endLine : lines.has(startLine) ? startLine : null
}

/** Threads by the row they show under (`rowKey`, see `threadLine`). */
export function threadsByRow(threads: AgentThread[], files: DiffFile[], view: DiffView): Map<string, AgentThread[]> {
  const out = new Map<string, AgentThread[]>()
  for (const t of threads) {
    const line = threadLine(t, files, view)
    if (line === null) continue
    const key = rowKey(t.anchor.path, line)
    out.set(key, [...(out.get(key) ?? []), t])
  }
  return out
}
