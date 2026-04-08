import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
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
