import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { RecentRepo } from '../shared/ipc-types'

const MAX_RECENT = 10

function configDir(): string {
  const dir = join(app.getPath('userData'), 'config')
  mkdirSync(dir, { recursive: true })
  return dir
}

function filePath(): string {
  return join(configDir(), 'recent-repos.json')
}

export function getRecentRepos(): RecentRepo[] {
  try {
    const raw = readFileSync(filePath(), 'utf-8')
    return JSON.parse(raw) as RecentRepo[]
  } catch {
    return []
  }
}

export function addRecentRepo(repoPath: string): void {
  const repos = getRecentRepos().filter((r) => r.path !== repoPath)

  const name = repoPath.split('/').pop()?.replace('.git', '') ?? repoPath

  repos.unshift({
    path: repoPath,
    name,
    lastOpened: new Date().toISOString()
  })

  // Keep only the most recent
  const trimmed = repos.slice(0, MAX_RECENT)
  writeFileSync(filePath(), JSON.stringify(trimmed, null, 2), 'utf-8')
}
