/**
 * Unsent thread comments on the phone's session diff, per line, and the line
 * whose composer is open in each diff.
 *
 * Module state rather than `SessionDiff`'s own: the Changes pane unmounts the
 * diff on every reload, retry and Back, and typed text must outlive that. It
 * is phone-local and in memory — the desktop keeps its own drafts.
 */
import { SvelteMap } from 'svelte/reactivity'
import type { DiffView } from './diff-threads'

/** One diff of one session: its worktree and what it is the new side of. */
export function diffKey(sessionId: string, view: DiffView): string {
  return [sessionId, view.worktreePath.replace(/\/+$/, ''), view.commit].join('\u0000')
}

export interface DraftLine {
  path: string
  line: number
}

const lineKey = (diff: string, at: DraftLine): string => [diff, at.path, at.line].join('\u0000')

const drafts = new SvelteMap<string, string>()
const open = new SvelteMap<string, DraftLine>()

export const threadDrafts = {
  get(diff: string, at: DraftLine): string {
    return drafts.get(lineKey(diff, at)) ?? ''
  },
  /** Empty text forgets the line's draft. */
  set(diff: string, at: DraftLine, text: string): void {
    if (text) drafts.set(lineKey(diff, at), text)
    else drafts.delete(lineKey(diff, at))
  },
  /** The line whose composer is open in `diff`, if any. */
  openLine(diff: string): DraftLine | null {
    return open.get(diff) ?? null
  },
  setOpenLine(diff: string, at: DraftLine | null): void {
    if (at) open.set(diff, at)
    else open.delete(diff)
  },
}

export function _resetThreadDraftsForTests(): void {
  drafts.clear()
  open.clear()
}
