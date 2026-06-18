import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SerializedSession, WorktreeInfo } from '../../../shared/ipc-types'
import { sessionsStore } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'
import { serializeSession, hydrateSession } from '../../lib/sessionPersistence'

const PRIMARY = '/repo/primary.git'
const MAIN_WT = '/repo/primary/main'

const LISTS: Record<string, WorktreeInfo[]> = {
  [PRIMARY]: [
    { path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false },
    { path: '/repo/primary/feat', branch: 'feat', isMain: false, isCurrent: false },
  ],
}

beforeEach(async () => {
  ;(window as unknown as { api: { invoke: unknown } }).api = {
    invoke: vi.fn((channel: string, repoPath?: string) => {
      if (channel === 'worktree:list') return Promise.resolve(LISTS[repoPath ?? PRIMARY] ?? [])
      return Promise.resolve(undefined)
    }),
  }
  setProjectRoot(PRIMARY)
  await refreshWorktreesFor(PRIMARY)
  sessionsStore.reset()
})

/** Terminals append, giving a deterministic [t0, t1, …] order. */
function makeN(n: number): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(sessionsStore.createTerminal(`/wt${i}`))
  return out
}

const ids = (): string[] => sessionsStore.sessions().map((s) => s.id)
const groupOf = (id: string): string | undefined => sessionsStore.get(id)?.groupId

describe('createGroup', () => {
  it('assigns the group, makes members contiguous, and needs ≥2 members', () => {
    const [a, b, c] = makeN(3) // [a, b, c]
    const g = sessionsStore.createGroup([a, c])
    expect(g).toBeTruthy()
    expect(groupOf(a)).toBe(g)
    expect(groupOf(c)).toBe(g)
    expect(groupOf(b)).toBeUndefined()
    // Anchored at a's position, members pulled together: [a, c, b].
    expect(ids()).toEqual([a, c, b])
  })

  it('refuses a group of fewer than two sessions', () => {
    const [a] = makeN(1)
    expect(sessionsStore.createGroup([a])).toBeNull()
    expect(sessionsStore.groups()).toHaveLength(0)
  })

  it('auto-assigns distinct colors as groups are created', () => {
    const [a, b, c, d] = makeN(4)
    const g1 = sessionsStore.createGroup([a, b])!
    const g2 = sessionsStore.createGroup([c, d])!
    expect(sessionsStore.group(g1)!.color).not.toBe(sessionsStore.group(g2)!.color)
  })
})

describe('moveSession', () => {
  it('reorders before/after a reference session', () => {
    const [a, b, c] = makeN(3)
    sessionsStore.moveSession(c, { mode: 'before', refId: a })
    expect(ids()).toEqual([c, a, b])
    sessionsStore.moveSession(c, { mode: 'after', refId: b })
    expect(ids()).toEqual([a, b, c])
  })

  it('joins a group when dropped next to one of its members', () => {
    const [a, b, c] = makeN(3)
    const g = sessionsStore.createGroup([a, b])!
    sessionsStore.moveSession(c, { mode: 'after', refId: a })
    expect(groupOf(c)).toBe(g)
    // All three stay contiguous.
    expect(ids().filter((id) => groupOf(id) === g)).toHaveLength(3)
  })

  it('appends to a group via intoGroup, keeping members contiguous', () => {
    const [a, b, c, d] = makeN(4)
    const g = sessionsStore.createGroup([a, b])!
    sessionsStore.moveSession(d, { mode: 'intoGroup', groupId: g })
    expect(groupOf(d)).toBe(g)
    expect(ids()).toEqual([a, b, d, c])
  })

  it('toEnd moves a session to the end as standalone (leaving its group)', () => {
    const [a, b] = makeN(3)
    sessionsStore.createGroup([a, b])
    sessionsStore.moveSession(a, { mode: 'toEnd' })
    expect(groupOf(a)).toBeUndefined()
    expect(ids()[ids().length - 1]).toBe(a)
    // The 2-member group lost a member and dissolved.
    expect(sessionsStore.groups()).toHaveLength(0)
  })
})

describe('removeFromGroup / dissolve', () => {
  it('dissolves a two-member group, clearing the lone survivor', () => {
    const [a, b] = makeN(2)
    sessionsStore.createGroup([a, b])
    sessionsStore.removeFromGroup(a)
    expect(groupOf(a)).toBeUndefined()
    expect(groupOf(b)).toBeUndefined()
    expect(sessionsStore.groups()).toHaveLength(0)
  })

  it('keeps a group with two survivors after removing a member', () => {
    const [a, b, c] = makeN(3)
    const g = sessionsStore.createGroup([a, b, c])!
    sessionsStore.removeFromGroup(a)
    expect(groupOf(a)).toBeUndefined()
    expect(groupOf(b)).toBe(g)
    expect(groupOf(c)).toBe(g)
    expect(sessionsStore.groups()).toHaveLength(1)
  })

  it('dissolves the group when closing a session drops it below two members', () => {
    const [a, b] = makeN(2)
    sessionsStore.createGroup([a, b])
    sessionsStore.close(a, { ptyAlreadyDead: true })
    expect(groupOf(b)).toBeUndefined()
    expect(sessionsStore.groups()).toHaveLength(0)
  })
})

describe('group metadata', () => {
  it('renames, recolors, toggles collapse, and ungroups', () => {
    const [a, b] = makeN(2)
    const g = sessionsStore.createGroup([a, b], 'Frontend')!
    expect(sessionsStore.group(g)!.name).toBe('Frontend')

    sessionsStore.renameGroup(g, '  Backend  ')
    expect(sessionsStore.group(g)!.name).toBe('Backend')

    expect(sessionsStore.group(g)!.collapsed).toBe(false)
    sessionsStore.toggleGroupCollapsed(g)
    expect(sessionsStore.group(g)!.collapsed).toBe(true)

    sessionsStore.setGroupColor(g, 'rose')
    expect(sessionsStore.group(g)!.color).toBe('rose')

    sessionsStore.ungroup(g)
    expect(groupOf(a)).toBeUndefined()
    expect(groupOf(b)).toBeUndefined()
    expect(sessionsStore.groups()).toHaveLength(0)
  })
})

describe('persistence round-trip', () => {
  function restoredClaude(label: string, groupId?: string): string {
    return sessionsStore.addRestoredSession({
      kind: 'claude',
      label,
      launchDir: PRIMARY,
      worktreePath: MAIN_WT,
      sessionId: `uuid-${label}`,
      ...(groupId ? { groupId } : {}),
    })!
  }

  it('serializes and restores groups, assignments, and order (v3)', () => {
    sessionsStore.restoreGroups([{ id: 'g1', name: 'Frontend', color: 'violet', collapsed: true }])
    restoredClaude('a', 'g1')
    restoredClaude('b', 'g1')
    restoredClaude('c')

    const blob = serializeSession(PRIMARY)
    expect(blob.version).toBe(3)
    expect(blob.groups).toEqual([{ id: 'g1', name: 'Frontend', color: 'violet', collapsed: true }])

    sessionsStore.reset()
    hydrateSession(blob)

    const groups = sessionsStore.groups()
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBe('Frontend')
    const grouped = sessionsStore.sessions().filter((s) => s.groupId === groups[0].id)
    expect(grouped).toHaveLength(2)
    expect(grouped.map((s) => s.label).sort()).toEqual(['a', 'b'])
  })

  it('prunes a group that ends up with fewer than two restored members', () => {
    sessionsStore.restoreGroups([{ id: 'solo', name: 'Solo', color: 'sky', collapsed: false }])
    restoredClaude('only', 'solo')
    sessionsStore.finalizeRestoredGroups()
    expect(sessionsStore.groups()).toHaveLength(0)
    expect(groupOf(sessionsStore.sessions()[0].id)).toBeUndefined()
  })

  it('hydrates a pre-grouping v2 blob as all-standalone', () => {
    const v2: SerializedSession = {
      version: 2,
      repoPath: PRIMARY,
      savedAt: '2026-01-01T00:00:00.000Z',
      activeIndex: null,
      sessions: [
        {
          kind: 'claude',
          label: 'legacy',
          worktreePath: MAIN_WT,
          launchDir: PRIMARY,
          sessionId: 'uuid-legacy',
          tabs: [],
          activeTabId: null,
          unread: [],
        },
      ],
    }
    hydrateSession(v2)
    expect(sessionsStore.groups()).toHaveLength(0)
    expect(sessionsStore.sessions()).toHaveLength(1)
    expect(groupOf(sessionsStore.sessions()[0].id)).toBeUndefined()
  })
})
