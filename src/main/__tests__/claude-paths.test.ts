/**
 * Unit tests for the Claude-CLI on-disk path encoder.
 *
 * The encoding rule (verified empirically against CLI 2.1.148, see
 * `/tmp/claude-spike/audit-*.jsonl` artifacts from critic's pre-PR4 audit):
 *   1. resolve symlinks (realpath)
 *   2. replace every non-`[A-Za-z0-9]` character with a single `-`
 *
 * Note (2) is character-wise, not run-wise: `/foo  bar` (two spaces) yields
 * `-foo--bar` not `-foo-bar`. Verified against the CLI.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'
import {
  claudeConfigDir,
  claudeKeyHash,
  claudeMemoryDir,
  claudeProjectDirName,
  claudeProjectsDir,
  encodeProjectKey,
  PROJECT_KEY_MAX,
} from '../claude-paths'

const tmpRoot = mkdtempSync(join(tmpdir(), 'simpleedit-claude-paths-test-'))

describe('claudeProjectDirName', () => {
  it('replaces every non-alphanumeric character with a single dash', () => {
    const dir = mkdtempSync(join(tmpRoot, 'plain-'))
    const encoded = claudeProjectDirName(dir)
    const realDir = realpathSync(dir)
    expect(encoded).toBe(realDir.replace(/[^A-Za-z0-9]/g, '-'))
    expect(encoded).toMatch(/^[A-Za-z0-9-]+$/)
  })

  it('preserves digit and letter casing', () => {
    const dir = mkdtempSync(join(tmpRoot, 'CaSe-99-'))
    const encoded = claudeProjectDirName(dir)
    // Whatever real path we got, encoded should preserve the alphanumerics.
    expect(encoded).toMatch(/CaSe-99/)
  })

  it('replaces spaces with dashes (per-character, not collapsed)', () => {
    const parent = mkdtempSync(join(tmpRoot, 'with-spaces-'))
    const dirWithSpaces = join(parent, 'foo bar')
    mkdirSync(dirWithSpaces)
    const encoded = claudeProjectDirName(dirWithSpaces)
    expect(encoded).toMatch(/foo-bar$/)
  })

  it('replaces dots with dashes', () => {
    const parent = mkdtempSync(join(tmpRoot, 'with-dots-'))
    const dirWithDots = join(parent, 'foo.bar')
    mkdirSync(dirWithDots)
    const encoded = claudeProjectDirName(dirWithDots)
    expect(encoded).toMatch(/foo-bar$/)
  })

  it('non-ASCII characters each become a single dash (lossy)', () => {
    const parent = mkdtempSync(join(tmpRoot, 'unicode-'))
    // Each non-ASCII codepoint -> one dash, per CLI behavior.
    const dirUnicode = join(parent, 'café')
    mkdirSync(dirUnicode)
    const encoded = claudeProjectDirName(dirUnicode)
    // "café" → "caf-" (4 chars → "caf" + single dash for é).
    expect(encoded).toMatch(/caf-$/)
  })

  it('resolves symlinks (realpath first)', () => {
    const real = mkdtempSync(join(tmpRoot, 'real-'))
    const linkParent = mkdtempSync(join(tmpRoot, 'link-'))
    const link = join(linkParent, 'pointer')
    symlinkSync(real, link)

    expect(claudeProjectDirName(link)).toBe(claudeProjectDirName(real))
  })

  it('flags the documented collision class', () => {
    // The encoding is lossy: any non-alphanumeric character becomes the same `-`.
    // We can't easily mkdir paths with `:` on every FS, so use string-level
    // assertions on the encoding rule directly via a path-shape comparison.
    const parent = mkdtempSync(join(tmpRoot, 'collide-'))
    const a = join(parent, 'foo-bar')
    const b = join(parent, 'foo bar')
    mkdirSync(a)
    mkdirSync(b)
    expect(claudeProjectDirName(a)).toBe(claudeProjectDirName(b))
  })
})

describe('claudeProjectsDir', () => {
  it('joins HOME + .claude/projects + encoded-cwd', () => {
    const dir = mkdtempSync(join(tmpRoot, 'pd-'))
    const projects = claudeProjectsDir(dir, {})
    expect(projects).toMatch(/\.claude\/projects\//)
    expect(projects).toMatch(new RegExp(`${claudeProjectDirName(dir)}$`))
  })

  it('honours CLAUDE_CONFIG_DIR', () => {
    const dir = mkdtempSync(join(tmpRoot, 'pd-'))
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe('/cfg')
    expect(claudeConfigDir({})).toBe(join(homedir(), '.claude'))
    expect(claudeProjectsDir(dir, { CLAUDE_CONFIG_DIR: '/cfg' })).toBe(join('/cfg', 'projects', claudeProjectDirName(dir)))
  })
})

describe('encodeProjectKey (over-cap keys)', () => {
  it('matches Java String.hashCode in base 36', () => {
    // "hello".hashCode() === 99162322; a negative hash is made absolute.
    expect(claudeKeyHash('hello')).toBe((99162322).toString(36))
    expect(claudeKeyHash('polygenelubricants')).toBe((2147483648).toString(36))
  })

  it('truncates to 200 chars and appends the hash of the unencoded path', () => {
    const long = '/' + 'a'.repeat(250)
    const key = encodeProjectKey(long)
    expect(key).toBe(`-${'a'.repeat(PROJECT_KEY_MAX - 1)}-${claudeKeyHash(long)}`)
    expect(encodeProjectKey('/short/path')).toBe('-short-path')
  })
})

describe('claudeMemoryDir', () => {
  const makeConfig = (): string => mkdtempSync(join(tmpRoot, 'cfg-'))
  const seedMemory = (config: string, key: string): string => {
    const dir = join(config, 'projects', key, 'memory')
    mkdirSync(dir, { recursive: true })
    return realpathSync(dir)
  }

  it('defaults to projects/<launchDir key>/memory, even when missing', async () => {
    const config = makeConfig()
    const launch = mkdtempSync(join(tmpRoot, 'launch-'))
    expect(await claudeMemoryDir(launch, { CLAUDE_CONFIG_DIR: config })).toBe(
      join(config, 'projects', claudeProjectDirName(launch), 'memory'),
    )
  })

  it('reads autoMemoryDirectory from user settings, expanding ~/ and ignoring relative paths', async () => {
    const config = makeConfig()
    const launch = mkdtempSync(join(tmpRoot, 'launch-'))
    const env = { CLAUDE_CONFIG_DIR: config }
    const custom = mkdtempSync(join(tmpRoot, 'custom-mem-'))
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: custom }))
    expect(await claudeMemoryDir(launch, env)).toBe(realpathSync(custom))

    writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/some-memory-dir-xyz' }))
    expect(await claudeMemoryDir(launch, env)).toBe(join(homedir(), 'some-memory-dir-xyz'))

    writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: 'relative/dir' }))
    expect(await claudeMemoryDir(launch, env)).toBe(join(config, 'projects', claudeProjectDirName(launch), 'memory'))
  })

  it.each([['~'], [` ${tmpRoot}`], ['~user/x'], ['']])(
    'ignores autoMemoryDirectory %j, as the CLI does (no trim, only ~/ expands)',
    async (value) => {
      const config = makeConfig()
      const launch = mkdtempSync(join(tmpRoot, 'launch-'))
      writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: value }))
      expect(await claudeMemoryDir(launch, { CLAUDE_CONFIG_DIR: config })).toBe(
        join(config, 'projects', claudeProjectDirName(launch), 'memory'),
      )
    },
  )

  it('ignores autoMemoryDirectory in project and local settings', async () => {
    const config = makeConfig()
    const launch = mkdtempSync(join(tmpRoot, 'launch-'))
    mkdirSync(join(launch, '.claude'))
    const evil = mkdtempSync(join(tmpRoot, 'evil-'))
    writeFileSync(join(launch, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: evil }))
    writeFileSync(join(launch, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: evil }))
    expect(await claudeMemoryDir(launch, { CLAUDE_CONFIG_DIR: config })).toBe(
      join(config, 'projects', claudeProjectDirName(launch), 'memory'),
    )
  })

  it('uses CLAUDE_CODE_PROJECT_DIR_NAME only with CLAUDE_CONFIG_DIR and a valid name', async () => {
    const config = makeConfig()
    const launch = mkdtempSync(join(tmpRoot, 'launch-'))
    const fallback = join(config, 'projects', claudeProjectDirName(launch), 'memory')
    expect(await claudeMemoryDir(launch, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: 'custom_1' })).toBe(
      join(config, 'projects', 'custom_1', 'memory'),
    )
    expect(await claudeMemoryDir(launch, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: '../escape' })).toBe(
      fallback,
    )
    for (const reserved of ['con', 'NUL', 'Com1', 'lpt9', 'aux', 'prn']) {
      expect(await claudeMemoryDir(launch, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: reserved })).toBe(
        fallback,
      )
    }
    expect(await claudeMemoryDir(launch, { CLAUDE_CODE_PROJECT_DIR_NAME: 'custom_1' })).toBe(
      join(homedir(), '.claude', 'projects', claudeProjectDirName(launch), 'memory'),
    )
  })

  describe('in a git work tree', () => {
    async function makeRepo(): Promise<{ main: string; linked: string; sub: string }> {
      const root = mkdtempSync(join(tmpRoot, 'repo-'))
      const main = join(root, 'main')
      await simpleGit(root).raw(['init', '--initial-branch=main', main])
      const git = simpleGit(main)
      await git.addConfig('user.email', 'test@example.com')
      await git.addConfig('user.name', 'Test')
      mkdirSync(join(main, 'sub'))
      writeFileSync(join(main, 'sub', 'f'), 'x')
      await git.add('.')
      await git.commit('init')
      const linked = join(root, 'linked')
      await git.raw(['worktree', 'add', '-b', 'feature', linked])
      return { main: realpathSync(main), linked: realpathSync(linked), sub: realpathSync(join(main, 'sub')) }
    }

    it('prefers the main worktree root when nothing exists yet', async () => {
      const config = makeConfig()
      const { main, linked } = await makeRepo()
      expect(await claudeMemoryDir(linked, { CLAUDE_CONFIG_DIR: config })).toBe(
        join(config, 'projects', encodeProjectKey(main), 'memory'),
      )
    })

    it('probes candidates in order: main root, toplevel, launchDir', async () => {
      const env = { CLAUDE_CONFIG_DIR: makeConfig() }
      const { main, linked } = await makeRepo()
      const launch = join(linked, 'sub')
      const own = seedMemory(env.CLAUDE_CONFIG_DIR, encodeProjectKey(launch))
      expect(await claudeMemoryDir(launch, env)).toBe(own)
      const top = seedMemory(env.CLAUDE_CONFIG_DIR, encodeProjectKey(linked))
      expect(await claudeMemoryDir(launch, env)).toBe(top)
      const mainMem = seedMemory(env.CLAUDE_CONFIG_DIR, encodeProjectKey(main))
      expect(await claudeMemoryDir(launch, env)).toBe(mainMem)
    })
  })

  describe('over-cap project keys', () => {
    function longLaunchDir(): string {
      let dir = mkdtempSync(join(tmpRoot, 'long-'))
      while (realpathSync(dir).length <= PROJECT_KEY_MAX + 10) {
        dir = join(dir, 'x'.repeat(40))
        mkdirSync(dir)
      }
      return realpathSync(dir)
    }

    it('finds the hashed key', async () => {
      const config = makeConfig()
      const launch = longLaunchDir()
      const mem = seedMemory(config, encodeProjectKey(launch))
      expect(await claudeMemoryDir(launch, { CLAUDE_CONFIG_DIR: config })).toBe(mem)
    })

    it('falls back to a unique entry with the truncated prefix', async () => {
      const config = makeConfig()
      const launch = longLaunchDir()
      const prefix = encodeProjectKey(launch).slice(0, PROJECT_KEY_MAX)
      const mem = seedMemory(config, `${prefix}-otherhash`)
      expect(await claudeMemoryDir(launch, { CLAUDE_CONFIG_DIR: config })).toBe(mem)

      seedMemory(config, `${prefix}-secondhash`)
      expect(await claudeMemoryDir(launch, { CLAUDE_CONFIG_DIR: config })).toBe(
        join(config, 'projects', encodeProjectKey(launch), 'memory'),
      )
    })
  })
})

// Drain test artifacts.
import { afterAll } from 'vitest'
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})
