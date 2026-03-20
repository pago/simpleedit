import simpleGit from 'simple-git'
import type { GitCommitInfo, DiffFileEntry } from '../shared/ipc-types'

export async function getCommitLog(
  worktreePath: string,
  count: number = 50
): Promise<GitCommitInfo[]> {
  const git = simpleGit(worktreePath)
  // Explicitly resolve the worktree's HEAD to avoid bare-repo default branch confusion
  const head = await git.revparse(['HEAD'])
  const log = await git.log({ maxCount: count, from: head.trim() })

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
