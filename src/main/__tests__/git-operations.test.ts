import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'
import type { RemoteClient } from '../client-hub'
import {
  getCommitLog,
  getStagingFiles,
  getStatusSnapshot,
  isWatchingGitRefs,
  triggerStatusCheck,
  unwatchAllGitRefs,
  unwatchGitRefs,
  watchGitRefs,
} from '../git-operations'

const tmpRoot = mkdtempSync(join(tmpdir(), 'simpleedit-git-ops-test-'))
const repo = join(tmpRoot, 'repo')

beforeAll(async () => {
  await simpleGit(tmpRoot).raw(['init', '--initial-branch=main', repo])
  const git = simpleGit(repo)
  await git.addConfig('user.email', 'test@example.com')
  await git.addConfig('user.name', 'Test')
  mkdirSync(join(repo, 'projects', 'x', 'memory'), { recursive: true })
  writeFileSync(join(repo, 'outside.txt'), '1')
  await git.add('.')
  await git.commit('outside')
  writeFileSync(join(repo, 'projects', 'x', 'memory', 'MEMORY.md'), '# m')
  await git.add('.')
  await git.commit('memory')
  writeFileSync(join(repo, 'outside.txt'), '2')
  await git.add('.')
  await git.commit('outside again')
  // Dirty state on both sides of the pathspec.
  writeFileSync(join(repo, 'untracked-outside.txt'), 'u')
  writeFileSync(join(repo, 'projects', 'x', 'memory', 'new.md'), 'n')
})

afterAll(() => {
  unwatchAllGitRefs()
  rmSync(tmpRoot, { recursive: true, force: true })
})

const PATHSPEC = 'projects/x/memory'

describe('pathspec-scoped reads', () => {
  it('getCommitLog limits to commits touching the pathspec', async () => {
    expect((await getCommitLog(repo)).map((c) => c.message)).toEqual(['outside again', 'memory', 'outside'])
    expect((await getCommitLog(repo, 50, PATHSPEC)).map((c) => c.message)).toEqual(['memory'])
  })

  it('getStagingFiles reports only paths under the pathspec', async () => {
    const all = (await getStagingFiles(repo)).map((f) => f.path).sort()
    expect(all).toEqual(['projects/x/memory/new.md', 'untracked-outside.txt'])
    expect((await getStagingFiles(repo, PATHSPEC)).map((f) => f.path)).toEqual(['projects/x/memory/new.md'])
  })

  it('getStatusSnapshot scopes the porcelain status', async () => {
    const scoped = await getStatusSnapshot(repo, PATHSPEC)
    expect(scoped).toContain('new.md')
    expect(scoped).not.toContain('untracked-outside.txt')
    expect(await getStatusSnapshot(repo)).toContain('untracked-outside.txt')
  })
})

describe('git watcher keying', () => {
  const client: RemoteClient = { id: 1, isDestroyed: () => false, send: vi.fn() }

  afterEach(() => unwatchAllGitRefs())

  it('keeps scoped and unscoped watches on one root apart', async () => {
    await watchGitRefs(repo, client)
    await watchGitRefs(repo, client, PATHSPEC)
    expect(isWatchingGitRefs(repo)).toBe(true)
    expect(isWatchingGitRefs(repo, PATHSPEC)).toBe(true)

    unwatchGitRefs(repo, PATHSPEC)
    expect(isWatchingGitRefs(repo, PATHSPEC)).toBe(false)
    expect(isWatchingGitRefs(repo)).toBe(true)

    unwatchGitRefs(repo)
    expect(isWatchingGitRefs(repo)).toBe(false)
  })

  it('polls status with the watch\'s own pathspec', async () => {
    const send = vi.fn<(channel: string, data: unknown) => void>()
    const scoped: RemoteClient = { id: 2, isDestroyed: () => false, send }
    await watchGitRefs(repo, scoped, PATHSPEC)

    writeFileSync(join(repo, 'another-outside.txt'), 'o')
    await triggerStatusCheck(repo, PATHSPEC)
    expect(send).not.toHaveBeenCalledWith('git:status-changed', expect.anything())

    writeFileSync(join(repo, 'projects', 'x', 'memory', 'another.md'), 'i')
    await triggerStatusCheck(repo, PATHSPEC)
    expect(send).toHaveBeenCalledWith('git:status-changed', { worktreePath: repo })
  })
})
