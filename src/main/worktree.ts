import simpleGit from 'simple-git'
import { join, dirname, basename } from 'path'
import type { WorktreeInfo } from '../shared/ipc-types'

/**
 * Parse `git worktree list --porcelain` output into WorktreeInfo[].
 *
 * Porcelain format emits blocks separated by blank lines:
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/branch-name
 *   (blank line)
 *
 * Bare repos show "bare" instead of a branch line.
 */
function parsePorcelain(raw: string): WorktreeInfo[] {
  const results: WorktreeInfo[] = []
  const blocks = raw.trim().split('\n\n')

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    let path = ''
    let branch = ''
    let isBare = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace('refs/heads/', '')
      } else if (line === 'bare') {
        isBare = true
      } else if (line.startsWith('detached')) {
        branch = '(detached)'
      }
    }

    // Skip the bare repo entry itself — it's not a usable worktree
    if (isBare) continue
    if (!path) continue

    results.push({
      path,
      branch,
      isMain: branch === 'main' || branch === 'master',
      isCurrent: false
    })
  }

  return results
}

export async function listWorktrees(bareRepoPath: string): Promise<WorktreeInfo[]> {
  const git = simpleGit(bareRepoPath)
  const raw = await git.raw(['worktree', 'list', '--porcelain'])
  return parsePorcelain(raw)
}

export async function createWorktree(
  bareRepoPath: string,
  name: string,
  baseBranch?: string
): Promise<WorktreeInfo> {
  const git = simpleGit(bareRepoPath)
  const parentDir = dirname(bareRepoPath)
  const worktreePath = join(parentDir, name)

  const args = ['worktree', 'add', worktreePath]
  if (baseBranch) {
    // Create a new branch `name` based on `baseBranch`
    args.push('-b', name, baseBranch)
  } else {
    args.push('-b', name)
  }

  await git.raw(args)

  return {
    path: worktreePath,
    branch: name,
    isMain: false,
    isCurrent: false
  }
}

export async function removeWorktree(
  bareRepoPath: string,
  worktreePath: string
): Promise<void> {
  const git = simpleGit(bareRepoPath)
  await git.raw(['worktree', 'remove', worktreePath, '--force'])
}
