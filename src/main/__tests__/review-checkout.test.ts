import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import {
  checkoutReviewHead,
  parseReviewPrUrl,
  removeReviewCheckouts,
  repoCacheDir,
  reviewGitEnv,
  runReviewGit,
  setProtectedReviews,
  reviewCheckoutDir,
  setGitRunnerForTests,
  setReviewCacheRootForTests,
  sweepRepoCache,
  sweepReviewCheckouts,
} from '../review-checkout'
import type { Review } from '../../shared/review-room'

const HEAD = 'c'.repeat(40)

function review(id = 'r_review01', headSha = HEAD): Review {
  return {
    id,
    repo: 'github.com/acme/app',
    layers: [{ url: 'https://github.com/acme/app/pull/7', number: 7, headSha }],
    status: 'open',
    companionAgent: { provider: 'claude', model: 'default' },
    lastSeenHead: {},
    readSteps: [],
    round: 1,
    submissions: [],
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
  }
}

/**
 * A fake git good enough for the module's own bookkeeping: `worktree add`
 * makes a dir whose `.git` points back at the repo, `rev-parse` reads it, and
 * fetches "deliver" the commit after a delay so overlapping runs would show.
 */
function fakeGit() {
  const calls: Array<{ dir: string; args: string[] }> = []
  const commits = new Set<string>()
  const heads = new Map<string, string>()
  let running = 0
  let maxRunning = 0
  const runner = async (dir: string, args: string[]): Promise<string> => {
    calls.push({ dir, args })
    const [cmd, sub] = args
    if (cmd === 'init') writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
    if (cmd === 'cat-file') {
      if (!commits.has(args[2]!.replace('^{commit}', ''))) throw new Error('missing')
    }
    if (cmd === 'fetch') {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
      commits.add(HEAD)
    }
    if (cmd === 'worktree' && sub === 'add') {
      const dest = args[3]!
      const sha = args[4]!
      mkdirSync(dest, { recursive: true })
      mkdirSync(join(dir, 'worktrees', 'w7'), { recursive: true })
      writeFileSync(join(dest, '.git'), `gitdir: ${join(dir, 'worktrees', 'w7')}\n`)
      writeFileSync(join(dir, 'worktrees', 'w7', 'gitdir'), join(dest, '.git'))
      heads.set(dest, sha)
    }
    if (cmd === 'rev-parse') return `${heads.get(dir) ?? ''}\n`
    return ''
  }
  return { runner, calls, commits, maxRunning: () => maxRunning }
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'se-checkout-'))
  setReviewCacheRootForTests(root)
})

afterEach(() => {
  setGitRunnerForTests(null)
  setProtectedReviews(null)
  setReviewCacheRootForTests(null)
  rmSync(root, { recursive: true, force: true })
})

describe('PR URL validation', () => {
  it('accepts a github.com PR', () => {
    expect(parseReviewPrUrl('https://github.com/acme/my.app_x-1/pull/42')).toEqual({ host: 'github.com', owner: 'acme', repo: 'my.app_x-1', number: 42 })
  })

  it.each([
    'https://github.com/../app/pull/1',
    'https://github.com/acme/../pull/1',
    'https://github.com/acme/%2E%2E/pull/1',
    'https://github.com/ac%2Fme/app/pull/1',
    'https://github.com/-acme/app/pull/1',
    'https://github.com/acme/app.git/pull/1',
    'https://github.com/acme/app/pull/0',
    'https://github.com/acme/app/issues/1',
    'https://evil.example/acme/app/pull/1',
    'https://github.com.evil.example/acme/app/pull/1',
    'http://github.com/acme/app/pull/1',
    'https://github.com:8443/acme/app/pull/1',
    'https://user@github.com/acme/app/pull/1',
    '--upload-pack=x',
  ])('refuses %s', (url) => {
    expect(() => parseReviewPrUrl(url)).toThrow()
  })

  it('keeps every cache path under its root', () => {
    expect(repoCacheDir({ host: 'github.com', owner: 'acme', repo: 'app' })).toBe(join(root, 'review-repos', 'github.com', 'acme', 'app.git'))
    expect(() => reviewCheckoutDir('../r_review01')).toThrow()
  })
})

describe('git env', () => {
  it('drops what simple-git refuses in an explicit env and never prompts', () => {
    const env = reviewGitEnv({ PATH: '/bin', EDITOR: 'vim', GIT_EDITOR: 'true', GIT_ASKPASS: 'x', GIT_CONFIG_COUNT: '1', CLAUDECODE: '1', HOME: '/h' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', GIT_TERMINAL_PROMPT: '0' })
  })
})

describe('checkout_review_head', () => {
  it('fetches the PR ref with gh credentials and adds a detached worktree at the head', async () => {
    const git = fakeGit()
    setGitRunnerForTests(git.runner)
    const result = await checkoutReviewHead(review())
    expect(result).toEqual({ path: join(root, 'review-checkouts', 'r_review01', '7'), pr: 7, headSha: HEAD })
    const args = git.calls.map((c) => c.args.join(' '))
    expect(args).toContain('config remote.origin.url https://github.com/acme/app.git')
    expect(args).toContain('fetch --filter=blob:none --no-tags origin +refs/pull/7/head:refs/review/pull/7')
    expect(args).toContain(`worktree add --detach ${result.path} ${HEAD}`)
  })

  it('reuses a checkout already at the head', async () => {
    const git = fakeGit()
    setGitRunnerForTests(git.runner)
    await checkoutReviewHead(review())
    const before = git.calls.length
    await checkoutReviewHead(review(), 7)
    const again = git.calls.slice(before).map((c) => c.args[0])
    expect(again).not.toContain('fetch')
    expect(again).not.toContain('worktree')
  })

  it('serialises fetches into one cache repo', async () => {
    const git = fakeGit()
    setGitRunnerForTests(git.runner)
    await Promise.all([checkoutReviewHead(review('r_review01')), checkoutReviewHead(review('r_review02'))])
    expect(git.maxRunning()).toBe(1)
    // The second found the commit the first fetched.
    expect(git.calls.filter((c) => c.args[0] === 'fetch')).toHaveLength(1)
  })

  it('refuses a layer that is not in the review and an unrecorded head', async () => {
    setGitRunnerForTests(fakeGit().runner)
    await expect(checkoutReviewHead(review(), 99)).rejects.toThrow('not a layer')
    await expect(checkoutReviewHead(review('r_review01', 'nope'))).rejects.toThrow('head')
  })
})

describe('symlinks', () => {
  it('checks a committed symlink out as a plain file, never a link out of the cache', async () => {
    const src = join(root, 'src')
    mkdirSync(src)
    await runReviewGit(src, ['init', '-q'])
    symlinkSync('/etc/hosts', join(src, 'escape'))
    await runReviewGit(src, ['add', 'escape'])
    await runReviewGit(src, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'link'])
    const sha = (await runReviewGit(src, ['rev-parse', 'HEAD'])).trim()
    const dest = join(root, 'co')
    await runReviewGit(src, ['worktree', 'add', '--detach', dest, sha])
    expect(lstatSync(join(dest, 'escape')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(dest, 'escape'), 'utf8')).toBe('/etc/hosts')
  })
})

describe('removal', () => {
  it('waits for a checkout in flight on the same repo', async () => {
    const git = fakeGit()
    setGitRunnerForTests(git.runner)
    // An existing checkout at an older head, which a new one is replacing.
    git.commits.add('d'.repeat(40))
    const old = (await checkoutReviewHead(review('r_review01', 'd'.repeat(40)))).path
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    setGitRunnerForTests(async (dir, args) => {
      if (args[0] === 'fetch') await gate
      return git.runner(dir, args)
    })
    const checkout = checkoutReviewHead(review())
    await new Promise((resolve) => setTimeout(resolve, 10))
    const removal = removeReviewCheckouts('r_review01')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(existsSync(old)).toBe(true)
    release()
    await checkout
    await removal
    expect(existsSync(reviewCheckoutDir('r_review01'))).toBe(false)
  })
})

describe('sweeps', () => {
  it("never evicts a repo a live companion's checkout depends on", async () => {
    const repo = repoCacheDir({ host: 'github.com', owner: 'acme', repo: 'busy' })
    mkdirSync(join(repo, 'worktrees', 'w7'), { recursive: true })
    writeFileSync(join(repo, 'pack'), Buffer.alloc(2000))
    writeFileSync(join(repo, 'worktrees', 'w7', 'gitdir'), join(reviewCheckoutDir('r_review01'), '7', '.git'))
    setProtectedReviews(() => new Set(['r_review01']))
    await sweepRepoCache(1000)
    expect(existsSync(repo)).toBe(true)
    setProtectedReviews(null)
    await sweepRepoCache(1000)
    expect(existsSync(repo)).toBe(false)
  })

  function fakeRepo(name: string, bytes: number, usedAt: Date): string {
    const repo = repoCacheDir({ host: 'github.com', owner: 'acme', repo: name })
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'pack'), Buffer.alloc(bytes))
    writeFileSync(join(repo, 'simpleedit-last-used'), '')
    utimesSync(join(repo, 'simpleedit-last-used'), usedAt, usedAt)
    utimesSync(repo, usedAt, usedAt)
    return repo
  }

  it('evicts least recently used repos, with their worktrees, until the cache fits', async () => {
    const old = fakeRepo('old', 600, new Date('2026-01-01'))
    const fresh = fakeRepo('fresh', 600, new Date('2026-10-01'))
    const checkout = join(reviewCheckoutDir('r_review01'), '7')
    mkdirSync(checkout, { recursive: true })
    mkdirSync(join(old, 'worktrees', 'w7'), { recursive: true })
    writeFileSync(join(old, 'worktrees', 'w7', 'gitdir'), join(checkout, '.git'))
    await sweepRepoCache(1000)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(checkout)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it("drops closed reviews' checkouts and idle ones, keeping an open review's dir", async () => {
    setGitRunnerForTests(fakeGit().runner)
    const closed = reviewCheckoutDir('r_closed1')
    mkdirSync(join(closed, '3'), { recursive: true })
    const idle = join(reviewCheckoutDir('r_review01'), '7')
    mkdirSync(idle, { recursive: true })
    utimesSync(idle, new Date('2026-09-01'), new Date('2026-09-01'))
    const recent = join(reviewCheckoutDir('r_review02'), '8')
    mkdirSync(recent, { recursive: true })
    const open = new Map([
      ['r_review01', '2026-09-01T00:00:00Z'],
      ['r_review02', '2026-10-15T00:00:00Z'],
    ])
    await sweepReviewCheckouts(open, { now: Date.parse('2026-10-16T00:00:00Z') })
    expect(existsSync(closed)).toBe(false)
    expect(existsSync(idle)).toBe(false)
    expect(existsSync(reviewCheckoutDir('r_review01'))).toBe(true)
    expect(existsSync(recent)).toBe(true)
  })

  it('removes one review on submit or discard', async () => {
    setGitRunnerForTests(fakeGit().runner)
    await checkoutReviewHead(review())
    await removeReviewCheckouts('r_review01')
    expect(existsSync(reviewCheckoutDir('r_review01'))).toBe(false)
  })
})
