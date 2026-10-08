import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'

vi.mock('electron', () => ({ app: {} }))

import { claudeProjectDirName } from '../claude-paths'
import {
  _resetHandedOutForTests,
  listMemoryFiles,
  memoryHealth,
  resolveMemoryLocation,
} from '../claude-memory'

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'simpleedit-claude-memory-test-')))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => _resetHandedOutForTests())

async function initRepo(dir: string, commit = true): Promise<void> {
  await simpleGit(dir).init()
  const git = simpleGit(dir)
  await git.addConfig('user.email', 'test@example.com')
  await git.addConfig('user.name', 'Test')
  if (commit) {
    writeFileSync(join(dir, 'seed.txt'), 'seed')
    await git.add('.')
    await git.commit('seed')
  }
}

/** A config dir + launch dir with the default memory dir path (not created). */
function fixture(): { config: string; launch: string; memoryDir: string } {
  const config = mkdtempSync(join(tmpRoot, 'cfg-'))
  const launch = mkdtempSync(join(tmpRoot, 'launch-'))
  return { config, launch, memoryDir: join(config, 'projects', claudeProjectDirName(launch), 'memory') }
}

describe('resolveMemoryLocation', () => {
  it('reports a missing dir', async () => {
    const { config, launch, memoryDir } = fixture()
    expect(await resolveMemoryLocation(launch, { CLAUDE_CONFIG_DIR: config })).toEqual({
      memoryDir,
      exists: false,
      git: null,
    })
  })

  it('reports an existing non-git dir', async () => {
    const { config, launch, memoryDir } = fixture()
    mkdirSync(memoryDir, { recursive: true })
    expect(await resolveMemoryLocation(launch, { CLAUDE_CONFIG_DIR: config })).toEqual({
      memoryDir,
      exists: true,
      git: null,
    })
  })

  it('detects a memory dir that is its own repo (pathspec null)', async () => {
    const { config, launch, memoryDir } = fixture()
    mkdirSync(memoryDir, { recursive: true })
    await initRepo(memoryDir)
    const loc = await resolveMemoryLocation(launch, { CLAUDE_CONFIG_DIR: config })
    expect(loc.git).toEqual({ root: memoryDir, pathspec: null })
  })

  it('detects a memory dir nested in a parent repo', async () => {
    const { config, launch, memoryDir } = fixture()
    mkdirSync(memoryDir, { recursive: true })
    await initRepo(config)
    const loc = await resolveMemoryLocation(launch, { CLAUDE_CONFIG_DIR: config })
    expect(loc.git).toEqual({ root: config, pathspec: `projects/${claudeProjectDirName(launch)}/memory` })
  })

  it('treats a gitignored nested dir as no-git', async () => {
    const { config, launch, memoryDir } = fixture()
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(config, '.gitignore'), 'projects/\n')
    await initRepo(config)
    expect((await resolveMemoryLocation(launch, { CLAUDE_CONFIG_DIR: config })).git).toBeNull()
  })

  it('treats a repo without commits as no-git', async () => {
    const { config, launch, memoryDir } = fixture()
    mkdirSync(memoryDir, { recursive: true })
    await initRepo(memoryDir, false)
    expect((await resolveMemoryLocation(launch, { CLAUDE_CONFIG_DIR: config })).git).toBeNull()
  })

  it.each([
    ['/', '/'],
    ['$HOME', homedir()],
  ])('refuses autoMemoryDirectory = %s', async (_label, dir) => {
    const { config, launch } = fixture()
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: dir }))
    const loc = await resolveMemoryLocation(launch, { CLAUDE_CONFIG_DIR: config })
    expect(loc).toMatchObject({ exists: false, git: null })
    expect(() => memoryHealth(loc.memoryDir)).toThrow(/Not a resolved memory dir/)
  })

  it('refuses the config dir itself', async () => {
    const { config, launch } = fixture()
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: config }))
    const loc = await resolveMemoryLocation(launch, { CLAUDE_CONFIG_DIR: config })
    expect(loc.exists).toBe(false)
    expect(() => listMemoryFiles(loc.memoryDir)).toThrow(/Not a resolved memory dir/)
  })
})

describe('memory walk + health', () => {
  it('rejects a dir that was never handed out', () => {
    const dir = mkdtempSync(join(tmpRoot, 'stray-'))
    expect(() => memoryHealth(dir)).toThrow(/Not a resolved memory dir/)
    expect(() => listMemoryFiles(dir)).toThrow(/Not a resolved memory dir/)
  })

  it('lists files and reports issues with absolute paths', async () => {
    const { config, launch, memoryDir } = fixture()
    mkdirSync(join(memoryDir, 'topics', 'a', 'b', 'c'), { recursive: true })
    mkdirSync(join(memoryDir, '.git'))
    writeFileSync(join(memoryDir, '.git', 'HEAD'), 'x')
    writeFileSync(join(memoryDir, 'MEMORY.md'), '- [one](one.md)\n- [gone](gone.md)')
    writeFileSync(join(memoryDir, 'one.md'), 'see [[nowhere]]')
    writeFileSync(join(memoryDir, 'stray.md'), 'stray')
    writeFileSync(join(memoryDir, 'topics', 'deep.md'), 'deep')
    writeFileSync(join(memoryDir, 'topics', 'a', 'b', 'c', 'too-deep.md'), 'x')
    await resolveMemoryLocation(launch, { CLAUDE_CONFIG_DIR: config })

    expect(listMemoryFiles(memoryDir)).toEqual(['MEMORY.md', 'one.md', 'stray.md', 'topics/deep.md'])
    const report = memoryHealth(memoryDir)
    expect(report).toMatchObject({ memoryDir, indexPresent: true, fileCount: 4 })
    expect(report.issues.map((i) => [i.kind, i.file])).toEqual([
      ['index-missing-file', join(memoryDir, 'MEMORY.md')],
      ['broken-link', join(memoryDir, 'one.md')],
      ['unindexed-file', join(memoryDir, 'stray.md')],
    ])
  })
})
