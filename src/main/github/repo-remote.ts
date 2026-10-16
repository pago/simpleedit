import simpleGit from 'simple-git'

/**
 * `owner/repo` on a GitHub host from a remote url: `https://host/owner/repo(.git)`,
 * `ssh://git@host/owner/repo.git` or scp-style `git@host:owner/repo.git`.
 */
export function parseGithubRemote(remote: string): { host: string; owner: string; repo: string } | null {
  const trimmed = remote.trim()
  const scp = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(trimmed)
  if (scp) return { host: scp[1]!, owner: scp[2]!, repo: scp[3]! }
  try {
    const url = new URL(trimmed)
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null
    const [owner, repo] = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/')
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null
    return { host: url.hostname, owner, repo }
  } catch {
    return null
  }
}

/** The PR url of number `pr` in the repo at `repoPath` (bare or not), from its `origin` remote, else its first. */
export async function prUrlInRepo(repoPath: string, pr: number): Promise<string> {
  const remotes = await simpleGit(repoPath).getRemotes(true)
  const remote = remotes.find((candidate) => candidate.name === 'origin') ?? remotes[0]
  const parsed = remote ? parseGithubRemote(remote.refs.fetch || remote.refs.push) : null
  if (!parsed) throw new Error('This project has no GitHub remote; pass the PR url instead of its number')
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/pull/${pr}`
}
