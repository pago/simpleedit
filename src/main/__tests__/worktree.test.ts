import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'

import { listWorktrees, _resetDefaultBranchCacheForTests } from '../worktree'

/**
 * Build a bare repo with two linked worktrees whose paths sort such that the
 * non-default branch comes first alphabetically. This reproduces #89: under
 * the old heuristic, the alphabetically-first worktree got marked as main.
 */
async function setupBareRepoWithWorktrees(root: string): Promise<{
  bareRepoPath: string
}> {
  const seedPath = join(root, 'seed')
  const seed = simpleGit({ baseDir: root })
  await seed.raw(['init', '--initial-branch=main', seedPath])
  const seedRepo = simpleGit(seedPath)
  await seedRepo.addConfig('user.email', 'test@example.com')
  await seedRepo.addConfig('user.name', 'Test')
  writeFileSync(join(seedPath, 'README.md'), '# seed\n')
  await seedRepo.add('README.md')
  await seedRepo.commit('initial')

  // Clone bare from the seed so refs/remotes/origin/HEAD → origin/main.
  const bareRepoPath = join(root, 'project.git')
  await seed.raw(['clone', '--bare', seedPath, bareRepoPath])

  // Match the production refspec set by cloneBareRepo so origin/* refs land.
  const bareGit = simpleGit(bareRepoPath)
  await bareGit.raw(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
  await bareGit.raw(['fetch', 'origin'])
  // Bare clones don't auto-set refs/remotes/origin/HEAD when cloning from a
  // local path — set it explicitly so the primary lookup succeeds.
  await bareGit.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

  // Create a feature branch on the bare repo so it can be checked out.
  await bareGit.raw(['branch', 'aaa-feature', 'main'])

  // Add two worktrees. The feature worktree's path ("aaa-feature") sorts
  // BEFORE the main worktree's path ("main"), exposing the old bug.
  await bareGit.raw(['worktree', 'add', join(root, 'aaa-feature'), 'aaa-feature'])
  await bareGit.raw(['worktree', 'add', join(root, 'main'), 'main'])

  return { bareRepoPath }
}

describe('listWorktrees isMain resolution (issue #89)', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'simpleedit-worktree-test-'))
  let bareRepoPath: string

  beforeAll(async () => {
    ;({ bareRepoPath } = await setupBareRepoWithWorktrees(tmpRoot))
  })

  beforeEach(() => {
    _resetDefaultBranchCacheForTests()
  })

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('marks the worktree on the default branch as main, regardless of porcelain order', async () => {
    const worktrees = await listWorktrees(bareRepoPath)

    expect(worktrees.map((w) => w.branch).sort()).toEqual(['aaa-feature', 'main'])

    const main = worktrees.find((w) => w.branch === 'main')
    const feature = worktrees.find((w) => w.branch === 'aaa-feature')
    expect(main?.isMain).toBe(true)
    expect(feature?.isMain).toBe(false)
  })

  it('falls back to a literal "main" branch when refs/remotes/origin/HEAD is unset', async () => {
    // Delete origin/HEAD so the primary lookup fails. "main" still exists as
    // a local branch on the bare repo, so the literal-name fallback wins.
    const bare = simpleGit(bareRepoPath)
    await bare.raw(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']).catch(() => {})

    const worktrees = await listWorktrees(bareRepoPath)
    const main = worktrees.find((w) => w.branch === 'main')
    expect(main?.isMain).toBe(true)

    // Restore for any later assertions in this run.
    await bare.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  })

  it('caches the resolved default branch per bareRepoPath', async () => {
    // Prime the cache while origin/HEAD → origin/main. Then re-point
    // origin/HEAD at origin/aaa-feature: if the cache were bypassed, the
    // resolver would now return "aaa-feature" and that worktree would get
    // isMain=true. The cache must keep "main" pinned across the change.
    //
    // (The earlier shape of this test deleted origin/HEAD only, which left
    // the literal-name "main" fallback returning the same answer cache or
    // no-cache — see PR #91 reviewer feedback.)
    await listWorktrees(bareRepoPath) // primes the cache with "main"

    const bare = simpleGit(bareRepoPath)
    await bare.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/aaa-feature'])

    const worktrees = await listWorktrees(bareRepoPath)
    expect(worktrees.find((w) => w.branch === 'main')?.isMain).toBe(true)
    expect(worktrees.find((w) => w.branch === 'aaa-feature')?.isMain).toBe(false)

    // Restore for any later assertions in this run.
    await bare.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  })

  it('without cache priming, picks up a changed origin/HEAD', async () => {
    // Companion to the cache test: confirms the resolver *would* see a
    // re-pointed origin/HEAD if not for the cache. This validates that the
    // previous test's pinning is real cache behaviour and not coincidence.
    const bare = simpleGit(bareRepoPath)
    await bare.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/aaa-feature'])
    _resetDefaultBranchCacheForTests()

    const worktrees = await listWorktrees(bareRepoPath)
    expect(worktrees.find((w) => w.branch === 'aaa-feature')?.isMain).toBe(true)
    expect(worktrees.find((w) => w.branch === 'main')?.isMain).toBe(false)

    await bare.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  })
})
