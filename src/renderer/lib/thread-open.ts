import type { AgentThread } from '../../shared/agent-threads'
import { tabIdFor } from '../stores/tabsStore.svelte'

/**
 * Where clicking a thread in the panel takes you.
 * - `panel`: an orphaned thread has no line (its stored one now holds other
 *   code), so its file opens and the panel shows the thread.
 * - `diff`: a commit's thread, in that commit's diff.
 * - `file`: any other thread, in the working copy at its line.
 *
 * `inline` asks the editor that loads `tabId` to show the thread inline; only
 * an open thread has a glyph to show it at.
 */
export type ThreadOpen =
  | { kind: 'panel'; path: string }
  | { kind: 'diff'; commit: string; tabId: string; inline: boolean }
  | { kind: 'file'; path: string; line: number; tabId: string; inline: boolean }

export function threadOpenFor(thread: AgentThread): ThreadOpen {
  const root = thread.worktreePath.replace(/\/+$/, '')
  const path = `${root}/${thread.anchor.path}`
  if (thread.anchor.orphaned) return { kind: 'panel', path }
  const inline = thread.status === 'open'
  const ctx = thread.anchor.context
  if (ctx !== 'file' && ctx.commit !== 'uncommitted') {
    return { kind: 'diff', commit: ctx.commit, tabId: tabIdFor({ kind: 'diff', worktreePath: thread.worktreePath, commitHash: ctx.commit }), inline }
  }
  return { kind: 'file', path, line: thread.anchor.startLine, tabId: tabIdFor({ kind: 'file', path }), inline }
}
