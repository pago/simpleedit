/**
 * Where the phone is, as data.
 *
 * Each tab owns a short stack. The bottom of every stack is the tab's list,
 * which is not an entry: an empty stack IS the list. Screens (a session, a PR)
 * sit on it, sub-views that Back should close (a commit's diff) sit on their
 * screen, and sheets and modals sit on top of all of it — so Back dismisses a
 * sheet exactly the way it leaves a screen.
 *
 * Everything here is a pure function of a `NavState`. The browser's history is
 * wired in `nav.svelte.ts`; the only thing this module knows about it is the
 * depth a `popstate` landed on, because that is the one fact the browser gives
 * us about what the user just did.
 */
import type { PrRef } from '../../shared/screenprs'

export type TabId = 'sessions' | 'prs'

export type NavLayer =
  | { kind: 'session'; terminalId: string; fromNotification: boolean }
  /** The Changes pane is showing one entry's diff rather than the log. */
  | { kind: 'changes-diff'; terminalId: string }
  | { kind: 'new-session' }
  | { kind: 'pr'; pr: PrRef }
  | { kind: 'compose'; url: string }
  | { kind: 'confirm-submit'; url: string }

export type NavEntry = NavLayer & {
  id: number
  /**
   * Asked before Back takes this entry away. True keeps it: the entry holds
   * something Back must not silently discard (and is now asking about it), or
   * it cannot be left at all right now.
   */
  hold?: () => boolean
}

export interface NavState {
  tab: TabId
  stacks: Readonly<Record<TabId, readonly NavEntry[]>>
  nextId: number
}

export function initialNav(tab: TabId = 'sessions'): NavState {
  return { tab, stacks: { sessions: [], prs: [] }, nextId: 1 }
}

export function stackOf(state: NavState, tab: TabId = state.tab): readonly NavEntry[] {
  return state.stacks[tab]
}

export function topOf(state: NavState, tab: TabId = state.tab): NavEntry | null {
  const stack = state.stacks[tab]
  return stack[stack.length - 1] ?? null
}

/** Sheets and modals: layers that cover a screen rather than replace it. */
export function isOverlay(entry: NavEntry | null): boolean {
  return entry !== null && (entry.kind === 'new-session' || entry.kind === 'compose' || entry.kind === 'confirm-submit')
}

/** The screen a tab is showing under any overlays, or null for its list. */
export function screenOf(state: NavState, tab: TabId = state.tab): NavEntry | null {
  const stack = state.stacks[tab]
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i]
    if (entry.kind === 'session' || entry.kind === 'pr') return entry
  }
  return null
}

function withStack(state: NavState, tab: TabId, stack: readonly NavEntry[]): NavState {
  return { ...state, stacks: { ...state.stacks, [tab]: stack } }
}

/** Always onto the active tab: nothing can be opened on a tab nobody is looking at. */
export function push(
  state: NavState,
  layer: NavLayer,
  hold?: () => boolean,
): { state: NavState; entry: NavEntry } {
  const entry: NavEntry = hold ? { ...layer, id: state.nextId, hold } : { ...layer, id: state.nextId }
  const next = withStack({ ...state, nextId: state.nextId + 1 }, state.tab, [...stackOf(state), entry])
  return { state: next, entry }
}

export function pop(state: NavState, count = 1): NavState {
  const stack = stackOf(state)
  return withStack(state, state.tab, stack.slice(0, Math.max(0, stack.length - count)))
}

/** Tabs keep their stacks; switching only changes which one is showing. */
export function selectTab(state: NavState, tab: TabId): NavState {
  return state.tab === tab ? state : { ...state, tab }
}

/** Drop entries wherever they are — a session that closed, a sheet that finished. */
export function removeWhere(state: NavState, doomed: (entry: NavEntry) => boolean): NavState {
  let next = state
  for (const tab of ['sessions', 'prs'] as const) {
    const stack = state.stacks[tab]
    const kept = stack.filter((entry) => !doomed(entry))
    if (kept.length !== stack.length) next = withStack(next, tab, kept)
  }
  return next
}

export function contains(state: NavState, id: number): boolean {
  return state.stacks.sessions.some((e) => e.id === id) || state.stacks.prs.some((e) => e.id === id)
}

/**
 * A notification tap: land on the session, on top of whatever was open.
 *
 * Pushed, never replaced, so Back returns to what the user was doing and every
 * draft underneath survives. A session that is already somewhere in the stack
 * is brought to the front as the SAME entry — its screen stays mounted, so its
 * terminal is not attached twice and its composer keeps what was typed — minus
 * any diff it had open, because the tap is about the terminal.
 */
export function openFromNotification(state: NavState, terminalId: string): NavState {
  const onSessions = selectTab(state, 'sessions')
  const stack = stackOf(onSessions)
  const existing = stack.find((e) => e.kind === 'session' && e.terminalId === terminalId)
  if (!existing) {
    return push(onSessions, { kind: 'session', terminalId, fromNotification: true }).state
  }
  const mine = (e: NavEntry): boolean =>
    (e.kind === 'session' || e.kind === 'changes-diff') && e.terminalId === terminalId
  const front: NavEntry = { ...existing, fromNotification: true } as NavEntry
  return withStack(onSessions, 'sessions', [...stack.filter((e) => !mine(e)), front])
}

/**
 * What a `popstate` means, given the depth it landed on.
 *
 * `depth` is how many of our entries the browser now says are above the base.
 * The active stack's length is how many there should be. Whatever the
 * difference, history is the witness and the stack is corrected to it — never
 * the reverse, because the browser has already moved.
 *
 *  - Equal: nothing happened that we did not already know about — a stale
 *    event, or the landing of a realignment we asked for.
 *  - Deeper than the stack: Forward, or entries left over from a reload. There
 *    is nothing to re-open (popped entries are gone), so history is walked back.
 *  - Shallower: Back. The entries above `depth` are popped — unless one of them
 *    holds, in which case the stack stays and history is re-pushed to match.
 *
 * `force` skips the holds: the entry itself already asked and was told yes.
 */
export type PopDecision =
  | { kind: 'ignore' }
  | { kind: 'realign' }
  | { kind: 'hold'; entry: NavEntry }
  | { kind: 'pop'; state: NavState }

export function decidePop(state: NavState, depth: number, force = false): PopDecision {
  const stack = stackOf(state)
  const target = Math.max(0, depth)
  if (target === stack.length) return { kind: 'ignore' }
  if (target > stack.length) return { kind: 'realign' }
  if (!force) {
    for (let i = stack.length - 1; i >= target; i--) {
      const entry = stack[i]
      if (entry.hold?.()) return { kind: 'hold', entry }
    }
  }
  return { kind: 'pop', state: pop(state, stack.length - target) }
}

/** What goes in `history.state`. Anything else found there reads as the base. */
export const DEPTH_KEY = 'pocketDepth'

export function depthOf(historyState: unknown): number {
  if (typeof historyState !== 'object' || historyState === null) return 0
  const depth = (historyState as Record<string, unknown>)[DEPTH_KEY]
  return typeof depth === 'number' && Number.isInteger(depth) && depth > 0 ? depth : 0
}

export function withDepth(historyState: unknown, depth: number): Record<string, unknown> {
  const base = typeof historyState === 'object' && historyState !== null ? historyState : {}
  return { ...(base as Record<string, unknown>), [DEPTH_KEY]: depth }
}
