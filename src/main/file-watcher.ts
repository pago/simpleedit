import {
  readdirSync, readFileSync, writeFileSync,
  closeSync, openSync, mkdirSync, renameSync, existsSync,
} from 'fs'
import { join, dirname, isAbsolute, basename, normalize } from 'path'
import { shell } from 'electron'
import simpleGit from 'simple-git'
import type { FileEntry } from '../shared/ipc-types'

export function listDirectory(dirPath: string): FileEntry[] {
  const entries = readdirSync(dirPath, { withFileTypes: true })

  const mapped: FileEntry[] = entries
    .filter((e) => e.name !== '.git')
    .map((e) => ({
      name: e.name,
      path: join(dirPath, e.name),
      isDirectory: e.isDirectory()
    }))

  mapped.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })

  return mapped
}

/**
 * List all files in a worktree using git ls-files (tracked + untracked).
 * Returns relative paths sorted alphabetically.
 */
export async function listAllFiles(worktreePath: string): Promise<string[]> {
  const git = simpleGit(worktreePath)
  const [tracked, untracked] = await Promise.all([
    git.raw(['ls-files']),
    git.raw(['ls-files', '--others', '--exclude-standard'])
  ])

  const files = new Set<string>()
  for (const line of tracked.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) files.add(trimmed)
  }
  for (const line of untracked.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) files.add(trimmed)
  }

  return [...files].sort()
}

export function readFile(filePath: string): string {
  return readFileSync(filePath, 'utf-8')
}

export function writeFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8')
}

function assertSafePath(p: string): void {
  if (!isAbsolute(p)) throw new Error(`Path must be absolute: ${p}`)
  // Reject any path that would change under normalization — `..` segments,
  // duplicate separators, etc. A clean absolute path is the only thing we
  // accept from the renderer.
  if (normalize(p) !== p) throw new Error(`Path must be normalized: ${p}`)
}

function assertSafeName(name: string): void {
  if (!name) throw new Error('Name cannot be empty')
  // Allow nested paths (foo/bar.ts) but not absolute, parent traversal, or
  // segments that resolve outside the target directory.
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new Error('Name must be relative')
  }
  const segments = name.split(/[\\/]/)
  if (segments.some((s) => s === '..' || s === '.' || s === '')) {
    throw new Error('Name cannot contain "." or ".." segments')
  }
}

export function createFile(filePath: string): void {
  assertSafePath(filePath)
  assertSafeName(basename(filePath))
  if (existsSync(filePath)) {
    throw new Error(`File already exists: ${filePath}`)
  }
  mkdirSync(dirname(filePath), { recursive: true })
  // 'wx' = create exclusively; throws if a file appears between the check above
  // and the open call (TOCTOU-safe).
  closeSync(openSync(filePath, 'wx'))
}

export function createDirectory(dirPath: string): void {
  assertSafePath(dirPath)
  assertSafeName(basename(dirPath))
  if (existsSync(dirPath)) {
    throw new Error(`Path already exists: ${dirPath}`)
  }
  mkdirSync(dirPath, { recursive: true })
}

export function renamePath(oldPath: string, newPath: string): void {
  assertSafePath(oldPath)
  assertSafePath(newPath)
  if (oldPath === newPath) return
  if (!existsSync(oldPath)) {
    throw new Error(`Source does not exist: ${oldPath}`)
  }
  if (existsSync(newPath)) {
    throw new Error(`Destination already exists: ${newPath}`)
  }
  mkdirSync(dirname(newPath), { recursive: true })
  renameSync(oldPath, newPath)
}

export async function deletePath(targetPath: string): Promise<void> {
  assertSafePath(targetPath)
  // Move to OS trash so the user can recover. Throws if the path is missing
  // or the OS refuses (e.g. permission denied, no Trash on this volume).
  await shell.trashItem(targetPath)
}
