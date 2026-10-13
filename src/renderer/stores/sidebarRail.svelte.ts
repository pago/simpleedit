/**
 * The collapsed sidebar (an icon rail) and the section overlay it opens over
 * the main area. Hovering previews a section's list; a click, a keyboard
 * shortcut or any interaction inside the overlay pins it until Esc, an outside
 * click or choosing an item.
 */
import { uiView, type UiView } from './uiView.svelte'
import { loadSidebarCollapsed, saveSidebarCollapsed } from '../lib/sidebarCollapse'

export const HOVER_OPEN_MS = 150
export const HOVER_CLOSE_MS = 300

export interface RailOverlay {
  view: UiView
  pinned: boolean
  /** Opened by click or keyboard, so focus moves into it. */
  focus: boolean
  /** Bumped on every open or section switch: what was on screen then is the baseline for "an item was chosen". */
  generation: number
}

let _collapsed = $state(loadSidebarCollapsed())
let _overlay = $state<RailOverlay | null>(null)
let generation = 0
let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined

function cancelTimers(): void {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  openTimer = closeTimer = undefined
}

function open(view: UiView, pinned: boolean, focus: boolean): void {
  cancelTimers()
  _overlay = { view, pinned, focus, generation: ++generation }
}

export const sidebarRail = {
  collapsed(): boolean {
    return _collapsed
  },
  setCollapsed(collapsed: boolean): void {
    _collapsed = collapsed
    saveSidebarCollapsed(collapsed)
    if (!collapsed) this.close()
  },
  toggleCollapsed(): void {
    this.setCollapsed(!_collapsed)
  },

  overlay(): RailOverlay | null {
    return _overlay
  },

  /** The pointer reached a section icon: preview it after a short pause, or at once while one is previewed. */
  hoverIcon(view: UiView): void {
    clearTimeout(openTimer)
    if (_overlay?.pinned) return
    if (_overlay) {
      if (_overlay.view !== view) open(view, false, false)
      return
    }
    openTimer = setTimeout(() => open(view, false, false), HOVER_OPEN_MS)
  },
  /** Passing over an icon without pausing opens nothing. */
  leaveIcon(): void {
    clearTimeout(openTimer)
  },
  /** The pointer is over the rail or the overlay. */
  enterZone(): void {
    clearTimeout(closeTimer)
  },
  leaveZone(): void {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    if (_overlay && !_overlay.pinned) closeTimer = setTimeout(() => this.close(), HOVER_CLOSE_MS)
  },

  /** A click on an icon: pins its section, or closes it if it is already pinned. */
  clickIcon(view: UiView): void {
    if (_overlay?.view === view && _overlay.pinned) this.close()
    else open(view, true, true)
  },
  /** ⌘1–3 and the palette's "Show …": switch the view, and while collapsed show its list too. */
  showSection(view: UiView): void {
    uiView.show(view)
    if (_collapsed) open(view, true, true)
  },
  /** Working inside the overlay (a click, a drag, keyboard focus) keeps it open. */
  pin(): void {
    if (!_overlay || _overlay.pinned) return
    clearTimeout(closeTimer)
    _overlay = { ..._overlay, pinned: true }
  },
  close(): void {
    cancelTimers()
    _overlay = null
  },
}

export function _resetSidebarRailForTests(collapsed = false): void {
  cancelTimers()
  _collapsed = collapsed
  _overlay = null
}
