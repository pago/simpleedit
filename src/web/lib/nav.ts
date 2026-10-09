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

export type TabId = 'sessions' | 'prs' | 'backlog'

const TAB_IDS: readonly TabId[] = ['sessions', 'prs', 'backlog']

export type NavLayer =
  | {
      kind: 'session'
      terminalId: string
      fromNotification: boolean
      /**
       * A tap on a thread-reply notification: show this thread in the Threads
       * pane. A fresh object per tap, so a second tap on the same thread is
       * still a change the screen sees.
       */
      openThread?: { threadId: string }
    }
  /** The Changes pane is showing one entry's diff rather than the log. */
  | { kind: 'changes-diff'; terminalId: string }
  | { kind: 'new-session' }
  | { kind: 'pr'; pr: PrRef }
  | { kind: 'compose'; url: string }
  | { kind: 'confirm-submit'; url: string }
  /** Which of the Mac's projects (windows) the phone is attached to. */
  | { kind: 'projects' }
  /** Discuss with Agent's model picker, over the PR it discusses. */
  | { kind: 'discuss'; url: string }
  /** The backlog's add/edit sheet: an item's id, or null for a new one. */
  | { kind: 'backlog-item'; itemId: string | null }

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
  return { tab, stacks: { sessions: [], prs: [], backlog: [] }, nextId: 1 }
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
  return (
    entry !== null &&
    (entry.kind === 'new-session' ||
      entry.kind === 'compose' ||
      entry.kind === 'confirm-submit' ||
      entry.kind === 'projects' ||
      entry.kind === 'discuss' ||
      entry.kind === 'backlog-item')
  )
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

const otherTab = (tab: TabId): TabId => (tab === 'sessions' ? 'prs' : 'sessions')

const sessionOn = (state: NavState, tab: TabId, terminalId: string): NavEntry | undefined =>
  state.stacks[tab].find((e) => e.kind === 'session' && e.terminalId === terminalId)

/**
 * Show `tab` with this session's entry on top: the SAME entry, so its screen
 * stays mounted — its terminal is not attached twice and its composer keeps
 * what was typed — minus any diff it had open.
 */
function bringToFront(state: NavState, tab: TabId, existing: NavEntry, patch: Partial<NavLayer> = {}): NavState {
  const terminalId = existing.kind === 'session' ? existing.terminalId : ''
  const mine = (e: NavEntry): boolean =>
    (e.kind === 'session' || e.kind === 'changes-diff') && e.terminalId === terminalId
  const front = { ...existing, ...patch } as NavEntry
  return withStack(selectTab(state, tab), tab, [...state.stacks[tab].filter((e) => !mine(e)), front])
}

/** Always onto the active tab: nothing can be opened on a tab nobody is looking at. */
export function push(
  state: NavState,
  layer: NavLayer,
  hold?: () => boolean,
): { state: NavState; entry: NavEntry } {
  // A session's screen lives on one stack at a time. One opened from a PR sits
  // on the PR's stack so Back returns to the PR; asked for again from the
  // other tab, that tab is where it is shown.
  if (layer.kind === 'session') {
    const elsewhere = sessionOn(state, otherTab(state.tab), layer.terminalId)
    if (elsewhere) return { state: bringToFront(state, otherTab(state.tab), elsewhere), entry: elsewhere }
  }
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
  for (const tab of TAB_IDS) {
    const stack = state.stacks[tab]
    const kept = stack.filter((entry) => !doomed(entry))
    if (kept.length !== stack.length) next = withStack(next, tab, kept)
  }
  return next
}

/**
 * Empty one tab's stack, holds unasked. For when what it showed is gone — the
 * phone attached to another project, whose sessions are another window's.
 */
export function clearStack(state: NavState, tab: TabId): NavState {
  return state.stacks[tab].length === 0 ? state : withStack(state, tab, [])
}

/**
 * Everything that belongs to the window a phone is leaving: the Sessions tab,
 * and any session opened over a PR, which sits on the PRs tab but is still a
 * session of that window. The PRs themselves are not a window's and stay. The
 * Backlog tab is the PROJECT's, not the window's: it goes only when the
 * project does (the host decides, since only it knows the repo).
 */
export function leaveWindow(state: NavState): NavState {
  return removeWhere(clearStack(state, 'sessions'), (e) => e.kind === 'session' || e.kind === 'changes-diff')
}

export function contains(state: NavState, id: number): boolean {
  return TAB_IDS.some((tab) => state.stacks[tab].some((e) => e.id === id))
}

/**
 * A notification tap: land on the session, on top of whatever was open.
 *
 * Pushed, never replaced, so Back returns to what the user was doing and every
 * draft underneath survives. A session already open is brought to the front
 * as the SAME entry (`bringToFront`), minus any diff it had open, because the
 * tap is about the terminal (or, with `threadId`, about that thread) — on the
 * PRs tab when it was opened over a PR.
 */
export function openFromNotification(
  state: NavState,
  terminalId: string,
  hold?: (entry: NavEntry) => boolean,
  threadId?: string,
): NavState {
  const patch = { fromNotification: true, openThread: threadId ? { threadId } : undefined }
  const overPr = sessionOn(state, 'prs', terminalId)
  if (overPr) return bringToFront(state, 'prs', overPr, patch)
  const onSessions = selectTab(state, 'sessions')
  const existing = sessionOn(onSessions, 'sessions', terminalId)
  if (existing) return bringToFront(onSessions, 'sessions', existing, patch)
  const id = onSessions.nextId
  const layer: NavLayer = { kind: 'session', terminalId, ...patch }
  return push(onSessions, layer, hold && (() => hold({ ...layer, id }))).state
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

/**
 * Whether leaving a composer would lose something the user made.
 *
 * A recording counts even with an empty field: the words are in the audio and
 * not yet in the text, and leaving destroys the audio (it is never uploaded
 * for a screen nobody is on). So Back asks first, exactly as for typed text.
 *
 * When editing, `initial` is the text already saved: only a change to it is
 * at risk, so opening a comment and backing out does not ask.
 */
export function draftAtRisk(text: string, dictating: boolean, initial = ''): boolean {
  return dictating || text.trim() !== initial.trim()
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
