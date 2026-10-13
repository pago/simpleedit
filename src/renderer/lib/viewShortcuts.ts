import type { UiView } from '../stores/uiView.svelte'

const BY_DIGIT: Record<string, UiView> = { '1': 'workspace', '2': 'backlog', '3': 'screenprs' }

export const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

/**
 * ⌘1/⌘2/⌘3 on macOS, Ctrl elsewhere: the sidebar section to open, or null.
 * Not Ctrl on macOS: there Ctrl+digits belong to terminal programs (Ctrl+2 is ^@).
 */
export function viewForShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  mac: boolean,
): UiView | null {
  if (e.shiftKey || e.altKey) return null
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return null
  return BY_DIGIT[e.key] ?? null
}

/**
 * Sidebar shortcuts unmount the open section's body, and with it any modal it
 * opened (a hand-off brief, a rename, a review confirmation), so they wait
 * while one is open or something already handled the key.
 */
export function sidebarShortcutsBlocked(e: Pick<KeyboardEvent, 'defaultPrevented'>, doc: Document = document): boolean {
  return e.defaultPrevented || doc.querySelector('[aria-modal="true"]') !== null
}
