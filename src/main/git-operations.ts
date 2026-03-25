import simpleGit from 'simple-git'
import { watch, type FSWatcher } from 'chokidar'
import type { WebContents } from 'electron'
import type { GitCommitInfo, DiffFileEntry } from '../shared/ipc-types'

// ── Git watching ──────────────────────────────────────────────

const STATUS_POLL_INTERVAL = 3000 // ms

interface GitWatchState {
  refsWatcher: FSWatcher
  pollTimer: ReturnType<typeof setInterval>
  lastStatusSnapshot: string
  webContents: WebContents
  worktreePath: string
}

const gitWatchers = new Map<string, GitWatchState>()

/**
 * Watch a worktree for git state changes:
 * 1. Native FS watch on refs/heads + index (detects commits, staging)
 * 2. Periodic `git status --porcelain` poll (detects working tree changes)
 *
 * Emits:
 * - `git:refs-changed`   — on commit/staging/branch changes (instant via FSEvents)
 * - `git:status-changed`  — when working tree dirty state changes (polled)
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

  const refsWatcher = watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    // Git writes refs atomically (write tmp + rename), so watch for adds too
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 50 }
  })

  const emitRefs = (): void => {
    if (!webContents.isDestroyed()) {
      webContents.send('git:refs-changed', { worktreePath })
    }
    // Also trigger an immediate status check since refs changes often
    // accompany status changes (e.g. commit clears staged files)
    checkStatus(worktreePath)
  }

  refsWatcher.on('add', emitRefs)
  refsWatcher.on('change', emitRefs)
  refsWatcher.on('unlink', emitRefs)

  // Take initial status snapshot
  const initialSnapshot = await getStatusSnapshot(worktreePath)

  // Start periodic status polling
  const pollTimer = setInterval(() => checkStatus(worktreePath), STATUS_POLL_INTERVAL)

  gitWatchers.set(worktreePath, {
    refsWatcher,
    pollTimer,
    lastStatusSnapshot: initialSnapshot,
    webContents,
    worktreePath
  })
}

async function getStatusSnapshot(worktreePath: string): Promise<string> {
  try {
    const git = simpleGit(worktreePath)
    return await git.raw(['status', '--porcelain'])
  } catch {
    return ''
  }
}

async function checkStatus(worktreePath: string): Promise<void> {
  const state = gitWatchers.get(worktreePath)
  if (!state) return

  const snapshot = await getStatusSnapshot(worktreePath)
  if (snapshot !== state.lastStatusSnapshot) {
    state.lastStatusSnapshot = snapshot
    if (!state.webContents.isDestroyed()) {
      state.webContents.send('git:status-changed', { worktreePath })
    }
  }
}

/**
 * Trigger an immediate status check for a worktree.
 * Called when Claude touches a file so the UI updates without
 * waiting for the next poll cycle.
 */
export function triggerStatusCheck(worktreePath: string): void {
  checkStatus(worktreePath)
}

export function unwatchGitRefs(worktreePath: string): void {
  const state = gitWatchers.get(worktreePath)
  if (state) {
    state.refsWatcher.close()
    clearInterval(state.pollTimer)
    gitWatchers.delete(worktreePath)
  }
}

export function unwatchAllGitRefs(): void {
  for (const state of gitWatchers.values()) {
    state.refsWatcher.close()
    clearInterval(state.pollTimer)
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
    // First commit — diff against the empty tree (computed dynamically to support SHA-256 repos)
    const emptyTree = (await git.raw(['hash-object', '-t', 'tree', '/dev/null'])).trim()
    return git.diff([emptyTree, commitHash])
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
    // First commit — diff against the empty tree (computed dynamically)
    const emptyTree = (await git.raw(['hash-object', '-t', 'tree', '/dev/null'])).trim()
    return git.raw([
      'diff-tree', '--no-commit-id', '-r', '--name-status',
      emptyTree, commitHash
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

/**
 * Get the unified diff of the current branch against its merge-base with main.
 * Includes uncommitted changes if present.
 */
export async function getBranchDiff(worktreePath: string): Promise<string> {
  const git = simpleGit(worktreePath)
  // Find the merge-base with main
  const mergeBase = (await git.raw(['merge-base', 'main', 'HEAD'])).trim()
  // Diff from merge-base to working tree (includes staged + unstaged)
  const diff = await git.diff([mergeBase])
  return diff
}

/**
 * List files changed on the current branch relative to main (including uncommitted).
 */
export async function getBranchFiles(worktreePath: string): Promise<DiffFileEntry[]> {
  const git = simpleGit(worktreePath)
  const mergeBase = (await git.raw(['merge-base', 'main', 'HEAD'])).trim()
  const raw = await git.raw(['diff', '--name-status', mergeBase])
  return parseNameStatus(raw)
}

/**
 * Get file content at the merge-base of the current branch with main.
 */
export async function getFileAtBranchBase(
  worktreePath: string,
  filePath: string
): Promise<string> {
  const git = simpleGit(worktreePath)
  try {
    const mergeBase = (await git.raw(['merge-base', 'main', 'HEAD'])).trim()
    return await git.show([`${mergeBase}:${filePath}`])
  } catch {
    return ''
  }
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
