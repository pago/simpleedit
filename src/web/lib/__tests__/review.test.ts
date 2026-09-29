import { describe, it, expect } from 'vitest'
import {
  defaultEntry,
  entryKey,
  entryTitle,
  relativeTime,
  repoChoices,
  repoForWorktree,
  sameEntry,
  trailWorktrees,
  worktreeChoices,
} from '../review'
import type { GitCommitInfo, SessionRepoTrail, WorktreeInfo } from '../../../shared/ipc-types'

const TRAIL: SessionRepoTrail[] = [
  { repoPath: '/code/other/other.git', worktrees: ['/code/other/wip'] },
  { repoPath: '/code/simpleedit/simpleedit.git', worktrees: ['/code/simpleedit/feat/pty', '/code/simpleedit/main'] },
]

function worktree(path: string, branch: string): WorktreeInfo {
  return { path, branch, isMain: false, isCurrent: false }
}

function commit(hash: string, message: string): GitCommitInfo {
  return { hash, message, author: 'pago', date: '2026-08-28T10:00:00Z' }
}

describe('repo choices', () => {
  it('names a repo after the project beside its bare dir, trail order kept', () => {
    expect(repoChoices(TRAIL)).toEqual([
      { repoPath: '/code/other/other.git', name: 'other' },
      { repoPath: '/code/simpleedit/simpleedit.git', name: 'simpleedit' },
    ])
  })

  it('finds the repo a worktree belongs to', () => {
    expect(repoForWorktree(TRAIL, '/code/simpleedit/main')).toBe('/code/simpleedit/simpleedit.git')
    expect(repoForWorktree(TRAIL, '/code/other/wip')).toBe('/code/other/other.git')
  })

  // A viewer pointed at a worktree by hand sits outside the session's own
  // trail, and the picker has to survive it rather than silently mis-file it.
  it('answers null for a worktree the trail has never seen', () => {
    expect(repoForWorktree(TRAIL, '/code/elsewhere/main')).toBeNull()
    expect(repoForWorktree([], '/code/simpleedit/main')).toBeNull()
  })

  it('has no worktrees for a repo it does not hold', () => {
    expect(trailWorktrees(TRAIL, '/code/nope/nope.git')).toEqual([])
    expect(trailWorktrees(TRAIL, null)).toEqual([])
  })
})

describe('worktree choices', () => {
  it('offers touched worktrees first in trail order, then the rest by path', () => {
    const listed = [
      worktree('/code/simpleedit/zeta', 'zeta'),
      worktree('/code/simpleedit/main', 'main'),
      worktree('/code/simpleedit/alpha', 'alpha'),
    ]
    expect(worktreeChoices(['/code/simpleedit/feat/pty', '/code/simpleedit/main'], listed)).toEqual([
      { path: '/code/simpleedit/feat/pty', name: 'feat/pty', touched: true },
      { path: '/code/simpleedit/main', name: 'simpleedit/main', touched: true },
      { path: '/code/simpleedit/alpha', name: 'alpha', touched: false },
      { path: '/code/simpleedit/zeta', name: 'zeta', touched: false },
    ])
  })

  // `worktree:list` answers `[]` when it fails, so the trail is the floor the
  // picker can never fall below — otherwise a failed list would leave a session
  // unable to reach the worktree it is working in.
  it('still offers the trail when the repo listing came back empty', () => {
    expect(worktreeChoices(['/code/other/wip'], []).map((c) => c.path)).toEqual(['/code/other/wip'])
  })

  it('never lists a worktree twice', () => {
    const listed = [worktree('/code/other/wip', 'wip')]
    expect(worktreeChoices(['/code/other/wip'], listed)).toHaveLength(1)
  })
})

describe('default entry', () => {
  it('lands on uncommitted changes, as at the desk', () => {
    expect(defaultEntry(true, [commit('abc1234', 'Fix the parser')])).toEqual({ kind: 'uncommitted' })
  })

  it('falls back to the newest commit when the tree is clean', () => {
    expect(defaultEntry(false, [commit('abc1234', 'Fix the parser'), commit('def5678', 'Older')])).toMatchObject({
      kind: 'commit',
      hash: 'abc1234',
    })
  })

  it('has nothing to open in a clean worktree with no commits', () => {
    expect(defaultEntry(false, [])).toBeNull()
  })
})

describe('entry identity', () => {
  it('distinguishes commits from each other and from the working tree', () => {
    expect(entryKey({ kind: 'uncommitted' })).toBe('uncommitted')
    expect(sameEntry({ kind: 'uncommitted' }, { kind: 'uncommitted' })).toBe(true)
    const a = defaultEntry(false, [commit('aaa', 'A')])
    const b = defaultEntry(false, [commit('bbb', 'B')])
    expect(sameEntry(a, b)).toBe(false)
    expect(sameEntry(a, null)).toBe(false)
    expect(sameEntry(null, null)).toBe(true)
  })

  it('titles a commit by its subject and the working tree by name', () => {
    expect(entryTitle({ kind: 'uncommitted' })).toBe('Uncommitted changes')
    expect(entryTitle({ kind: 'commit', hash: 'abc1234', message: 'Subject\n\nBody', author: 'p', date: '' }))
      .toBe('Subject')
    expect(entryTitle({ kind: 'commit', hash: 'abc1234def', message: '', author: 'p', date: '' })).toBe('abc1234')
  })
})

describe('relative time', () => {
  const now = Date.parse('2026-08-28T12:00:00Z')
  it('reports coarse ages', () => {
    expect(relativeTime('2026-08-28T11:59:30Z', now)).toBe('just now')
    expect(relativeTime('2026-08-28T11:30:00Z', now)).toBe('30m ago')
    expect(relativeTime('2026-08-28T09:00:00Z', now)).toBe('3h ago')
    expect(relativeTime('2026-08-26T12:00:00Z', now)).toBe('2d ago')
    expect(relativeTime('2026-08-01T12:00:00Z', now)).toBe('3w ago')
  })

  it('says nothing rather than "NaN ago" for a date it cannot read', () => {
    expect(relativeTime('not a date', now)).toBe('')
  })
})
