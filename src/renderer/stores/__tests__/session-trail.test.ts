import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorktreeInfo } from '../../../shared/ipc-types'
import {
  sessionsStore,
  touchedReposForSession,
  touchedWorktreesForRepo,
  type Session,
} from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor, repoKeyForWorktree } from '../worktrees.svelte'

const PRIMARY = '/repo/primary.git'
const OTHER = '/repo/other.git'

function wt(path: string, branch: string, isMain = false): WorktreeInfo {
  return { path, branch, isMain, isCurrent: false }
}

const LISTS: Record<string, WorktreeInfo[]> = {
  [PRIMARY]: [wt('/repo/primary/main', 'main', true), wt('/repo/primary/feat', 'feat')],
  [OTHER]: [wt('/repo/other/main', 'main', true), wt('/repo/other/wip', 'wip')],
}

function fakeSession(touched: string[]): Session {
  return {
    id: 's',
    kind: 'claude',
    label: '',
    launchDir: '/launch',
    worktreePath: touched[0] ?? '',
    touchedWorktrees: touched,
  }
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
  await refreshWorktreesFor(OTHER)
  sessionsStore.reset()
})

describe('repoKeyForWorktree', () => {
  it('normalizes a primary worktree to the primary repo (not undefined)', () => {
    expect(repoKeyForWorktree('/repo/primary/feat')).toBe(PRIMARY)
  })
  it('returns the owning repo for a non-primary worktree', () => {
    expect(repoKeyForWorktree('/repo/other/wip')).toBe(OTHER)
  })
})

describe('touchedReposForSession', () => {
  it('lists distinct repos in trail (most-recent-first) order', () => {
    const session = fakeSession(['/repo/other/wip', '/repo/primary/feat', '/repo/primary/main'])
    expect(touchedReposForSession(session)).toEqual([OTHER, PRIMARY])
  })
})

describe('touchedWorktreesForRepo', () => {
  const session = fakeSession(['/repo/other/wip', '/repo/primary/feat', '/repo/primary/main'])

  it('filters the trail to one repo, preserving recency order', () => {
    expect(touchedWorktreesForRepo(session, PRIMARY)).toEqual([
      '/repo/primary/feat',
      '/repo/primary/main',
    ])
    expect(touchedWorktreesForRepo(session, OTHER)).toEqual(['/repo/other/wip'])
  })

  it('treats undefined repo as the primary repo', () => {
    expect(touchedWorktreesForRepo(session, undefined)).toEqual([
      '/repo/primary/feat',
      '/repo/primary/main',
    ])
  })
})

describe('recordTouch', () => {
  it('seeds the trail with the initial worktree and moves touches to the front', () => {
    const id = sessionsStore.createClaude('/launch', '/repo/primary/main')
    expect(sessionsStore.get(id)?.touchedWorktrees).toEqual(['/repo/primary/main'])

    sessionsStore.recordTouch(id, '/repo/primary/feat')
    expect(sessionsStore.get(id)?.touchedWorktrees).toEqual([
      '/repo/primary/feat',
      '/repo/primary/main',
    ])

    // Re-touching an earlier worktree moves it back to the front (dedup).
    sessionsStore.recordTouch(id, '/repo/primary/main')
    expect(sessionsStore.get(id)?.touchedWorktrees).toEqual([
      '/repo/primary/main',
      '/repo/primary/feat',
    ])
  })
})
