import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
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

export function readFile(filePath: string): string {
  return readFileSync(filePath, 'utf-8')
}

export function writeFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8')
}
