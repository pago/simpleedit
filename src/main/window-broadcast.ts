import { BrowserWindow, type WebContents } from 'electron'

/**
 * The WebContents of every window that can still receive a message.
 *
 * Checks the WebContents, not just the window: while a window's WebContents
 * fires `destroyed`, the window is still listed by `getAllWindows()` and its
 * own `isDestroyed()` is still false, but `send` on it throws "Object has been
 * destroyed". Anything that broadcasts from that teardown (closing a remote
 * socket emits a status change) would crash main.
 */
export function liveWindowContents(): WebContents[] {
  const out: WebContents[] = []
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    out.push(win.webContents)
  }
  return out
}

export function broadcastToWindows(channel: string, data: unknown): void {
  for (const wc of liveWindowContents()) wc.send(channel, data)
}

/**
 * Every live window as a phone may attach to it, with its repo.
 *
 * Built from `liveWindowContents`, not from `getAllWindows()` alone: a window
 * mid-teardown is still listed, and a phone reconnecting at that moment would
 * join a hub whose `closeSocketsForHub` has already run — a socket outliving
 * its window, which is exactly what that close exists to prevent.
 */
export function liveWindowCandidates(
  repoOf: (webContentsId: number) => string | null,
): { windowId: number; repoPath: string | null; focused: boolean }[] {
  const focused = BrowserWindow.getFocusedWindow()
  return liveWindowContents().map((wc) => ({
    windowId: wc.id,
    repoPath: repoOf(wc.id),
    focused: focused !== null && !focused.isDestroyed() && focused.webContents === wc,
  }))
}
