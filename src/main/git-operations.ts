import simpleGit from 'simple-git'
import { watch, type FSWatcher } from 'chokidar'
import type { WebContents } from 'electron'
import type { GitCommitInfo, DiffFileEntry } from '../shared/ipc-types'

// ── Git directory watching ──────────────────────────────────

const gitWatchers = new Map<string, FSWatcher>()

/**
 * Watch the git directory (refs, index) for a worktree so we can detect
 * commits, branch changes, and staging changes.
 *
 * For bare-repo worktrees the actual git dir lives outside the worktree
 * (e.g. `<bare>/worktrees/<name>/`), so we resolve it via `rev-parse`.
 */
export async function watchGitRefs(
  worktreePath: string,
  webContents: WebContents
): Promise<void> {
  // Don't double-watch
  if (gitWatchers.has(worktreePath)) return

  const git = simpleGit(worktreePath)

  // Resolve paths — git-dir is the worktree-specific dir,
  // git-common-dir is the shared bare repo dir with refs/
  const [gitDir, commonDir] = await Promise.all([
    git.revparse(['--git-dir']),
    git.revparse(['--git-common-dir'])
  ])

  const watchPaths = [
    `${commonDir}/refs/heads`,  // branch tip changes (commits)
    `${gitDir}/index`           // staging changes
  ]

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    // Git writes refs atomically (write tmp + rename), so watch for adds too
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 50 }
  })

  const emit = (): void => {
    if (!webContents.isDestroyed()) {
      webContents.send('git:refs-changed', { worktreePath })
    }
  }

  watcher.on('add', emit)
  watcher.on('change', emit)
  watcher.on('unlink', emit)

  gitWatchers.set(worktreePath, watcher)
}

export function unwatchGitRefs(worktreePath: string): void {
  const watcher = gitWatchers.get(worktreePath)
  if (watcher) {
    watcher.close()
    gitWatchers.delete(worktreePath)
  }
}

export function unwatchAllGitRefs(): void {
  for (const watcher of gitWatchers.values()) {
    watcher.close()
  }
  gitWatchers.clear()
}

export async function getCommitLog(
  worktreePath: string,
  count: number = 50
): Promise<GitCommitInfo[]> {
  const git = simpleGit(worktreePath)
  const log = await git.log({ maxCount: count })

  return log.all.map((entry) => ({
    hash: entry.hash,
    message: entry.message,
    author: entry.author_name,
    date: entry.date
  }))
}

export async function getCommitDiff(
  worktreePath: string,
  commitHash: string
): Promise<string> {
  const git = simpleGit(worktreePath)
  const diff = await git.diff([`${commitHash}~1`, commitHash]).catch(async () => {
    return git.diff(['4b825dc642cb6eb9a060e54bf899d15f3f0bcf37', commitHash])
  })
  return diff
}

/**
 * List files changed in a commit with their status (added/modified/deleted).
 */
export async function getCommitFiles(
  worktreePath: string,
  commitHash: string
): Promise<DiffFileEntry[]> {
  const git = simpleGit(worktreePath)
  // --name-status gives lines like "M\tsrc/foo.ts"
  const raw = await git.raw([
    'diff-tree', '--no-commit-id', '-r', '--name-status', commitHash
  ]).catch(async () => {
    // First commit — diff against empty tree
    return git.raw([
      'diff-tree', '--no-commit-id', '-r', '--name-status',
      '4b825dc642cb6eb9a060e54bf899d15f3f0bcf37', commitHash
    ])
  })

  return parseNameStatus(raw)
}

/**
 * Get file content at a specific commit.
 */
export async function getFileAtCommit(
  worktreePath: string,
  commitHash: string,
  filePath: string
): Promise<string> {
  const git = simpleGit(worktreePath)
  try {
    return await git.show([`${commitHash}:${filePath}`])
  } catch {
    return '' // File didn't exist at this commit
  }
}

/**
 * Get staging (uncommitted) diff — both staged and unstaged changes.
 */
export async function getStagingFiles(
  worktreePath: string
): Promise<DiffFileEntry[]> {
  const git = simpleGit(worktreePath)

  // Get combined status of working tree
  const status = await git.status()

  const files: DiffFileEntry[] = []
  const seen = new Set<string>()

  for (const f of status.modified) {
    if (!seen.has(f)) { seen.add(f); files.push({ path: f, status: 'modified' }) }
  }
  for (const f of status.staged) {
    if (!seen.has(f)) { seen.add(f); files.push({ path: f, status: 'modified' }) }
  }
  for (const f of status.created) {
    if (!seen.has(f)) { seen.add(f); files.push({ path: f, status: 'added' }) }
  }
  for (const f of status.deleted) {
    if (!seen.has(f)) { seen.add(f); files.push({ path: f, status: 'deleted' }) }
  }
  for (const f of status.renamed) {
    if (!seen.has(f.to)) { seen.add(f.to); files.push({ path: f.to, status: 'modified' }) }
  }
  for (const f of status.not_added) {
    if (!seen.has(f)) { seen.add(f); files.push({ path: f, status: 'added' }) }
  }

  return files
}

/**
 * Get file content from HEAD (last committed version).
 */
export async function getFileAtHead(
  worktreePath: string,
  filePath: string
): Promise<string> {
  const git = simpleGit(worktreePath)
  try {
    return await git.show([`HEAD:${filePath}`])
  } catch {
    return ''
  }
}

/**
 * Get the unified diff for staging (uncommitted changes).
 */
export async function getStagingDiff(
  worktreePath: string
): Promise<string> {
  const git = simpleGit(worktreePath)
  // Show both staged and unstaged changes against HEAD
  const diff = await git.diff(['HEAD'])
  return diff
}

function parseNameStatus(raw: string): DiffFileEntry[] {
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [statusChar, ...pathParts] = line.split('\t')
      const path = pathParts.join('\t') // handle paths with tabs (unlikely but safe)
      let status: DiffFileEntry['status'] = 'modified'
      if (statusChar === 'A') status = 'added'
      else if (statusChar === 'D') status = 'deleted'
      else if (statusChar?.startsWith('R')) status = 'modified' // renamed
      return { path, status }
    })
}
