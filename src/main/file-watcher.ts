import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join, basename } from 'path'
import { watch, type FSWatcher } from 'chokidar'
import type { WebContents } from 'electron'
import type { FileEntry } from '../shared/ipc-types'

const IGNORED = ['node_modules', '.git', 'out', 'dist']

const watchers = new Map<string, FSWatcher>()

export function listDirectory(dirPath: string): FileEntry[] {
  const entries = readdirSync(dirPath, { withFileTypes: true })

  const mapped: FileEntry[] = entries
    .filter((e) => !IGNORED.includes(e.name) && !e.name.startsWith('.'))
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

export function watchDirectory(worktreePath: string, webContents: WebContents): void {
  // Stop any existing watcher for this path
  const existing = watchers.get(worktreePath)
  if (existing) {
    existing.close()
  }

  const watcher = watch(worktreePath, {
    ignored: [
      /(^|[/\\])\./,  // dotfiles/dirs
      ...IGNORED.map((p) => `**/${p}/**`)
    ],
    ignoreInitial: true,
    persistent: true,
    depth: 3
  })

  const emit = (filePath: string, event: 'add' | 'change' | 'unlink'): void => {
    if (!webContents.isDestroyed()) {
      webContents.send('fs:changed', { path: filePath, event })
    }
  }

  watcher.on('add', (p) => emit(p, 'add'))
  watcher.on('change', (p) => emit(p, 'change'))
  watcher.on('unlink', (p) => emit(p, 'unlink'))
  watcher.on('addDir', (p) => emit(p, 'add'))
  watcher.on('unlinkDir', (p) => emit(p, 'unlink'))

  watchers.set(worktreePath, watcher)
}

export function unwatchAll(): void {
  for (const watcher of watchers.values()) {
    watcher.close()
  }
  watchers.clear()
}

export function readFile(filePath: string): string {
  return readFileSync(filePath, 'utf-8')
}

export function writeFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8')
}
