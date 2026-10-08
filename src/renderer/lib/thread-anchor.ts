import type { ThreadAnchor } from '../../shared/agent-threads'
import type { AgentContext } from './agent-message'

/** Lines kept above and below a thread's snippet, for re-anchoring it after edits. */
const CONTEXT_LINES = 3

/** The anchored code and its surroundings, read from the editor model at the moment of commenting. */
export interface AnchorLines {
  startLine: number
  endLine: number
  snippet: string
  before: string
  after: string
}

interface LineSource {
  getLineCount(): number
  getLineContent(line: number): string
}

function joinLines(model: LineSource, from: number, to: number): string {
  const out: string[] = []
  for (let l = from; l <= to; l++) out.push(model.getLineContent(l))
  return out.join('\n')
}

/**
 * Whole lines for a selection. A selection that ends at the start of a line
 * (a triple-click, or dragging to the next line) doesn't include that line.
 */
export function anchorLines(
  model: LineSource,
  selection: { startLineNumber: number; endLineNumber: number; endColumn: number },
): AnchorLines {
  const count = model.getLineCount()
  const startLine = Math.min(Math.max(selection.startLineNumber, 1), count)
  let endLine = Math.min(Math.max(selection.endLineNumber, startLine), count)
  if (endLine > startLine && selection.endColumn === 1) endLine--
  return {
    startLine,
    endLine,
    snippet: joinLines(model, startLine, endLine),
    before: joinLines(model, Math.max(1, startLine - CONTEXT_LINES), startLine - 1),
    after: joinLines(model, endLine + 1, Math.min(count, endLine + CONTEXT_LINES)),
  }
}

const SHA = /^[0-9a-f]{7,40}$/

/**
 * Where a Discuss with Agent comment would anchor a thread, or null when it
 * can't anchor one and goes to the agent the old way: a file outside the
 * session's worktree, the old side of a diff, or a diff with no single commit
 * (branch changes).
 */
export function threadAnchorFor(
  ctx: AgentContext,
  sessionWorktree: string,
): { worktreePath: string; anchor: ThreadAnchor } | null {
  if (ctx.kind === 'editor') {
    const root = sessionWorktree.replace(/\/+$/, '')
    if (!root || !ctx.filePath.startsWith(`${root}/`)) return null
    return { worktreePath: root, anchor: { path: ctx.filePath.slice(root.length + 1), ...ctx.lines, context: 'file' } }
  }
  if (ctx.kind === 'diff') {
    if (ctx.side !== 'modified' || !ctx.worktreePath) return null
    const commit = ctx.commitHash === null ? 'uncommitted' : SHA.test(ctx.commitHash) ? ctx.commitHash : null
    if (!commit) return null
    return { worktreePath: ctx.worktreePath, anchor: { path: ctx.filePath, ...ctx.lines, context: { commit } } }
  }
  return null
}
