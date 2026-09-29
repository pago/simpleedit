/**
 * The navigation stack, bound to the browser's history.
 *
 * So that iOS swipe-back, Android's Back and a browser's Back close whatever
 * the phone is showing instead of leaving the app, every entry on the ACTIVE
 * tab's stack has a history entry, and `history.state` records its depth.
 *
 * ── The invariant ────────────────────────────────────────────────────────
 * History's depth follows the active tab's stack length. Every change goes
 * through `#sync`, which pushes entries or walks back until the two agree, and
 * every `popstate` is read by depth (`decidePop`) rather than assumed to be
 * "one Back" — so a stale event, a Forward, a long-press jump several entries
 * back, or leftovers from a reload all end with the two agreeing again.
 *
 * Consequences worth knowing:
 *
 *  - **Tab switches add no history.** iOS tab bars never do; Back walks the tab
 *    you are on and never switches tabs. Switching re-syncs history to the new
 *    tab's depth instead, which is why a switch can itself walk history.
 *  - **On-screen back buttons call `back()`, which is `history.back()`.** The
 *    stack is only ever popped by the resulting `popstate`, so there is one
 *    path out of a screen and it cannot drift from the browser's.
 *  - **A sheet that closes itself uses `close(id)`, not `back()`.** By the time
 *    it finishes (a post lands, a session starts) the active tab's top may be
 *    something a notification pushed since, and `back()` would close that.
 *
 * Unattached — in a component test, with no `PocketApp` — it is the same stack
 * without history, so a component that opens and closes a sheet through it
 * behaves identically.
 */
import {
  contains,
  decidePop,
  depthOf,
  initialNav,
  openFromNotification,
  push,
  removeWhere,
  screenOf,
  selectTab,
  stackOf,
  topOf,
  withDepth,
  type NavEntry,
  type NavLayer,
  type NavState,
  type TabId,
} from './nav'

class Nav {
  #state = $state.raw<NavState>(initialNav())
  #win: Window | null = null
  /** Where the browser's history is, in our entries above the base. */
  #depth = 0
  /** A `history.go` of ours is in flight; its `popstate` is not the user's. */
  #walking = false

  get tab(): TabId {
    return this.#state.tab
  }
  get state(): NavState {
    return this.#state
  }
  stack(tab?: TabId): readonly NavEntry[] {
    return stackOf(this.#state, tab)
  }
  top(tab?: TabId): NavEntry | null {
    return topOf(this.#state, tab)
  }
  screen(tab?: TabId): NavEntry | null {
    return screenOf(this.#state, tab)
  }
  has(id: number | null): boolean {
    return id !== null && contains(this.#state, id)
  }

  push(layer: NavLayer, hold?: () => boolean): NavEntry {
    const next = push(this.#state, layer, hold)
    this.#state = next.state
    this.#sync()
    return next.entry
  }

  selectTab(tab: TabId): void {
    this.#state = selectTab(this.#state, tab)
    this.#sync()
  }

  openFromNotification(terminalId: string): void {
    this.#state = openFromNotification(this.#state, terminalId)
    this.#sync()
  }

  removeWhere(doomed: (entry: NavEntry) => boolean): void {
    this.#state = removeWhere(this.#state, doomed)
    this.#sync()
  }

  /** Out of whatever the active tab is showing — exactly as the browser's Back. */
  back(): void {
    const win = this.#win
    if (win && this.#depth > 0 && !this.#walking) {
      win.history.back()
      return
    }
    const decision = decidePop(this.#state, stackOf(this.#state).length - 1)
    if (decision.kind === 'pop') this.#state = decision.state
    this.#sync()
  }

  /**
   * Take one entry away because it finished or its own confirm was answered —
   * no hold is asked. Removed by id wherever it is, then history is walked to
   * match, so nothing that was pushed on top since is closed in its place.
   */
  close(id: number | null): void {
    if (id === null || !contains(this.#state, id)) return
    this.removeWhere((entry) => entry.id === id)
  }

  /**
   * Bind to a window's history. Returns the unbind.
   *
   * A reload keeps the history entries above us, and the app lands on the list
   * whatever they said — so history is first walked back to the base, where
   * the next push truncates them.
   */
  attach(win: Window = window): () => void {
    this.#win = win
    const start = depthOf(win.history.state)
    win.history.replaceState(withDepth(win.history.state, start), '')
    this.#depth = start
    const onPop = (event: PopStateEvent): void => this.#onPop(event)
    win.addEventListener('popstate', onPop)
    this.#sync()
    return () => {
      win.removeEventListener('popstate', onPop)
      if (this.#win === win) this.#win = null
      this.#walking = false
    }
  }

  /** Back to an empty, unattached stack. For tests. */
  reset(): void {
    this.#state = initialNav()
    this.#depth = 0
    this.#walking = false
  }

  #onPop(event: PopStateEvent): void {
    this.#depth = depthOf(event.state)
    if (this.#walking) {
      this.#walking = false
      this.#sync()
      return
    }
    const decision = decidePop(this.#state, this.#depth)
    if (decision.kind === 'pop') this.#state = decision.state
    // `hold` and `realign` are both answered by the sync: re-push the entry
    // that held, or walk back past entries the stack no longer has.
    this.#sync()
  }

  #sync(): void {
    const win = this.#win
    if (!win || this.#walking) return
    const want = stackOf(this.#state).length
    while (this.#depth < want) {
      this.#depth++
      win.history.pushState(withDepth(win.history.state, this.#depth), '')
    }
    if (this.#depth > want) {
      this.#walking = true
      win.history.go(want - this.#depth)
    }
  }
}

export const nav = new Nav()
