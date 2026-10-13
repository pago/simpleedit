import type { UiView } from '../stores/uiView.svelte'

export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 500

/** Each section opens at the width its list had as a column of its own. */
export const SIDEBAR_DEFAULT_WIDTHS: Readonly<Record<UiView, number>> = {
  workspace: 260,
  backlog: 340,
  screenprs: 380,
}

const VIEWS = Object.keys(SIDEBAR_DEFAULT_WIDTHS) as UiView[]

type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>

function storageKey(view: UiView): string {
  return `simpleedit:sidebarWidth:${view}`
}

export function clampSidebarWidth(px: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(px)))
}

/** The remembered width per section; a missing, unreadable or junk value falls back to the default. */
export function loadSidebarWidths(storage?: WidthStorage): Record<UiView, number> {
  const widths = { ...SIDEBAR_DEFAULT_WIDTHS }
  for (const view of VIEWS) {
    try {
      const raw = (storage ?? localStorage).getItem(storageKey(view))
      const px = raw === null ? NaN : Number(raw)
      if (Number.isFinite(px)) widths[view] = clampSidebarWidth(px)
    } catch {
      // Storage can be unavailable; the default is a fine width.
    }
  }
  return widths
}

export function saveSidebarWidth(view: UiView, px: number, storage?: WidthStorage): void {
  try {
    const store = storage ?? localStorage
    store.setItem(storageKey(view), String(clampSidebarWidth(px)))
  } catch {
    // Not remembered this time; the width still applies until reload.
  }
}
