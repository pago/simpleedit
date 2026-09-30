import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../gh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gh')>()),
  runGh: vi.fn(),
  getPrDiff: vi.fn(async () => GITHUB_DIFF),
}))

import { runGh, getPrDiff } from '../gh'
import {
  analyzeBase,
  baseKey,
  createBaseResolver,
  diffStats,
  getReviewDiff,
  parseCompare,
  parseDefaultBranch,
  parsePrCommits,
  parsePrNumber,
  repoOf,
  withReviewDiff,
  type BaseCommit,
  type PrCommit,
} from '../stack-base'

const GITHUB_DIFF = 'diff --git a/lower.ts b/lower.ts\n'
const ISOLATED_DIFF = 'diff --git a/own.ts b/own.ts\n'

/**
 * Shaped like ui-pack#2532: the lower layer `compact-density` was rebased, so
 * its one commit has a new SHA on the base while the upper PR still carries the
 * old copy — same subject, same author date, different SHA.
 */
const LOWER: BaseCommit = { subject: 'Add opt-in compact density', authoredAt: '2026-06-22T07:03:59Z' }
const OLD_LOWER: PrCommit = { sha: 'old-lower', ...LOWER }
const OWN_1: PrCommit = { sha: 'own-1', subject: 'Improve Timeline render performance', authoredAt: '2026-06-17T08:43:59Z' }
const OWN_2: PrCommit = { sha: 'own-2', subject: 'Add opt-in row virtualization', authoredAt: '2026-06-16T08:12:06Z' }

describe('analyzeBase', () => {
  it('reads a stack whose base is current as clean', () => {
    expect(analyzeBase({ prCommits: [OWN_1, OWN_2], baseCommits: [LOWER], behindBy: 4 })).toEqual({ kind: 'clean' })
  })

  it('finds the rebased lower layer by subject, not SHA', () => {
    expect(analyzeBase({ prCommits: [OLD_LOWER, OWN_1, OWN_2], baseCommits: [LOWER], behindBy: 199 })).toEqual({
      kind: 'polluted',
      foreign: 1,
      behindBy: 199,
      own: [
        { sha: 'own-1', subject: OWN_1.subject },
        { sha: 'own-2', subject: OWN_2.subject },
      ],
      isolated: true,
    })
  })

  it('does not take a subject both layers use for the lower copy when the author dates differ', () => {
    // ui-pack#2764: both layers end in their own "chore: update visual snapshots".
    const snapshots = { subject: 'chore: update visual snapshots' }
    const result = analyzeBase({
      prCommits: [OWN_1, { sha: 'mine', ...snapshots, authoredAt: '2026-07-02T10:00:00Z' }],
      baseCommits: [LOWER, { ...snapshots, authoredAt: '2026-07-01T09:00:00Z' }],
      behindBy: 204,
    })
    expect(result).toEqual({ kind: 'clean' })
  })

  it('falls back to the subject alone when a side has no author date', () => {
    const result = analyzeBase({
      prCommits: [{ sha: 'old', subject: LOWER.subject }, OWN_1],
      baseCommits: [{ subject: LOWER.subject }],
      behindBy: 0,
    })
    expect(result).toMatchObject({ kind: 'polluted', foreign: 1, isolated: true })
  })

  it('matches each base commit at most once', () => {
    const fixup = { subject: 'fixup', authoredAt: undefined }
    const result = analyzeBase({
      prCommits: [{ sha: 'a', ...fixup }, { sha: 'b', ...fixup }],
      baseCommits: [fixup],
      behindBy: 0,
    })
    expect(result).toMatchObject({ kind: 'polluted', foreign: 1, own: [{ sha: 'b', subject: 'fixup' }], isolated: true })
  })

  it('reads a squash-merged lower layer as clean — its subjects no longer exist to match', () => {
    // The base absorbed the lower PR as one squash commit; the upper still
    // carries the lower's original commits. Nothing identifies them, so no
    // claim is made rather than a wrong one.
    const result = analyzeBase({
      prCommits: [{ sha: 'l1', subject: 'Lower part one' }, { sha: 'l2', subject: 'Lower part two' }, OWN_1],
      baseCommits: [{ subject: 'Lower layer (#12)' }],
      behindBy: 0,
    })
    expect(result).toEqual({ kind: 'clean' })
  })

  it('flags own commits interleaved with the lower layer as not isolatable', () => {
    const result = analyzeBase({ prCommits: [OWN_1, OLD_LOWER, OWN_2], baseCommits: [LOWER], behindBy: 2 })
    expect(result).toMatchObject({ kind: 'polluted', foreign: 1, isolated: false })
  })

  it('does not isolate a PR with no commits of its own', () => {
    const result = analyzeBase({ prCommits: [OLD_LOWER], baseCommits: [LOWER], behindBy: 0 })
    expect(result).toMatchObject({ kind: 'polluted', own: [], isolated: false })
  })
})

describe('gh JSON parsing', () => {
  it('reads the default branch', () => {
    expect(parseDefaultBranch(JSON.stringify({ defaultBranchRef: { name: 'main' } }))).toBe('main')
    expect(() => parseDefaultBranch(JSON.stringify({ defaultBranchRef: null }))).toThrow()
  })

  it('reads PR commits oldest first with subject and author date', () => {
    const json = JSON.stringify({
      commits: [
        { oid: 'a1', messageHeadline: 'First', authoredDate: '2026-06-01T00:00:00Z', messageBody: 'ignored' },
        { oid: 'b2', messageHeadline: 'Second', authoredDate: '2026-06-02T00:00:00Z' },
      ],
    })
    expect(parsePrCommits(json)).toEqual([
      { sha: 'a1', subject: 'First', authoredAt: '2026-06-01T00:00:00Z' },
      { sha: 'b2', subject: 'Second', authoredAt: '2026-06-02T00:00:00Z' },
    ])
  })

  it('reads the compare subjects from the first message line and behind_by', () => {
    const json = JSON.stringify({
      behind_by: 199,
      ahead_by: 1,
      commits: [{ sha: 'c2e1', commit: { message: 'Add density\n\nLong body', author: { date: '2026-06-22T07:03:59Z' } } }],
    })
    expect(parseCompare(json)).toEqual({
      behindBy: 199,
      commits: [{ subject: 'Add density', authoredAt: '2026-06-22T07:03:59Z' }],
    })
  })

  it('reads the first PR number of a list, if any', () => {
    expect(parsePrNumber(JSON.stringify([{ number: 2531 }]))).toBe(2531)
    expect(parsePrNumber('[]')).toBeUndefined()
  })

  it('takes the repo, host included, from the PR url', () => {
    expect(repoOf('https://ghe.acme.io/ivx/ui-pack/pull/2532')).toEqual({ host: 'ghe.acme.io', owner: 'ivx', name: 'ui-pack' })
    expect(() => repoOf('--repo=evil')).toThrow()
  })
})

// ── the gh layer, over a routed fake `gh` ────────────────────────────────────

const URL_ = 'https://github.com/ivx/ui-pack/pull/2532'
const META = { url: URL_, baseRefName: 'compact-density', baseRefOid: 'base-oid', headSha: 'own-2' }

interface Routes {
  defaultBranch?: string
  prCommits?: PrCommit[]
  compare?: { behindBy: number; commits: BaseCommit[] } | Error
  prList?: { number: number }[]
  isolated?: string | Error
}

function route(r: Routes): void {
  vi.mocked(runGh).mockImplementation(async (args: string[]) => {
    const joined = args.join(' ')
    if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: r.defaultBranch ?? 'main' } })
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({
        commits: (r.prCommits ?? []).map((c) => ({ oid: c.sha, messageHeadline: c.subject, authoredDate: c.authoredAt })),
      })
    }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(r.prList ?? [])
    if (joined.includes('application/vnd.github.diff')) {
      if (r.isolated instanceof Error) throw r.isolated
      return r.isolated ?? ISOLATED_DIFF
    }
    if (joined.includes('/compare/')) {
      if (r.compare instanceof Error) throw r.compare
      const c = r.compare ?? { behindBy: 0, commits: [] }
      return JSON.stringify({
        behind_by: c.behindBy,
        commits: c.commits.map((b) => ({ commit: { message: b.subject, author: { date: b.authoredAt } } })),
      })
    }
    throw new Error(`unrouted gh ${joined}`)
  })
}

function ghCalls(match: (args: string[]) => boolean): string[][] {
  return vi.mocked(runGh).mock.calls.map(([args]) => args).filter(match)
}

beforeEach(() => {
  vi.mocked(runGh).mockReset()
  vi.mocked(getPrDiff).mockClear()
})

describe('getReviewDiff', () => {
  it('keeps GitHub diff for a PR on the default branch, without looking at commits', async () => {
    route({})
    const out = await getReviewDiff({ ...META, baseRefName: 'main' }, createBaseResolver())
    expect(out).toEqual({ diff: GITHUB_DIFF, base: { kind: 'default' } })
    expect(ghCalls((a) => a[0] === 'pr' || a[0] === 'api')).toEqual([])
  })

  it('replaces a polluted diff with one of only the own commits, from the last foreign commit', async () => {
    route({ prCommits: [OLD_LOWER, OWN_1, OWN_2], compare: { behindBy: 199, commits: [LOWER] } })
    const out = await getReviewDiff(META, createBaseResolver(), [
      { url: 'https://github.com/ivx/ui-pack/pull/2531', number: 2531, headRefName: 'compact-density' },
    ])

    expect(out.diff).toBe(ISOLATED_DIFF)
    expect(out.base).toMatchObject({ kind: 'polluted', basePr: 2531, foreign: 1, behindBy: 199, isolated: true })
    const [diffCall] = ghCalls((a) => a.includes('Accept: application/vnd.github.diff'))
    expect(diffCall.at(-1)).toBe('repos/ivx/ui-pack/compare/old-lower...own-2')
    expect(getPrDiff).not.toHaveBeenCalled()
  })

  it('asks GitHub for the base PR when no card in the run is its head', async () => {
    route({ prCommits: [OLD_LOWER, OWN_1], compare: { behindBy: 1, commits: [LOWER] }, prList: [{ number: 2531 }] })
    const out = await getReviewDiff(META, createBaseResolver(), [
      // Same branch name in another repo is not the base.
      { url: 'https://github.com/ivx/other/pull/9', number: 9, headRefName: 'compact-density' },
    ])
    expect(out.base).toMatchObject({ basePr: 2531 })
  })

  it('keeps GitHub diff when the own commits cannot be isolated', async () => {
    route({ prCommits: [OWN_1, OLD_LOWER, OWN_2], compare: { behindBy: 0, commits: [LOWER] } })
    const out = await getReviewDiff(META, createBaseResolver())
    expect(out.diff).toBe(GITHUB_DIFF)
    expect(out.base).toMatchObject({ kind: 'polluted', isolated: false })
  })

  it('reports not isolated when the isolated diff cannot be fetched', async () => {
    route({ prCommits: [OLD_LOWER, OWN_1], compare: { behindBy: 0, commits: [LOWER] }, isolated: new Error('gh api exited 1') })
    const out = await getReviewDiff(META, createBaseResolver())
    expect(out.diff).toBe(GITHUB_DIFF)
    expect(out.base).toMatchObject({ kind: 'polluted', isolated: false })
  })

  it('makes no claim when the base branch is gone', async () => {
    route({ prCommits: [OWN_1], compare: new Error('gh api exited 1: HTTP 404: Not Found') })
    expect(await getReviewDiff(META, createBaseResolver())).toEqual({ diff: GITHUB_DIFF })
  })

  it('looks up a shared default branch and lower layer once per run', async () => {
    route({ prCommits: [OWN_1], compare: { behindBy: 0, commits: [LOWER] } })
    const resolver = createBaseResolver()
    await Promise.all([
      getReviewDiff(META, resolver),
      getReviewDiff({ ...META, url: 'https://github.com/ivx/ui-pack/pull/2533' }, resolver),
    ])
    expect(ghCalls((a) => a[0] === 'repo')).toHaveLength(1)
    expect(ghCalls((a) => a[0] === 'api' && a.some((x) => x.includes('/compare/')))).toHaveLength(1)
  })
})

describe('baseKey', () => {
  it('keys a default-branch PR on the branch name and a stacked PR on the base SHA', async () => {
    route({})
    const resolver = createBaseResolver()
    expect(await baseKey({ ...META, baseRefName: 'main' }, resolver)).toBe('default:main')
    expect(await baseKey(META, resolver)).toBe('stacked:base-oid')
  })
})

describe('diffStats', () => {
  it('counts files and hunk lines, not the ---/+++ headers', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '+++looks like a header but is an added line',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '---removed line that looks like a header',
      '',
    ].join('\n')
    expect(diffStats(diff)).toEqual({ additions: 2, deletions: 2, changedFiles: 2 })
  })

  it('reads an empty diff as nothing changed', () => {
    expect(diffStats('')).toEqual({ additions: 0, deletions: 0, changedFiles: 0 })
  })
})

describe('withReviewDiff', () => {
  const meta = { url: URL_, additions: 900, deletions: 40, changedFiles: 69 }
  const polluted = { kind: 'polluted' as const, foreign: 1, behindBy: 0, own: [{ sha: 'own-1', subject: 's' }], isolated: true }

  it('describes an isolated diff with its own figures and keeps GitHub’s on the analysis', () => {
    const diff = 'diff --git a/own.ts b/own.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\n'
    expect(withReviewDiff(meta, { diff, base: polluted })).toEqual({
      url: URL_, additions: 2, deletions: 1, changedFiles: 1, diff,
      base: { ...polluted, github: { additions: 900, deletions: 40, changedFiles: 69 } },
    })
  })

  it('leaves GitHub’s figures alone when the diff is GitHub’s', () => {
    const notIsolated = { ...polluted, isolated: false }
    expect(withReviewDiff(meta, { diff: ISOLATED_DIFF, base: notIsolated })).toEqual({ ...meta, diff: ISOLATED_DIFF, base: notIsolated })
    expect(withReviewDiff(meta, { diff: ISOLATED_DIFF, base: { kind: 'clean' } })).toMatchObject({ changedFiles: 69 })
  })
})
