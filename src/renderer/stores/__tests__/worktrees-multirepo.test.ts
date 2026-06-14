import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorktreeInfo } from '../../../shared/ipc-types'
import {
  setProjectRoot,
  refreshWorktreesFor,
  worktreeListFor,
  mainWorktreeFor,
  repoForWorktree,
  primaryRepo,
} from '../worktrees.svelte'

const PRIMARY = '/repo/primary.git'
const OTHER = '/repo/other.git'

function wt(path: string, branch: string, isMain = false): WorktreeInfo {
  return { path, branch, isMain, isCurrent: false }
}

const LISTS: Record<string, WorktreeInfo[]> = {
  [PRIMARY]: [wt('/repo/primary/main', 'main', true), wt('/repo/primary/feat', 'feat')],
  [OTHER]: [wt('/repo/other/main', 'main', true), wt('/repo/other/wip', 'wip')],
}

beforeEach(() => {
  // Runs in the browser (chromium) vitest project, so `window` is real — set
  // the api surface on it rather than replacing the whole object.
  ;(window as unknown as { api: { invoke: unknown } }).api = {
    invoke: vi.fn((channel: string, repoPath?: string) => {
      if (channel === 'worktree:list') return Promise.resolve(LISTS[repoPath ?? PRIMARY] ?? [])
      return Promise.resolve(undefined)
    }),
  }
  setProjectRoot(PRIMARY)
})

describe('multi-repo worktree resolution', () => {
  it('worktreeListFor returns the primary list for undefined / primary repo', async () => {
    await refreshWorktreesFor(PRIMARY)
    expect(worktreeListFor(undefined)).toEqual(LISTS[PRIMARY])
    expect(worktreeListFor(PRIMARY)).toEqual(LISTS[PRIMARY])
  })

  it('worktreeListFor caches and returns a non-primary repo list', async () => {
    expect(worktreeListFor(OTHER)).toEqual([]) // not loaded yet
    await refreshWorktreesFor(OTHER)
    expect(worktreeListFor(OTHER)).toEqual(LISTS[OTHER])
  })

  it('mainWorktreeFor resolves the default-branch worktree per repo', async () => {
    await refreshWorktreesFor(OTHER)
    expect(mainWorktreeFor(OTHER)?.path).toBe('/repo/other/main')
  })

  it('repoForWorktree returns the non-primary repo owning a worktree, undefined otherwise', async () => {
    await refreshWorktreesFor(PRIMARY)
    await refreshWorktreesFor(OTHER)
    // Non-primary worktree → its repo.
    expect(repoForWorktree('/repo/other/wip')).toBe(OTHER)
    // Primary worktree → undefined (primary is the default, not reported).
    expect(repoForWorktree('/repo/primary/feat')).toBeUndefined()
    // Unknown path → undefined.
    expect(repoForWorktree('/nope/x')).toBeUndefined()
  })

  it('primaryRepo reflects the opened project', () => {
    expect(primaryRepo()).toBe(PRIMARY)
  })
})
