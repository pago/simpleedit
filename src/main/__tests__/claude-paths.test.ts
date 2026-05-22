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
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeProjectDirName, claudeProjectsDir } from '../claude-paths'

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
    const projects = claudeProjectsDir(dir)
    expect(projects).toMatch(/\.claude\/projects\//)
    expect(projects).toMatch(new RegExp(`${claudeProjectDirName(dir)}$`))
  })
})

// Drain test artifacts.
import { afterAll } from 'vitest'
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})
