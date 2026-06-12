import { describe, it, expect, beforeEach } from 'vitest'
import {
  tabsStore,
  tabIdFor,
  type DiffTab,
  type FileTab,
  type PlanTab,
  type TourTab,
} from '../tabsStore.svelte'

const W = '/repo/worktree-a'
const W2 = '/repo/worktree-b'

function fileTab(path: string): FileTab {
  return { kind: 'file', id: tabIdFor({ kind: 'file', path }), path, modified: false }
}

function diffTab(hash: string | null, message = 'x'): DiffTab {
  return {
    kind: 'diff',
    id: tabIdFor({ kind: 'diff', worktreePath: W, commitHash: hash }),
    worktreePath: W,
    commitHash: hash,
    commitMessage: message,
  }
}

function tourTab(hash: string | null, message = 'x'): TourTab {
  return {
    kind: 'tour',
    id: tabIdFor({ kind: 'tour', worktreePath: W, commitHash: hash }),
    worktreePath: W,
    commitHash: hash,
    commitMessage: message,
  }
}

function planTab(planHash: string, label = 'Plan'): PlanTab {
  return {
    kind: 'plan',
    id: tabIdFor({ kind: 'plan', planHash }),
    worktreePath: W,
    planHash,
    label,
    claudeTerminalId: null,
  }
}

beforeEach(() => {
  tabsStore.closeAll(W)
  tabsStore.closeAll(W2)
})

describe('tabIdFor', () => {
  it('derives stable ids per kind + content identity', () => {
    expect(tabIdFor({ kind: 'file', path: '/x/y.ts' })).toBe('file:/x/y.ts')
    expect(tabIdFor({ kind: 'diff', worktreePath: W, commitHash: null })).toBe(`diff:${W}:staging`)
    expect(tabIdFor({ kind: 'diff', worktreePath: W, commitHash: 'abc' })).toBe(`diff:${W}:abc`)
    expect(tabIdFor({ kind: 'tour', worktreePath: W, commitHash: null })).toBe(`tour:${W}:staging`)
    expect(tabIdFor({ kind: 'plan', planHash: 'user-plan' })).toBe('plan:user-plan')
    expect(tabIdFor({ kind: 'composed', id: 'foo' })).toBe('composed:foo')
  })

  it('produces different ids for different kinds with the same key', () => {
    expect(tabIdFor({ kind: 'diff', worktreePath: W, commitHash: 'abc' })).not.toBe(
      tabIdFor({ kind: 'tour', worktreePath: W, commitHash: 'abc' }),
    )
  })

  it('produces different diff ids for the same commit in different worktrees', () => {
    expect(tabIdFor({ kind: 'diff', worktreePath: W, commitHash: 'abc' })).not.toBe(
      tabIdFor({ kind: 'diff', worktreePath: W2, commitHash: 'abc' }),
    )
  })
})

describe('open / focus', () => {
  it('opens a tab and focuses it by default', () => {
    const t = fileTab('/w/a.ts')
    tabsStore.open(W, t)
    expect(tabsStore.list(W)).toHaveLength(1)
    expect(tabsStore.activeId(W)).toBe(t.id)
  })

  it('re-opening the same content focuses the existing tab, no duplicate', () => {
    const t1 = fileTab('/w/a.ts')
    const t2 = fileTab('/w/b.ts')
    tabsStore.open(W, t1)
    tabsStore.open(W, t2)
    tabsStore.open(W, fileTab('/w/a.ts'))
    expect(tabsStore.list(W)).toHaveLength(2)
    expect(tabsStore.activeId(W)).toBe(t1.id)
  })

  it('focus on an unknown id is a no-op', () => {
    tabsStore.open(W, fileTab('/w/a.ts'))
    tabsStore.focus(W, 'file:/does/not/exist')
    expect(tabsStore.activeId(W)).toBe('file:/w/a.ts')
  })

  it('scopes are per-worktree', () => {
    tabsStore.open(W, fileTab('/w/a.ts'))
    expect(tabsStore.list(W2)).toHaveLength(0)
    tabsStore.open(W2, fileTab('/w/z.ts'))
    expect(tabsStore.list(W)).toHaveLength(1)
    expect(tabsStore.list(W2)).toHaveLength(1)
  })
})

describe('close + MRU focus', () => {
  it('closing the active tab focuses the most-recently-active remaining tab', () => {
    const a = fileTab('/w/a.ts')
    const b = fileTab('/w/b.ts')
    const c = fileTab('/w/c.ts')
    tabsStore.open(W, a)
    tabsStore.open(W, b)
    tabsStore.open(W, c)
    // MRU now: c,b,a
    tabsStore.focus(W, a.id) // MRU: a,c,b
    tabsStore.focus(W, b.id) // MRU: b,a,c — active=b
    tabsStore.close(W, b.id)
    expect(tabsStore.activeId(W)).toBe(a.id)
  })

  it('closing a non-active tab does not shift focus', () => {
    const a = fileTab('/w/a.ts')
    const b = fileTab('/w/b.ts')
    tabsStore.open(W, a)
    tabsStore.open(W, b)
    tabsStore.focus(W, a.id)
    tabsStore.close(W, b.id)
    expect(tabsStore.activeId(W)).toBe(a.id)
    expect(tabsStore.list(W)).toHaveLength(1)
  })

  it('closing the last tab leaves activeId null', () => {
    const a = fileTab('/w/a.ts')
    tabsStore.open(W, a)
    tabsStore.close(W, a.id)
    expect(tabsStore.activeId(W)).toBeNull()
    expect(tabsStore.list(W)).toHaveLength(0)
  })

  it('close is a no-op for unknown ids', () => {
    tabsStore.open(W, fileTab('/w/a.ts'))
    tabsStore.close(W, 'file:/ghost')
    expect(tabsStore.list(W)).toHaveLength(1)
  })

  it('closing the active tab falls back to a neighbor when MRU is empty but tabs remain', () => {
    // Repro: after background-opening B alongside active A, MRU only holds A.
    // Closing A leaves MRU empty but B is still a visible tab.
    const a = fileTab('/w/a.ts')
    const b = fileTab('/w/b.ts')
    tabsStore.open(W, a) // active=a, mru=[a]
    tabsStore.open(W, b, { focus: 'background' }) // b added, mru=[a], active=a, b unread
    tabsStore.close(W, a.id)
    expect(tabsStore.list(W)).toHaveLength(1)
    expect(tabsStore.activeId(W)).toBe(b.id)
  })
})

describe('peek mode', () => {
  it('opening a peekable tab with peek=true marks it peek', () => {
    const d = diffTab('abc')
    tabsStore.open(W, d, { peek: true })
    expect(tabsStore.isPeek(W, d.id)).toBe(true)
    expect(tabsStore.peekId(W)).toBe(d.id)
  })

  it('a new peek tab replaces the existing peek tab in place', () => {
    const d1 = diffTab('aaa')
    const d2 = diffTab('bbb')
    tabsStore.open(W, d1, { peek: true })
    tabsStore.open(W, d2, { peek: true })
    const list = tabsStore.list(W)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(d2.id)
    expect(tabsStore.peekId(W)).toBe(d2.id)
  })

  it('pinPeek clears the peek marker without removing the tab', () => {
    const d = diffTab('abc')
    tabsStore.open(W, d, { peek: true })
    tabsStore.pinPeek(W, d.id)
    expect(tabsStore.peekId(W)).toBeNull()
    expect(tabsStore.isPeek(W, d.id)).toBe(false)
    expect(tabsStore.list(W)).toHaveLength(1)
  })

  it('re-opening a peek tab (existing) pins it', () => {
    const d = diffTab('abc')
    tabsStore.open(W, d, { peek: true })
    tabsStore.open(W, diffTab('abc'))
    expect(tabsStore.peekId(W)).toBeNull()
  })

  it('tour and plan tabs are never peek even when peek=true is requested', () => {
    const t = tourTab('abc')
    const p = planTab('user-plan')
    tabsStore.open(W, t, { peek: true })
    tabsStore.open(W, p, { peek: true })
    expect(tabsStore.isPeek(W, t.id)).toBe(false)
    expect(tabsStore.isPeek(W, p.id)).toBe(false)
    expect(tabsStore.peekId(W)).toBeNull()
  })

  it('a non-peek open alongside a peek tab leaves the peek tab alone', () => {
    const peek = diffTab('aaa')
    const sticky = fileTab('/w/a.ts')
    tabsStore.open(W, peek, { peek: true })
    tabsStore.open(W, sticky) // sticky file tab
    expect(tabsStore.list(W)).toHaveLength(2)
    expect(tabsStore.peekId(W)).toBe(peek.id)
  })

  it('replacing the active peek prunes the old id from MRU so close-focus does not point to a ghost', () => {
    // Repro for the leak: when peek B replaces peek A, A's id used to linger in
    // MRU. Closing B then promoted A's ghost id to activeId, breaking the
    // paneIdle heuristic in WorktreePane.
    const a = diffTab('aaa')
    const b = diffTab('bbb')
    const c = diffTab('ccc')
    tabsStore.open(W, a, { peek: true })
    tabsStore.open(W, b, { peek: true })
    tabsStore.open(W, c, { peek: true })
    tabsStore.close(W, c.id)
    expect(tabsStore.list(W)).toHaveLength(0)
    expect(tabsStore.activeId(W)).toBeNull()
  })

  it('replacing a peek transfers active focus to the replacement', () => {
    // Active focus was on the peek being replaced. The slot stays focused.
    const a = diffTab('aaa')
    const b = diffTab('bbb')
    tabsStore.open(W, a, { peek: true })
    tabsStore.open(W, b, { peek: true, focus: 'background' })
    expect(tabsStore.activeId(W)).toBe(b.id)
  })

  it('replacing an unread peek alongside a sticky tab clears the unread for the gone id', () => {
    const sticky = fileTab('/w/a.ts')
    const d1 = diffTab('aaa')
    const d2 = diffTab('bbb')
    tabsStore.open(W, sticky)
    tabsStore.open(W, d1, { peek: true, focus: 'background' })
    expect(tabsStore.isUnread(W, d1.id)).toBe(true)
    tabsStore.open(W, d2, { peek: true, focus: 'background' })
    // d1 is gone — its unread flag should not persist.
    expect(tabsStore.isUnread(W, d1.id)).toBe(false)
    expect(tabsStore.isUnread(W, d2.id)).toBe(true)
    expect(tabsStore.activeId(W)).toBe(sticky.id)
  })

  it('combining { peek: true, focus: "background" } opens a new peek tab unread, without focus', () => {
    // Pane is non-empty (an already-focused file), so background open should
    // not steal focus. The tab still participates in peek — subsequent peek
    // opens replace it.
    const sticky = fileTab('/w/a.ts')
    tabsStore.open(W, sticky)
    const d1 = diffTab('aaa')
    tabsStore.open(W, d1, { peek: true, focus: 'background' })
    expect(tabsStore.list(W)).toHaveLength(2)
    expect(tabsStore.activeId(W)).toBe(sticky.id) // focus unchanged
    expect(tabsStore.isUnread(W, d1.id)).toBe(true)
    expect(tabsStore.peekId(W)).toBe(d1.id)

    // A second peek (also background) replaces the first in place.
    const d2 = diffTab('bbb')
    tabsStore.open(W, d2, { peek: true, focus: 'background' })
    expect(tabsStore.list(W)).toHaveLength(2) // sticky + d2, d1 replaced
    expect(tabsStore.peekId(W)).toBe(d2.id)
    expect(tabsStore.list(W).some((t) => t.id === d1.id)).toBe(false)
  })
})

describe('unread + background open', () => {
  it('background-opened tab in a non-empty pane is unread', () => {
    tabsStore.open(W, fileTab('/w/a.ts'))
    const t = tourTab('abc')
    tabsStore.open(W, t, { focus: 'background' })
    expect(tabsStore.isUnread(W, t.id)).toBe(true)
    expect(tabsStore.activeId(W)).toBe('file:/w/a.ts') // unchanged
  })

  it('background open into an empty pane auto-focuses and does not mark unread', () => {
    const t = tourTab('abc')
    tabsStore.open(W, t, { focus: 'background' })
    expect(tabsStore.activeId(W)).toBe(t.id)
    expect(tabsStore.isUnread(W, t.id)).toBe(false)
  })

  it('focusing an unread tab clears the unread marker', () => {
    tabsStore.open(W, fileTab('/w/a.ts'))
    const t = tourTab('abc')
    tabsStore.open(W, t, { focus: 'background' })
    tabsStore.focus(W, t.id)
    expect(tabsStore.isUnread(W, t.id)).toBe(false)
  })

  it('markUnread is a no-op for unknown ids', () => {
    tabsStore.markUnread(W, 'nope')
    expect(tabsStore.isUnread(W, 'nope')).toBe(false)
  })

  it('re-opening with focus=active clears any pre-existing unread marker', () => {
    tabsStore.open(W, fileTab('/w/a.ts'))
    const t = tourTab('abc')
    tabsStore.open(W, t, { focus: 'background' })
    expect(tabsStore.isUnread(W, t.id)).toBe(true)
    tabsStore.open(W, tourTab('abc'))
    expect(tabsStore.isUnread(W, t.id)).toBe(false)
  })

  it('clearUnread is safe for tabs that were never marked', () => {
    const a = fileTab('/w/a.ts')
    tabsStore.open(W, a)
    expect(() => tabsStore.clearUnread(W, a.id)).not.toThrow()
    expect(tabsStore.isUnread(W, a.id)).toBe(false)
  })
})

describe('setFileModified + reorder', () => {
  it('setFileModified updates a file tab without disturbing MRU', () => {
    const a = fileTab('/w/a.ts')
    const b = fileTab('/w/b.ts')
    tabsStore.open(W, a)
    tabsStore.open(W, b)
    tabsStore.setFileModified(W, a.id, true)
    const updated = tabsStore.list(W).find((t) => t.id === a.id) as FileTab
    expect(updated.modified).toBe(true)
    expect(tabsStore.activeId(W)).toBe(b.id)
  })

  it('setFileModified is a no-op for unknown ids', () => {
    tabsStore.open(W, fileTab('/w/a.ts'))
    expect(() => tabsStore.setFileModified(W, 'ghost', true)).not.toThrow()
  })

  it('setFileModified is a no-op for non-file tabs', () => {
    const d = diffTab('abc')
    tabsStore.open(W, d)
    tabsStore.setFileModified(W, d.id, true)
    const tab = tabsStore.list(W).find((t) => t.id === d.id)
    expect(tab?.kind).toBe('diff')
    expect(tab).not.toHaveProperty('modified')
  })

  it('reorder moves a tab within the list', () => {
    const a = fileTab('/w/a.ts')
    const b = fileTab('/w/b.ts')
    const c = fileTab('/w/c.ts')
    tabsStore.open(W, a)
    tabsStore.open(W, b)
    tabsStore.open(W, c)
    tabsStore.reorder(W, 0, 2)
    expect(tabsStore.list(W).map((t) => t.id)).toEqual([b.id, c.id, a.id])
  })

  it('reorder with equal indices or out-of-range is a no-op', () => {
    const a = fileTab('/w/a.ts')
    const b = fileTab('/w/b.ts')
    tabsStore.open(W, a)
    tabsStore.open(W, b)
    tabsStore.reorder(W, 1, 1)
    tabsStore.reorder(W, -1, 0)
    tabsStore.reorder(W, 0, 99)
    expect(tabsStore.list(W).map((t) => t.id)).toEqual([a.id, b.id])
  })
})
