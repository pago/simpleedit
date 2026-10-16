/**
 * Read-only checkouts of a review's PR heads, for a companion that needs code
 * outside the diff (`checkout_review_head`).
 *
 * Main owns all of it, under userData: a partial bare clone per GitHub repo
 * (`review-repos/<host>/<owner>/<repo>.git`, `--filter=blob:none`, shared by
 * every review of that repo) and a detached worktree per layer
 * (`review-checkouts/<reviewId>/<pr>`). The user's own bare repos are never
 * touched, so no worktree watcher or picker ever sees these, and a PR from a
 * repo no window has open works the same.
 *
 * Owner, repo and host come from a PR URL an agent may have supplied, and
 * become path segments and a fetch URL, so they are held to GitHub's own
 * naming rules before anything is built from them.
 */
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { lstat, mkdir, readdir, readFile, rm, utimes, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { simpleGit } from 'simple-git'
import { agentEnv } from './lib/agent-env'
import { isOwnerName } from '../shared/screenprs-filter'
import { isReviewId, type Review } from '../shared/review-room'

export const REVIEW_CACHE_CAP_BYTES = 5 * 1024 ** 3
export const REVIEW_CHECKOUT_IDLE_MS = 14 * 24 * 60 * 60 * 1000

/** Marker inside a cache repo whose mtime is its last use (LRU order). */
const LAST_USED = 'simpleedit-last-used'

let rootOverride: string | null = null

/** Test seam: where `review-repos/` and `review-checkouts/` live. */
export function setReviewCacheRootForTests(dir: string | null): void {
  rootOverride = dir
}

function userRoot(): string {
  return rootOverride ?? app.getPath('userData')
}

export function reviewReposRoot(): string {
  return join(userRoot(), 'review-repos')
}

export function reviewCheckoutsRoot(): string {
  return join(userRoot(), 'review-checkouts')
}

export interface PrLocation {
  host: 'github.com'
  owner: string
  repo: string
  number: number
}

/** GitHub's repository-name characters; `.` and `..` are not names. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/

/** A github.com pull-request URL taken apart and validated. Throws the reason. */
export function parseReviewPrUrl(raw: string): PrLocation {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Not a pull-request URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Not a github.com pull-request URL')
  if (url.hostname.toLowerCase() !== 'github.com') throw new Error('Checkouts are only available for github.com pull requests')
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname)
  if (!match) throw new Error('Not a pull-request URL')
  const [, owner, repo, num] = match as unknown as [string, string, string, string]
  if (!isOwnerName(owner)) throw new Error(`"${owner}" is not a GitHub owner`)
  if (!REPO_NAME.test(repo) || repo === '.' || repo === '..' || repo.toLowerCase().endsWith('.git')) {
    throw new Error(`"${repo}" is not a GitHub repository name`)
  }
  const number = Number(num)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Not a pull-request number')
  return { host: 'github.com', owner, repo, number }
}

/** `child` must resolve to somewhere strictly inside `root`. */
function inside(root: string, child: string): string {
  const full = resolve(child)
  if (!full.startsWith(resolve(root) + sep)) throw new Error('Refusing a path outside the review cache')
  return full
}

export function reviewCheckoutDir(reviewId: string): string {
  if (!isReviewId(reviewId)) throw new Error('Malformed review id')
  return inside(reviewCheckoutsRoot(), join(reviewCheckoutsRoot(), reviewId))
}

/**
 * The review's checkout dir, created empty if missing. Done before a
 * companion launches: it is granted read access to this dir at launch, so a
 * later checkout needs neither a relaunch nor a permission prompt.
 */
export function ensureReviewCheckoutDir(reviewId: string): string {
  const dir = reviewCheckoutDir(reviewId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function repoCacheDir(loc: Pick<PrLocation, 'host' | 'owner' | 'repo'>): string {
  return inside(reviewReposRoot(), join(reviewReposRoot(), loc.host, loc.owner, `${loc.repo}.git`))
}

// -- git --------------------------------------------------------------------

export type GitRunner = (dir: string, args: string[]) => Promise<string>

/**
 * Variables simple-git refuses in an explicit env (each runs a program or
 * redirects config), none of which a non-interactive https fetch needs.
 */
const UNSAFE_GIT_ENV = /^(?:EDITOR|PAGER|SSH_ASKPASS|PREFIX|GIT_(?:EDITOR|SEQUENCE_EDITOR|PAGER|ASKPASS|SSH|SSH_COMMAND|PROXY_COMMAND|TEMPLATE_DIR|EXEC_PATH|CONFIG(?:_.*)?))$/

export function reviewGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = agentEnv(base)
  for (const key of Object.keys(env)) if (UNSAFE_GIT_ENV.test(key)) delete env[key]
  return { ...env, GIT_TERMINAL_PROMPT: '0' }
}

/**
 * Credentials from the user's `gh` login, and only from there: the empty
 * helper resets any configured one first. `-c` reaches the lazy blob fetches a
 * partial clone's checkout runs, through `GIT_CONFIG_PARAMETERS`.
 */
const defaultRunGit: GitRunner = (dir, args) =>
  simpleGit({
    baseDir: dir,
    config: ['credential.helper=', 'credential.helper=!gh auth git-credential'],
    unsafe: { allowUnsafeCredentialHelper: true },
  })
    .env(reviewGitEnv())
    .raw(args)

let runGit: GitRunner = defaultRunGit

/** Test seam: replace every git call. `null` restores the real one. */
export function setGitRunnerForTests(runner: GitRunner | null): void {
  runGit = runner ?? defaultRunGit
}

const locks = new Map<string, Promise<unknown>>()

/** One operation per cache repo at a time: two fetches into one bare repo race on its refs and packs. */
function withRepoLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(repoDir) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(repoDir, tail)
  void tail.then(() => {
    if (locks.get(repoDir) === tail) locks.delete(repoDir)
  })
  return run
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

async function hasCommit(repoDir: string, sha: string): Promise<boolean> {
  try {
    await runGit(repoDir, ['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

async function headOf(dir: string): Promise<string | null> {
  if (!existsSync(join(dir, '.git'))) return null
  try {
    return (await runGit(dir, ['rev-parse', 'HEAD'])).trim()
  } catch {
    return null
  }
}

async function ensureCacheRepo(repoDir: string, loc: PrLocation): Promise<void> {
  if (!existsSync(join(repoDir, 'HEAD'))) {
    await mkdir(repoDir, { recursive: true })
    await runGit(repoDir, ['init', '--bare'])
  }
  // Set every time rather than `remote add` once: idempotent, and a repo left
  // half-initialised by an interrupted first run repairs itself.
  await runGit(repoDir, ['config', 'remote.origin.url', `https://${loc.host}/${loc.owner}/${loc.repo}.git`])
  await runGit(repoDir, ['config', 'remote.origin.promisor', 'true'])
  await runGit(repoDir, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
}

async function touch(path: string): Promise<void> {
  const now = new Date()
  try {
    await utimes(path, now, now)
  } catch {
    await writeFile(path, '')
  }
}

/**
 * The absolute path of a detached worktree at the layer's recorded head,
 * fetching it first when the cache lacks it. Reused when one already sits at
 * that head. `pr` absent: the top layer.
 */
export async function checkoutReviewHead(review: Review, pr?: number): Promise<{ path: string; pr: number; headSha: string }> {
  const layer = pr === undefined ? review.layers.at(-1) : review.layers.find((candidate) => candidate.number === pr)
  if (!layer) throw new Error(pr === undefined ? 'This review has no layers' : `PR #${pr} is not a layer of this review`)
  if (!SHA.test(layer.headSha)) throw new Error('The layer has no head commit recorded')
  const loc = parseReviewPrUrl(layer.url)
  if (loc.number !== layer.number) throw new Error('The layer URL does not match its PR number')
  const dest = inside(reviewCheckoutsRoot(), join(reviewCheckoutDir(review.id), String(layer.number)))
  const repoDir = repoCacheDir(loc)

  let fetched = false
  const path = await withRepoLock(repoDir, async () => {
    await ensureCacheRepo(repoDir, loc)
    await touch(join(repoDir, LAST_USED))
    if ((await headOf(dest)) === layer.headSha) {
      await touch(dest)
      return dest
    }
    if (!(await hasCommit(repoDir, layer.headSha))) {
      // The PR's own ref on the base repo, which holds fork PRs too; then the
      // recorded SHA itself, for a head that has since moved on.
      await runGit(repoDir, ['fetch', '--filter=blob:none', '--no-tags', 'origin', `+refs/pull/${loc.number}/head:refs/review/pull/${loc.number}`])
      fetched = true
      if (!(await hasCommit(repoDir, layer.headSha))) {
        await runGit(repoDir, ['fetch', '--filter=blob:none', '--no-tags', 'origin', layer.headSha]).catch(() => '')
      }
      if (!(await hasCommit(repoDir, layer.headSha))) throw new Error(`GitHub no longer has ${layer.headSha.slice(0, 12)} for PR #${loc.number}`)
    }
    if (existsSync(dest)) {
      await rm(dest, { recursive: true, force: true })
      await runGit(repoDir, ['worktree', 'prune'])
    }
    await mkdir(dirname(dest), { recursive: true })
    await runGit(repoDir, ['worktree', 'add', '--detach', dest, layer.headSha])
    return dest
  })
  if (fetched) void sweepRepoCache().catch((err: unknown) => console.warn('[ReviewCheckout] Cache sweep failed:', err))
  return { path, pr: layer.number, headSha: layer.headSha }
}

// -- removal and sweeps -------------------------------------------------------

/** The cache repo a worktree belongs to, from its `.git` file. */
async function repoOfWorktree(dir: string): Promise<string | null> {
  try {
    const text = await readFile(join(dir, '.git'), 'utf8')
    const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim()
    if (!gitdir) return null
    const repo = resolve(gitdir, '..', '..')
    return repo.startsWith(resolve(reviewReposRoot()) + sep) ? repo : null
  } catch {
    return null
  }
}

async function removeCheckout(dir: string): Promise<void> {
  const repo = await repoOfWorktree(dir)
  await rm(dir, { recursive: true, force: true })
  if (repo && existsSync(repo)) {
    await withRepoLock(repo, () => runGit(repo, ['worktree', 'prune'])).catch(() => '')
  }
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * Remove a review's checkouts (submit, discard, sweep). `keepDir` leaves the
 * review's own dir in place, empty, for a companion that may still be running
 * with read access granted to it.
 */
export async function removeReviewCheckouts(reviewId: string, opts: { keepDir?: boolean } = {}): Promise<void> {
  const dir = reviewCheckoutDir(reviewId)
  for (const name of await entries(dir)) await removeCheckout(join(dir, name))
  if (!opts.keepDir) await rm(dir, { recursive: true, force: true })
}

async function sizeOf(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const name of await entries(path)) total += await sizeOf(join(path, name))
  return total
}

async function mtimeOf(path: string): Promise<number> {
  try {
    return (await lstat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function cacheRepos(): Promise<string[]> {
  const root = reviewReposRoot()
  const repos: string[] = []
  for (const host of await entries(root)) {
    for (const owner of await entries(join(root, host))) {
      for (const repo of await entries(join(root, host, owner))) {
        if (repo.endsWith('.git')) repos.push(join(root, host, owner, repo))
      }
    }
  }
  return repos
}

/** Every checkout dir backed by `repo`, from its `worktrees/*\/gitdir` records. */
async function worktreesOf(repo: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await entries(join(repo, 'worktrees'))) {
    try {
      const gitFile = (await readFile(join(repo, 'worktrees', name, 'gitdir'), 'utf8')).trim()
      const dir = dirname(gitFile)
      if (resolve(dir).startsWith(resolve(reviewCheckoutsRoot()) + sep)) out.push(dir)
    } catch {
      /* a record without its gitdir is what `worktree prune` drops */
    }
  }
  return out
}

let sweeping: Promise<void> = Promise.resolve()

/**
 * Evict least-recently-used cache repos until the cache fits `capBytes`. A
 * repo goes with its worktrees, which can't work without it. A repo in use is
 * never evicted. Sweeps run one after another.
 */
export function sweepRepoCache(capBytes = REVIEW_CACHE_CAP_BYTES): Promise<void> {
  const run = sweeping.then(async () => {
    const repos = await Promise.all(
      (await cacheRepos()).map(async (repo) => ({
        repo,
        size: await sizeOf(repo),
        used: (await mtimeOf(join(repo, LAST_USED))) || (await mtimeOf(repo)),
      })),
    )
    let total = repos.reduce((sum, r) => sum + r.size, 0)
    for (const { repo, size } of repos.sort((a, b) => a.used - b.used)) {
      if (total <= capBytes) break
      if (locks.has(repo)) continue
      await withRepoLock(repo, async () => {
        for (const dir of await worktreesOf(repo)) await rm(dir, { recursive: true, force: true })
        await rm(repo, { recursive: true, force: true })
      })
      console.log(`[ReviewCheckout] Evicted ${repo} (${Math.round(size / 1024 ** 2)} MB)`)
      total -= size
    }
  })
  sweeping = run.catch(() => undefined)
  return run
}

/**
 * At startup: drop the checkouts of reviews that are no longer open, and of
 * open ones untouched for `idleMs` (their dir stays, empty), then fit the
 * repo cache. `openReviews` maps each open review id to its last change.
 */
export async function sweepReviewCheckouts(
  openReviews: ReadonlyMap<string, string>,
  opts: { now?: number; idleMs?: number; capBytes?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now()
  const idleMs = opts.idleMs ?? REVIEW_CHECKOUT_IDLE_MS
  for (const name of await entries(reviewCheckoutsRoot())) {
    if (!isReviewId(name)) continue
    const updatedAt = openReviews.get(name)
    if (updatedAt === undefined) {
      await removeReviewCheckouts(name)
      continue
    }
    const dir = reviewCheckoutDir(name)
    for (const pr of await entries(dir)) {
      const used = Math.max(Date.parse(updatedAt) || 0, await mtimeOf(join(dir, pr)))
      if (now - used > idleMs) await removeCheckout(join(dir, pr))
    }
  }
  await sweepRepoCache(opts.capBytes)
}
