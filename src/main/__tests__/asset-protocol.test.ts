import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveAssetPath } from '../asset-protocol'

let root: string
let worktree: string

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wt-asset-')))
  worktree = join(root, 'project')
  mkdirSync(join(worktree, 'docs'), { recursive: true })
  writeFileSync(join(worktree, 'docs', 'img.png'), 'x')
  writeFileSync(join(root, 'secret.txt'), 'top secret')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveAssetPath', () => {
  it('serves a file within an allowed root', () => {
    const target = join(worktree, 'docs', 'img.png')
    expect(resolveAssetPath(target, [worktree])).toBe(realpathSync.native(target))
  })

  it('rejects a path that escapes the allowed root', () => {
    const escape = join(worktree, 'docs', '..', '..', 'secret.txt')
    expect(resolveAssetPath(escape, [worktree])).toBeNull()
  })

  it('rejects a non-existent file', () => {
    expect(resolveAssetPath(join(worktree, 'nope.png'), [worktree])).toBeNull()
  })

  it('rejects when there are no allowed roots', () => {
    expect(resolveAssetPath(join(worktree, 'docs', 'img.png'), [])).toBeNull()
  })
})
