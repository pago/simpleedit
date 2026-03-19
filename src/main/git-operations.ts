import simpleGit from 'simple-git'
import type { GitCommitInfo } from '../shared/ipc-types'

/**
 * Get recent commit log for a worktree.
 */
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

/**
 * Get the unified diff for a specific commit.
 * For the first commit (no parent), diffs against an empty tree.
 */
export async function getCommitDiff(
  worktreePath: string,
  commitHash: string
): Promise<string> {
  const git = simpleGit(worktreePath)
  const diff = await git.diff([`${commitHash}~1`, commitHash]).catch(async () => {
    // If there's no parent (first commit), diff against empty tree
    return git.diff(['4b825dc642cb6eb9a060e54bf899d15f3f0bcf37', commitHash])
  })
  return diff
}
