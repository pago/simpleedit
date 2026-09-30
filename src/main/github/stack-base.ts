/**
 * Stale / stacked base detection for Screen PRs.
 *
 * When a lower stack layer is rebased or force-pushed, the upper PR still
 * carries the lower layer's old commits, and `gh pr diff` (computed against the
 * old merge-base) shows the whole stack. This module works out which of a PR's
 * commits are its own and, when it can, fetches a diff of only those — the
 * "review diff" that triage, deep review and both diff views read.
 *
 * `analyzeBase` and the JSON parsers are pure and unit-tested; the rest is a
 * thin layer over `runGh`.
 */
import { runGh, getPrDiff, isPrUrl, type PrMeta } from './gh'
import type { BaseAnalysis, DiffStats } from '../../shared/screenprs'

export interface PrCommit {
  sha: string
  subject: string
  authoredAt?: string
}

export interface BaseCommit {
  subject: string
  authoredAt?: string
}

/** The base branch relative to the default branch. */
export interface BaseCompare {
  behindBy: number
  /** The commits the base has on top of the default branch — the lower layers. */
  commits: BaseCommit[]
}

interface RepoSpec {
  host: string
  owner: string
  name: string
}

/** The repo a PR url lives in, with its host so enterprise instances resolve. */
export function repoOf(url: string): RepoSpec {
  if (!isPrUrl(url)) throw new Error(`Not a pull-request URL: ${url}`)
  const { host, pathname } = new URL(url)
  const [, owner, name] = pathname.split('/')
  return { host, owner, name }
}

const sameRepo = (a: RepoSpec, b: RepoSpec): boolean => a.host === b.host && a.owner === b.owner && a.name === b.name

/** A branch name as a URL path: slashes stay (GitHub reads them), everything else is escaped. */
const refPath = (ref: string): string => ref.split('/').map(encodeURIComponent).join('/')

// ── parsers ─────────────────────────────────────────────────────────────────

/** Parse `gh repo view --json defaultBranchRef`. */
export function parseDefaultBranch(json: string): string {
  const name = (JSON.parse(json) as { defaultBranchRef?: { name?: string } | null }).defaultBranchRef?.name
  if (!name) throw new Error('Repository has no default branch')
  return name
}

interface RawViewCommit {
  oid: string
  messageHeadline?: string
  authoredDate?: string
}

/** Parse `gh pr view --json commits`, oldest first as GitHub lists them. */
export function parsePrCommits(json: string): PrCommit[] {
  const commits = (JSON.parse(json) as { commits?: RawViewCommit[] | null }).commits ?? []
  return commits.map((c) => ({ sha: c.oid, subject: c.messageHeadline ?? '', authoredAt: c.authoredDate }))
}

interface RawCompare {
  behind_by?: number
  commits?: { commit?: { message?: string; author?: { date?: string } | null } | null }[] | null
}

/** Parse `gh api repos/<r>/compare/<default>...<base>`. */
export function parseCompare(json: string): BaseCompare {
  const raw = JSON.parse(json) as RawCompare
  return {
    behindBy: raw.behind_by ?? 0,
    commits: (raw.commits ?? []).map((c) => ({
      subject: (c.commit?.message ?? '').split('\n', 1)[0],
      authoredAt: c.commit?.author?.date ?? undefined,
    })),
  }
}

/** Parse `gh pr list --json number` — the first PR, if any. */
export function parsePrNumber(json: string): number | undefined {
  return (JSON.parse(json || '[]') as { number: number }[])[0]?.number
}

// ── the judgment ────────────────────────────────────────────────────────────

/**
 * Split a stacked PR's commits into its own and the lower layer's.
 *
 * A commit is foreign when a commit on the base has the same subject — never
 * the same SHA, because the rebase that caused the problem rewrote every SHA.
 * The author date must agree too when both sides carry one: a rebase keeps it,
 * and it stops a recurring subject ("chore: update visual snapshots") in both
 * layers from being mistaken for the lower layer's copy. Each base commit
 * accounts for at most one PR commit.
 */
export function analyzeBase(input: {
  prCommits: PrCommit[]
  baseCommits: BaseCommit[]
  behindBy: number
}): Exclude<BaseAnalysis, { kind: 'default' }> {
  const pool = [...input.baseCommits]
  const foreign = input.prCommits.map((c) => {
    const i = pool.findIndex(
      (b) => b.subject === c.subject && (!b.authoredAt || !c.authoredAt || b.authoredAt === c.authoredAt)
    )
    if (i === -1) return false
    pool.splice(i, 1)
    return true
  })
  const foreignCount = foreign.filter(Boolean).length
  if (foreignCount === 0) return { kind: 'clean' }
  const own = input.prCommits.filter((_, i) => !foreign[i]).map(({ sha, subject }) => ({ sha, subject }))
  const lastForeign = foreign.lastIndexOf(true)
  return {
    kind: 'polluted',
    foreign: foreignCount,
    behindBy: input.behindBy,
    own,
    isolated: own.length > 0 && lastForeign === input.prCommits.length - own.length - 1,
  }
}

// ── gh layer ────────────────────────────────────────────────────────────────

/**
 * Per-run memo of the lookups that PRs share: every PR in a repo shares its
 * default branch, and a stack shares its lower layers. Promises are memoised,
 * so concurrent callers share one request.
 */
export interface BaseResolver {
  defaultBranch(url: string): Promise<string>
  compare(url: string, defaultBranch: string, base: string, baseOid: string): Promise<BaseCompare>
}

export function createBaseResolver(): BaseResolver {
  const memo = <T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    let hit = map.get(key)
    if (!hit) {
      hit = load()
      map.set(key, hit)
    }
    return hit
  }
  const defaults = new Map<string, Promise<string>>()
  const compares = new Map<string, Promise<BaseCompare>>()
  return {
    defaultBranch(url) {
      const r = repoOf(url)
      return memo(defaults, `${r.host}/${r.owner}/${r.name}`, async () =>
        parseDefaultBranch(await runGh(['repo', 'view', `${r.host}/${r.owner}/${r.name}`, '--json', 'defaultBranchRef']))
      )
    },
    compare(url, defaultBranch, base, baseOid) {
      const r = repoOf(url)
      return memo(compares, `${r.host}/${r.owner}/${r.name} ${base} ${baseOid}`, async () =>
        parseCompare(
          await runGh([
            'api', '--hostname', r.host,
            `repos/${r.owner}/${r.name}/compare/${refPath(defaultBranch)}...${refPath(base)}`,
          ])
        )
      )
    },
  }
}

/** The fields of a PR that its review diff depends on. */
export type ReviewDiffTarget = Pick<PrMeta, 'url' | 'baseRefName' | 'baseRefOid' | 'headSha'>

/** Another PR in the same run, for finding the base's PR without asking GitHub. */
export type ReviewDiffSibling = Pick<PrMeta, 'url' | 'number' | 'headRefName'>

/**
 * What the cache compares to tell whether the base moved in a way that can
 * change the diff. A PR on the default branch keys on the branch name alone:
 * the default branch advancing never changes a PR's diff, and keying on its
 * SHA would evict every cached triage whenever anything merges. A stacked PR
 * keys on the base's SHA, because a rebased lower layer is exactly what
 * pollutes it. Retargeting either way changes the key.
 */
export async function baseKey(meta: ReviewDiffTarget, resolver: BaseResolver): Promise<string> {
  try {
    const def = await resolver.defaultBranch(meta.url)
    return meta.baseRefName === def ? `default:${def}` : `stacked:${meta.baseRefOid}`
  } catch {
    return `stacked:${meta.baseRefOid}`
  }
}

async function basePrNumber(meta: ReviewDiffTarget, siblings: ReviewDiffSibling[]): Promise<number | undefined> {
  const repo = repoOf(meta.url)
  const sibling = siblings.find((s) => s.headRefName === meta.baseRefName && isPrUrl(s.url) && sameRepo(repoOf(s.url), repo))
  if (sibling) return sibling.number
  try {
    return parsePrNumber(
      await runGh([
        'pr', 'list', '-R', `${repo.host}/${repo.owner}/${repo.name}`,
        '--head', meta.baseRefName, '--state', 'all', '--limit', '1', '--json', 'number',
      ])
    )
  } catch {
    return undefined
  }
}

function isolatedDiff(url: string, from: string, to: string): Promise<string> {
  const r = repoOf(url)
  return runGh([
    'api', '--hostname', r.host, '-H', 'Accept: application/vnd.github.diff',
    `repos/${r.owner}/${r.name}/compare/${from}...${to}`,
  ])
}

/**
 * The diff a reviewer should read: only this PR's own commits when GitHub's
 * diff carries a lower layer and they can be isolated, otherwise GitHub's.
 * `base` is absent when the analysis couldn't run (e.g. the base branch was
 * deleted) — the diff is GitHub's and nothing is claimed about it.
 *
 * When the own commits are not a contiguous suffix, GitHub's diff is kept:
 * stitching per-commit diffs together repeats file sections, which the diff
 * parser would render as duplicates.
 */
export async function getReviewDiff(
  meta: ReviewDiffTarget,
  resolver: BaseResolver,
  siblings: ReviewDiffSibling[] = []
): Promise<{ diff: string; base?: BaseAnalysis }> {
  let def: string
  try {
    def = await resolver.defaultBranch(meta.url)
  } catch {
    return { diff: await getPrDiff(meta) }
  }
  if (meta.baseRefName === def) return { diff: await getPrDiff(meta), base: { kind: 'default' } }

  let fetched: [PrCommit[], BaseCompare]
  try {
    fetched = await Promise.all([
      runGh(['pr', 'view', meta.url, '--json', 'commits']).then(parsePrCommits),
      resolver.compare(meta.url, def, meta.baseRefName, meta.baseRefOid),
    ])
  } catch {
    return { diff: await getPrDiff(meta) }
  }
  const [prCommits, compare] = fetched

  const analysis = analyzeBase({ prCommits, baseCommits: compare.commits, behindBy: compare.behindBy })
  if (analysis.kind !== 'polluted') return { diff: await getPrDiff(meta), base: analysis }

  const base = { ...analysis, basePr: await basePrNumber(meta, siblings) }
  if (base.isolated) {
    const parent = prCommits[prCommits.length - base.own.length - 1].sha
    try {
      return { diff: await isolatedDiff(meta.url, parent, meta.headSha), base }
    } catch {
      return { diff: await getPrDiff(meta), base: { ...base, isolated: false } }
    }
  }
  return { diff: await getPrDiff(meta), base }
}

/** `getReviewDiff` for a PR known only by its url — one extra view call. */
export async function getReviewDiffByUrl(url: string): Promise<string> {
  if (!isPrUrl(url)) throw new Error(`Not a pull-request URL: ${url}`)
  const view = JSON.parse(await runGh(['pr', 'view', url, '--json', 'baseRefName,baseRefOid,headRefOid'])) as {
    baseRefName: string
    baseRefOid?: string
    headRefOid?: string
  }
  const target = { url, baseRefName: view.baseRefName, baseRefOid: view.baseRefOid ?? '', headSha: view.headRefOid ?? '' }
  return (await getReviewDiff(target, createBaseResolver())).diff
}

/** Files, added and removed lines of a unified diff, counting only hunk bodies. */
export function diffStats(diff: string): DiffStats {
  const stats: DiffStats = { additions: 0, deletions: 0, changedFiles: 0 }
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      stats.changedFiles++
      inHunk = false
    } else if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) stats.additions++
    else if (inHunk && line.startsWith('-')) stats.deletions++
  }
  return stats
}

/**
 * `meta` with its review diff, and — when that diff was narrowed to the PR's
 * own commits — size figures that describe it, so the card, the detail and the
 * Discuss brief agree with the banner. GitHub's figures move onto the analysis.
 * Applied to cache hits too, since `meta`'s figures are always refetched.
 */
export function withReviewDiff<M extends DiffStats>(meta: M, review: { diff: string; base?: BaseAnalysis }): M & { diff: string; base?: BaseAnalysis } {
  const { base, diff } = review
  if (base?.kind !== 'polluted' || !base.isolated) return { ...meta, diff, base }
  const github = { additions: meta.additions, deletions: meta.deletions, changedFiles: meta.changedFiles }
  return { ...meta, ...diffStats(diff), diff, base: { ...base, github } }
}
