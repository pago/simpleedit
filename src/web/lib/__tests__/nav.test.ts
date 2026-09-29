import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  decidePop,
  depthOf,
  initialNav,
  isOverlay,
  openFromNotification,
  pop,
  push,
  removeWhere,
  screenOf,
  selectTab,
  stackOf,
  topOf,
  withDepth,
  type NavLayer,
  type NavState,
} from '../nav'
import { nav } from '../nav.svelte'
import type { PrRef } from '../../../shared/screenprs'

const PR: PrRef = {
  owner: 'acme',
  repo: 'acme/widgets',
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  title: 'Tighten the gate',
  author: 'dana',
  updatedAt: '2026-08-01T00:00:00Z',
}

const session = (terminalId: string): NavLayer => ({ kind: 'session', terminalId, fromNotification: false })

function build(...layers: NavLayer[]): NavState {
  let state = initialNav()
  for (const layer of layers) state = push(state, layer).state
  return state
}

describe('the stack', () => {
  it('pushes onto and pops off the active tab only', () => {
    let state = build(session('a'), { kind: 'changes-diff', terminalId: 'a' })
    expect(stackOf(state).map((e) => e.kind)).toEqual(['session', 'changes-diff'])
    state = pop(state)
    expect(topOf(state)).toMatchObject({ kind: 'session', terminalId: 'a' })
    state = pop(pop(state))
    expect(stackOf(state)).toEqual([])
  })

  it('keeps each tab\'s stack across a switch', () => {
    let state = build(session('a'))
    state = selectTab(state, 'prs')
    state = push(state, { kind: 'pr', pr: PR }).state
    expect(stackOf(state, 'sessions').map((e) => e.kind)).toEqual(['session'])
    state = pop(selectTab(state, 'sessions'))
    // Popping Sessions leaves the PR open on its own tab.
    expect(stackOf(state, 'sessions')).toEqual([])
    expect(topOf(state, 'prs')).toMatchObject({ kind: 'pr' })
  })

  it('names the screen under an overlay', () => {
    const state = build({ kind: 'new-session' })
    expect(isOverlay(topOf(state))).toBe(true)
    expect(screenOf(state)).toBeNull()
    const withPr = push(selectTab(state, 'prs'), { kind: 'pr', pr: PR }).state
    const composing = push(withPr, { kind: 'compose', url: PR.url }).state
    expect(screenOf(composing)).toMatchObject({ kind: 'pr' })
  })

  it('removes a closed session and its diff wherever they sit', () => {
    const state = build(session('a'), { kind: 'changes-diff', terminalId: 'a' }, session('b'))
    const next = removeWhere(state, (e) => 'terminalId' in e && e.terminalId === 'a')
    expect(stackOf(next).map((e) => e.kind === 'session' && e.terminalId)).toEqual(['b'])
  })
})

describe('a notification tap', () => {
  it('switches to Sessions and pushes the session on top of what was open', () => {
    let state = build(session('a'), { kind: 'changes-diff', terminalId: 'a' })
    state = push(selectTab(state, 'prs'), { kind: 'pr', pr: PR }).state
    state = openFromNotification(state, 'b')
    expect(state.tab).toBe('sessions')
    expect(stackOf(state).map((e) => e.kind)).toEqual(['session', 'changes-diff', 'session'])
    expect(topOf(state)).toMatchObject({ terminalId: 'b', fromNotification: true })
    // The PR tab is untouched.
    expect(topOf(state, 'prs')).toMatchObject({ kind: 'pr' })
  })

  it('covers an open new-session sheet rather than closing it', () => {
    const state = openFromNotification(build({ kind: 'new-session' }), 'b')
    expect(stackOf(state).map((e) => e.kind)).toEqual(['new-session', 'session'])
  })

  it('brings a session already in the stack to the front as the same entry', () => {
    const before = build(session('a'), { kind: 'changes-diff', terminalId: 'a' }, session('b'))
    const a = stackOf(before)[0]
    const state = openFromNotification(before, 'a')
    expect(stackOf(state).map((e) => e.kind === 'session' && e.terminalId)).toEqual(['b', 'a'])
    expect(topOf(state)?.id).toBe(a.id)
    expect(topOf(state)).toMatchObject({ fromNotification: true })
  })
})

describe('a popstate', () => {
  it('pops what Back left', () => {
    const state = build(session('a'), { kind: 'changes-diff', terminalId: 'a' })
    const decision = decidePop(state, 1)
    expect(decision.kind).toBe('pop')
    if (decision.kind === 'pop') expect(stackOf(decision.state).map((e) => e.kind)).toEqual(['session'])
  })

  it('pops several entries for a jump several back', () => {
    const decision = decidePop(build(session('a'), session('b'), session('c')), 0)
    expect(decision.kind === 'pop' && stackOf(decision.state)).toEqual([])
  })

  it('ignores one that lands where the stack already is', () => {
    expect(decidePop(build(session('a')), 1)).toEqual({ kind: 'ignore' })
    expect(decidePop(initialNav(), 0)).toEqual({ kind: 'ignore' })
  })

  it('walks history back when it is ahead of the stack', () => {
    expect(decidePop(build(session('a')), 3)).toEqual({ kind: 'realign' })
  })

  it('keeps an entry whose draft would be discarded, and asks it to confirm', () => {
    const hold = vi.fn(() => true)
    const state = push(initialNav(), { kind: 'new-session' }, hold).state
    const decision = decidePop(state, 0)
    expect(decision.kind).toBe('hold')
    expect(hold).toHaveBeenCalledOnce()
  })

  it('lets a clean entry go, and never asks one that stays', () => {
    const stays = vi.fn(() => true)
    const clean = vi.fn(() => false)
    let state = push(initialNav(), session('a'), stays).state
    state = push(state, { kind: 'new-session' }, clean).state
    expect(decidePop(state, 1).kind).toBe('pop')
    expect(clean).toHaveBeenCalledOnce()
    expect(stays).not.toHaveBeenCalled()
  })

  it('skips the holds when forced', () => {
    const hold = vi.fn(() => true)
    const state = push(initialNav(), { kind: 'new-session' }, hold).state
    expect(decidePop(state, 0, true).kind).toBe('pop')
    expect(hold).not.toHaveBeenCalled()
  })
})

describe('history.state', () => {
  it('reads anything that is not ours as the base', () => {
    expect(depthOf(null)).toBe(0)
    expect(depthOf({ other: 1 })).toBe(0)
    expect(depthOf({ pocketDepth: -2 })).toBe(0)
    expect(depthOf({ pocketDepth: 1.5 })).toBe(0)
    expect(depthOf(withDepth({ other: 1 }, 3))).toBe(3)
    expect(withDepth({ other: 1 }, 3)).toEqual({ other: 1, pocketDepth: 3 })
  })
})

/**
 * A browser history, with `popstate` delivered asynchronously the way a real
 * one delivers it — the gap is where a stack and a history drift apart.
 */
class FakeWindow extends EventTarget {
  entries: unknown[] = [null]
  index = 0
  readonly history = {
    state: null as unknown,
    pushState: (state: unknown): void => {
      this.entries = [...this.entries.slice(0, this.index + 1), state]
      this.index++
      this.history.state = state
    },
    replaceState: (state: unknown): void => {
      this.entries[this.index] = state
      this.history.state = state
    },
    back: (): void => this.history.go(-1),
    go: (delta: number): void => {
      queueMicrotask(() => {
        const next = Math.min(this.entries.length - 1, Math.max(0, this.index + delta))
        if (next === this.index) return
        this.index = next
        this.history.state = this.entries[next]
        this.dispatchEvent(new PopStateEvent('popstate', { state: this.entries[next] }))
      })
    },
  }
  depth(): number {
    return depthOf(this.history.state)
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the history binding', () => {
  let win: FakeWindow
  let detach: () => void

  beforeEach(() => {
    nav.reset()
    win = new FakeWindow()
    detach = nav.attach(win as unknown as Window)
  })
  afterEach(() => detach())

  it('gives every pushed entry a history entry, and Back pops it', async () => {
    nav.push(session('a'))
    nav.push({ kind: 'changes-diff', terminalId: 'a' })
    expect(win.depth()).toBe(2)

    win.history.back()
    await settle()
    expect(nav.stack().map((e) => e.kind)).toEqual(['session'])
    expect(win.depth()).toBe(1)
  })

  it('pops only through history when an on-screen back is tapped', async () => {
    nav.push(session('a'))
    nav.back()
    // Nothing moves until the browser has.
    expect(nav.stack()).toHaveLength(1)
    await settle()
    expect(nav.stack()).toEqual([])
    expect(win.depth()).toBe(0)
  })

  it('re-pushes a held entry, so the next Back asks again', async () => {
    let dirty = true
    const hold = vi.fn(() => dirty)
    const sheet = nav.push({ kind: 'new-session' }, hold)
    win.history.back()
    await settle()
    expect(nav.top()?.id).toBe(sheet.id)
    expect(win.depth()).toBe(1)

    dirty = false
    win.history.back()
    await settle()
    expect(nav.stack()).toEqual([])
  })

  it('closes a finished sheet by id, not whatever is on top', async () => {
    const sheet = nav.push({ kind: 'new-session' }, () => true)
    nav.openFromNotification('b')
    nav.close(sheet.id)
    await settle()
    expect(nav.stack().map((e) => e.kind)).toEqual(['session'])
    expect(win.depth()).toBe(1)
  })

  it('does not push history for a tab switch, and follows the new tab\'s depth', async () => {
    nav.push(session('a'))
    nav.push(session('b'))
    nav.selectTab('prs')
    await settle()
    expect(win.depth()).toBe(0)
    // Back from the PR list is not a way into the Sessions tab.
    expect(nav.stack('sessions')).toHaveLength(2)

    nav.selectTab('sessions')
    expect(win.depth()).toBe(2)
    win.history.back()
    await settle()
    expect(nav.stack().map((e) => e.kind === 'session' && e.terminalId)).toEqual(['a'])
  })

  it('treats a realignment\'s own popstate as ours, not as a Back', async () => {
    nav.push(session('a'))
    nav.push(session('b'))
    nav.selectTab('prs')
    // Pushed while the walk back to depth 0 is still in flight.
    nav.push({ kind: 'pr', pr: PR })
    await settle()
    expect(nav.stack().map((e) => e.kind)).toEqual(['pr'])
    expect(win.depth()).toBe(1)
  })

  it('walks back over a Forward instead of reopening what was popped', async () => {
    nav.push(session('a'))
    win.history.back()
    await settle()
    win.history.go(1)
    await settle()
    await settle()
    expect(nav.stack()).toEqual([])
    expect(win.depth()).toBe(0)
  })

  it('ignores a stale popstate at the depth it already has', async () => {
    nav.push(session('a'))
    win.dispatchEvent(new PopStateEvent('popstate', { state: withDepth(null, 1) }))
    await settle()
    expect(nav.stack()).toHaveLength(1)
  })

  it('walks a reloaded page back to the base its list is at', async () => {
    detach()
    nav.reset()
    const reloaded = new FakeWindow()
    reloaded.entries = [withDepth(null, 0), withDepth(null, 1), withDepth(null, 2)]
    reloaded.index = 2
    reloaded.history.state = reloaded.entries[2]
    detach = nav.attach(reloaded as unknown as Window)
    await settle()
    expect(reloaded.depth()).toBe(0)
    nav.push(session('a'))
    // The push truncated the leftovers.
    expect(reloaded.entries).toHaveLength(2)
  })
})
