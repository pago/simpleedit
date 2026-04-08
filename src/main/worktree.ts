import simpleGit from 'simple-git'
import { join, dirname, basename } from 'path'
import { existsSync, mkdirSync } from 'fs'
import type { WorktreeInfo, BranchInfo } from '../shared/ipc-types'

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
      isMain: results.length === 0, // first entry from git worktree list is always the main worktree
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

  // Check if a branch with this name already exists (local or remote-tracking)
  const existing = await git.raw(['branch', '--list', name]).then((s) => s.trim())

  if (existing) {
    // Branch exists — just check it out into a new worktree
    await git.raw(['worktree', 'add', worktreePath, name])
  } else {
    const args = ['worktree', 'add', worktreePath]
    if (baseBranch) {
      args.push('-b', name, baseBranch)
    } else {
      args.push('-b', name)
    }
    await git.raw(args)
  }

  return {
    path: worktreePath,
    branch: name,
    isMain: false,
    isCurrent: false
  }
}

/**
 * Clone a repository as a bare repo and create a worktree for the default branch.
 * Returns the path to the bare repo directory.
 */
export async function cloneBareRepo(repoUrl: string, parentDir: string): Promise<string> {
  // Derive repo name from URL (e.g. "my-project" from "https://github.com/user/my-project.git")
  const urlBasename = repoUrl.split('/').pop() ?? repoUrl
  const repoName = urlBasename.replace(/\.git$/, '')
  const projectDir = join(parentDir, repoName)
  const bareRepoPath = join(projectDir, `${repoName}.git`)

  if (existsSync(projectDir)) {
    throw new Error(`Directory already exists: ${projectDir}`)
  }

  // Create the wrapper directory, then clone bare repo inside it
  mkdirSync(projectDir, { recursive: true })

  const git = simpleGit(projectDir)
  await git.raw(['clone', '--bare', repoUrl, bareRepoPath])

  // Determine the default branch (main or master)
  const bareGit = simpleGit(bareRepoPath)
  const branches = await bareGit.raw(['branch'])
  const branchList = branches
    .split('\n')
    .map((b) => b.replace(/^\*?\s+/, '').trim())
    .filter(Boolean)

  const defaultBranch = branchList.includes('main')
    ? 'main'
    : branchList.includes('master')
      ? 'master'
      : branchList[0] ?? null

  if (defaultBranch) {
    // Configure fetch refspec so `git fetch` works from worktrees
    await bareGit.raw([
      'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'
    ])

    const worktreePath = join(projectDir, defaultBranch)
    await bareGit.raw(['worktree', 'add', worktreePath, defaultBranch])
  }

  return bareRepoPath
}

/**
 * Check out an existing branch into a new worktree (no new branch created).
 */
export async function checkoutWorktree(
  bareRepoPath: string,
  branch: string
): Promise<WorktreeInfo> {
  const git = simpleGit(bareRepoPath)
  const parentDir = dirname(bareRepoPath)
  const worktreePath = join(parentDir, branch)

  await git.raw(['worktree', 'add', worktreePath, branch])

  return {
    path: worktreePath,
    branch,
    isMain: false,
    isCurrent: false
  }
}

/**
 * List branches available for checkout as worktrees.
 * Returns local + remote-tracking branches, excluding those already checked out.
 */
export async function listAvailableBranches(bareRepoPath: string): Promise<BranchInfo[]> {
  const git = simpleGit(bareRepoPath)

  // Fetch latest remote refs so the branch list is up-to-date
  try {
    await git.fetch()
  } catch {
    // Fetch may fail if no remote is configured — continue with local state
  }

  // Get all branches (local + remote)
  const raw = await git.raw(['branch', '-a', '--no-color'])
  const allBranches = raw
    .split('\n')
    .map((line) => line.replace(/^\*?\s+/, '').trim())
    .filter(Boolean)
    .filter((b) => !b.includes(' -> ')) // skip HEAD -> origin/main aliases

  // Get branches already checked out in worktrees
  const worktrees = await listWorktrees(bareRepoPath)
  const checkedOut = new Set(worktrees.map((w) => w.branch))

  // Separate local branches from remote-tracking branches
  const localBranches = new Set<string>()
  const remoteBranches = new Set<string>()
  for (const b of allBranches) {
    if (b.startsWith('remotes/origin/')) {
      remoteBranches.add(b.slice('remotes/origin/'.length))
    } else {
      localBranches.add(b)
    }
  }

  // Merge: a branch is remote-only if it has no local counterpart
  const seen = new Set<string>()
  const available: BranchInfo[] = []
  for (const name of [...localBranches, ...remoteBranches]) {
    if (seen.has(name) || checkedOut.has(name)) continue
    seen.add(name)
    available.push({ name, isRemote: !localBranches.has(name) })
  }

  return available.sort((a, b) => a.name.localeCompare(b.name))
}

export async function removeWorktree(
  bareRepoPath: string,
  worktreePath: string
): Promise<void> {
  const git = simpleGit(bareRepoPath)
  await git.raw(['worktree', 'remove', worktreePath, '--force'])
}
