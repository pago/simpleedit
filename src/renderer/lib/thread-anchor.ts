import type { ThreadAnchor } from '../../shared/agent-threads'
import type { AgentContext } from './agent-message'

export { anchorLines, type AnchorLines } from '../../shared/thread-anchor-lines'

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
