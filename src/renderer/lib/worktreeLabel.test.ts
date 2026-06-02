import { describe, it, expect } from 'vitest'
import type { WorktreeInfo } from '../../shared/ipc-types'
import { worktreeDirName, worktreeLabel } from './worktreeLabel'

function wt(path: string, branch: string): WorktreeInfo {
  return { path, branch, isMain: false, isCurrent: false }
}

describe('worktreeDirName', () => {
  it('returns the last path segment', () => {
    expect(worktreeDirName('/Users/me/proj/improvements')).toBe('improvements')
    expect(worktreeDirName('/Users/me/proj/feat/sub')).toBe('sub')
  })

  it('ignores a trailing slash', () => {
    expect(worktreeDirName('/Users/me/proj/improvements/')).toBe('improvements')
  })

  it('falls back to the raw value when there is no separator', () => {
    expect(worktreeDirName('improvements')).toBe('improvements')
  })
})

describe('worktreeLabel', () => {
  it('shows only the name when the directory matches the branch', () => {
    expect(worktreeLabel(wt('/Users/me/proj/feature-x', 'feature-x'))).toBe('feature-x')
    expect(worktreeLabel(wt('/Users/me/proj/main', 'main'))).toBe('main')
  })

  it('shows dir-primary with the branch in parentheses when they differ', () => {
    expect(worktreeLabel(wt('/Users/me/proj/improvements', 'main'))).toBe('improvements (main)')
  })

  it('surfaces a detached HEAD against the directory name', () => {
    expect(worktreeLabel(wt('/Users/me/proj/improvements', '(detached)'))).toBe(
      'improvements ((detached))'
    )
  })
})
