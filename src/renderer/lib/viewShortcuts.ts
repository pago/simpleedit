import type { UiView } from '../stores/uiView.svelte'

const BY_DIGIT: Record<string, UiView> = { '1': 'workspace', '2': 'backlog', '3': 'screenprs' }

/** ⌘1/⌘2/⌘3 (Ctrl elsewhere, like ⌘T): the sidebar section to open, or null. */
export function viewForShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): UiView | null {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return null
  return BY_DIGIT[e.key] ?? null
}
