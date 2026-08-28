/**
 * The session list a window holds, as main sees it.
 *
 * The renderer owns this list — labels, provider, worktree and status live in
 * its stores and nothing in main can derive them — so it pushes the whole
 * thing whenever any part changes. Main keeps it *per window* and hands it to
 * whoever asks, which is what lets a second transport on that window's hub
 * (a phone) render the same list the sidebar does without reimplementing it.
 *
 * Deliberately per window, not global. `agent-bus`'s peer registry is one map
 * for the whole app because mail is addressed app-wide; a session list is
 * answering "what is on the screen I attached to", and two windows would
 * otherwise overwrite each other's answer on every keystroke-driven re-render.
 *
 * The one thing main adds is `statusSince`. A client can only stamp what it
 * has witnessed, so a phone connecting at 09:15 would show a session that
 * blocked at 08:50 as freshly blocked — and the length of that block is the
 * whole reason the list exists.
 */
import type { WindowSession, WindowSessionInput } from '../shared/ipc-types'

const byWindow = new Map<number, WindowSession[]>()

/** Everything except the derived stamp — what the renderer actually sent. */
function sameInput(a: WindowSession, b: WindowSessionInput): boolean {
  return (
    a.label === b.label &&
    a.kind === b.kind &&
    a.provider === b.provider &&
    a.worktreePath === b.worktreePath &&
    a.status === b.status
  )
}

/**
 * Replace a window's list, preserving each session's `statusSince` for as long
 * as its status is unchanged.
 *
 * Returns true when the list differs from the one already held, so the caller
 * can skip a fan-out. The renderer's push is driven by a reactive effect and
 * fires far more often than the list changes.
 */
export function syncWindowSessions(
  windowId: number,
  incoming: WindowSessionInput[],
  now: number = Date.now(),
): boolean {
  const previous = byWindow.get(windowId)
  const previousById = new Map((previous ?? []).map((s) => [s.terminalId, s]))

  const next: WindowSession[] = incoming.map((session) => {
    const before = previousById.get(session.terminalId)
    return {
      ...session,
      // A session main has never seen starts its clock now: the transition
      // that created it is the one we just witnessed.
      statusSince: before && before.status === session.status ? before.statusSince : now,
    }
  })

  const changed =
    previous === undefined ||
    previous.length !== next.length ||
    next.some((session, i) => previous[i].terminalId !== session.terminalId || !sameInput(previous[i], session))

  byWindow.set(windowId, next)
  return changed
}

export function getWindowSessions(windowId: number): WindowSession[] {
  return byWindow.get(windowId) ?? []
}

/** The window is gone; so is its list. Called from the window teardown. */
export function forgetWindowSessions(windowId: number): void {
  byWindow.delete(windowId)
}
