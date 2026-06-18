import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'
import type { SerializedSession } from '../shared/ipc-types'

function sessionsDir(): string {
  const dir = join(app.getPath('userData'), 'config', 'sessions')
  mkdirSync(dir, { recursive: true })
  return dir
}

function fileFor(repoPath: string): string {
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 16)
  return join(sessionsDir(), `${hash}.json`)
}

export function saveSession(payload: SerializedSession): void {
  const target = fileFor(payload.repoPath)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
  renameSync(tmp, target)
}

export function loadSession(repoPath: string): SerializedSession | null {
  try {
    const raw = readFileSync(fileFor(repoPath), 'utf-8')
    const parsed = JSON.parse(raw) as SerializedSession
    // v2 = pre-grouping (no `groups`; hydrates as all-standalone), v3 = grouped.
    if (parsed.version !== 2 && parsed.version !== 3) return null
    if (parsed.repoPath !== repoPath) return null
    return parsed
  } catch {
    return null
  }
}

export function clearSession(repoPath: string): void {
  try {
    unlinkSync(fileFor(repoPath))
  } catch { /* file may not exist */ }
}
