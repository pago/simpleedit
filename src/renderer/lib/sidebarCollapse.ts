/** The collapsed sidebar: a rail of section icons, this wide. */
export const SIDEBAR_RAIL_WIDTH = 40

const KEY = 'simpleedit:sidebarCollapsed'

type FlagStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadSidebarCollapsed(storage?: FlagStorage): boolean {
  try {
    return (storage ?? localStorage).getItem(KEY) === '1'
  } catch {
    // Storage can be unavailable; the full sidebar is the safe default.
    return false
  }
}

export function saveSidebarCollapsed(collapsed: boolean, storage?: FlagStorage): void {
  try {
    ;(storage ?? localStorage).setItem(KEY, collapsed ? '1' : '0')
  } catch {
    // Not remembered this time; the state still applies until reload.
  }
}

/**
 * ⌘B on macOS, Ctrl+B elsewhere. Ctrl+B is never taken on macOS (readline and
 * Monaco's emacs-style cursor-left), and never from a focused terminal, where
 * it is readline's backward-char and tmux's default prefix.
 */
export function isToggleSidebarShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  mac: boolean,
  inTerminal: boolean,
): boolean {
  if (e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return false
  if (mac) return e.metaKey && !e.ctrlKey
  return e.ctrlKey && !e.metaKey && !inTerminal
}
