import { describe, it, expect } from 'vitest'
import { parsePorcelain } from '../worktree'

const PORCELAIN = `worktree /repo/project.git
bare

worktree /private/tmp/pr-2457-review
HEAD 116a875876
branch refs/heads/pr-2457
prunable gitdir file points to non-existent location

worktree /repo/agent-first
HEAD 4bcee8a3d5
branch refs/heads/agent-first

worktree /repo/main
HEAD 4b5ceb9b87
branch refs/heads/main

worktree /repo/detached-spike
HEAD cf25824983
detached
`

describe('parsePorcelain', () => {
  it('skips the bare entry and prunable worktrees', () => {
    const result = parsePorcelain(PORCELAIN, 'main')
    expect(result.map((w) => w.path)).toEqual([
      '/repo/agent-first',
      '/repo/main',
      '/repo/detached-spike',
    ])
  })

  it('marks the default-branch worktree as main (list order is path-sorted, not main-first)', () => {
    const result = parsePorcelain(PORCELAIN, 'main')
    expect(result.find((w) => w.isMain)?.path).toBe('/repo/main')
    expect(result[0].isMain).toBe(false)
  })

  it('labels detached worktrees', () => {
    const result = parsePorcelain(PORCELAIN, 'main')
    expect(result.find((w) => w.path === '/repo/detached-spike')?.branch).toBe('(detached)')
  })
})
