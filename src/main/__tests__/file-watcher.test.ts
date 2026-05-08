import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'simpleedit-fs-test-'))
const trashed: string[] = []

vi.mock('electron', () => ({
  shell: {
    trashItem: async (path: string): Promise<void> => {
      trashed.push(path)
      // Mimic OS trash by physically removing the path so subsequent
      // existsSync()s reflect deletion.
      rmSync(path, { recursive: true, force: true })
    }
  }
}))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

let createFile: typeof import('../file-watcher').createFile
let createDirectory: typeof import('../file-watcher').createDirectory
let renamePath: typeof import('../file-watcher').renamePath
let deletePath: typeof import('../file-watcher').deletePath

beforeEach(async () => {
  trashed.length = 0
  const mod = await import('../file-watcher')
  createFile = mod.createFile
  createDirectory = mod.createDirectory
  renamePath = mod.renamePath
  deletePath = mod.deletePath
})

function uniqueDir(prefix: string): string {
  const dir = join(tmpRoot, `${prefix}-${Math.random().toString(36).slice(2, 10)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('createFile', () => {
  it('creates an empty file at the given absolute path', () => {
    const dir = uniqueDir('create')
    const target = join(dir, 'new.ts')
    createFile(target)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe('')
  })

  it('creates intermediate directories for nested names', () => {
    const dir = uniqueDir('nested')
    const target = join(dir, 'a', 'b', 'c.ts')
    createFile(target)
    expect(existsSync(target)).toBe(true)
  })

  it('throws when the file already exists', () => {
    const dir = uniqueDir('exists')
    const target = join(dir, 'dup.ts')
    writeFileSync(target, 'hello')
    expect(() => createFile(target)).toThrow(/already exists/)
    // Original content is preserved.
    expect(readFileSync(target, 'utf-8')).toBe('hello')
  })

  it('rejects un-normalized paths (parent traversal, double separators)', () => {
    const dir = uniqueDir('traverse')
    // path.join() auto-normalizes, so build the unsafe input manually.
    expect(() => createFile(`${dir}/sub/../evil.ts`)).toThrow(/normalized/)
  })
})

describe('createDirectory', () => {
  it('creates a directory at the given absolute path', () => {
    const dir = uniqueDir('mkdir')
    const target = join(dir, 'newDir')
    createDirectory(target)
    expect(existsSync(target)).toBe(true)
  })

  it('throws when the directory already exists', () => {
    const dir = uniqueDir('mkdir-dup')
    expect(() => createDirectory(dir)).toThrow(/already exists/)
  })
})

describe('renamePath', () => {
  it('renames a file', () => {
    const dir = uniqueDir('rename')
    const oldPath = join(dir, 'a.ts')
    const newPath = join(dir, 'b.ts')
    writeFileSync(oldPath, 'x')
    renamePath(oldPath, newPath)
    expect(existsSync(oldPath)).toBe(false)
    expect(readFileSync(newPath, 'utf-8')).toBe('x')
  })

  it('is a no-op when source and destination are equal', () => {
    const dir = uniqueDir('rename-noop')
    const p = join(dir, 'a.ts')
    writeFileSync(p, 'x')
    expect(() => renamePath(p, p)).not.toThrow()
    expect(readFileSync(p, 'utf-8')).toBe('x')
  })

  it('throws when destination already exists (no clobber)', () => {
    const dir = uniqueDir('rename-clobber')
    const oldPath = join(dir, 'a.ts')
    const newPath = join(dir, 'b.ts')
    writeFileSync(oldPath, 'a')
    writeFileSync(newPath, 'b')
    expect(() => renamePath(oldPath, newPath)).toThrow(/already exists/)
    expect(readFileSync(newPath, 'utf-8')).toBe('b')
  })
})

describe('deletePath', () => {
  it('moves the path to OS trash via shell.trashItem', async () => {
    const dir = uniqueDir('delete')
    const target = join(dir, 'gone.ts')
    writeFileSync(target, 'bye')
    await deletePath(target)
    expect(trashed).toEqual([target])
    expect(existsSync(target)).toBe(false)
  })
})
