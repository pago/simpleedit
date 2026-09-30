import { describe, it, expect, vi, beforeEach } from 'vitest'

const runGhMock = vi.hoisted(() => vi.fn<(args: string[]) => Promise<string>>())
vi.mock('../gh', async (orig) => ({ ...(await orig<typeof import('../gh')>()), runGh: runGhMock }))

import {
  diffFiles,
  selectKeyFiles,
  isKeyFileCandidate,
  claudeMdCandidates,
  parseIssueRefs,
  linkedIssues,
  parseDiscussion,
  changesetInfo,
  overviewFacts,
  assembleInput,
  renderOverviewInput,
  gatherOverviewContext,
  type OverviewContext,
  type DiffFileChurn,
} from '../pr-overview-context'
import type { BaseResolver } from '../stack-base'
import type { PrContext } from '../../../shared/screenprs'

const file = (path: string, churn: number, status: DiffFileChurn['status'] = 'modified'): DiffFileChurn => ({
  path, additions: churn, deletions: 0, status,
})

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '+added',
  '+added again',
  '-removed',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/.changeset/brave-owls.md b/.changeset/brave-owls.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/.changeset/brave-owls.md',
  '@@ -0,0 +1 @@',
  '+---',
].join('\n')

describe('diffFiles', () => {
  it('reads each file with its status and hunk-body churn', () => {
    expect(diffFiles(DIFF)).toEqual([
      { path: 'src/a.ts', additions: 2, deletions: 1, status: 'modified' },
      { path: 'src/new.ts', additions: 1, deletions: 0, status: 'added' },
      { path: 'src/gone.ts', additions: 0, deletions: 1, status: 'deleted' },
      { path: '.changeset/brave-owls.md', additions: 1, deletions: 0, status: 'added' },
    ])
  })

  it('does not count `+++`/`---` headers as churn', () => {
    expect(diffFiles(DIFF)[0].additions).toBe(2)
  })
})

describe('key-file selection', () => {
  it('skips lockfiles, generated output, snapshots, tests, binaries, changesets and changelogs', () => {
    for (const p of [
      'pnpm-lock.yaml', 'packages/x/package-lock.json', 'Cargo.lock', 'dist/index.js', 'src/__generated__/schema.ts',
      'src/api.generated.ts', 'src/__snapshots__/a.snap', 'src/a.test.ts', 'src/__tests__/a.ts', 'e2e/flow.spec.ts',
      'src/Button.stories.tsx', 'docs/shot.png', '.changeset/x.md', 'CHANGELOG.md', 'types/index.d.ts',
    ]) {
      expect(isKeyFileCandidate(p), p).toBe(false)
    }
    for (const p of ['src/main/runner.ts', 'CLAUDE.md', 'package.json', 'src/testing-utils.ts']) {
      expect(isKeyFileCandidate(p), p).toBe(true)
    }
  })

  it('takes the four most-changed candidates, never a deleted file', () => {
    const picked = selectKeyFiles([
      file('src/a.ts', 5), file('src/b.ts', 50), file('src/c.ts', 20), file('src/d.ts', 1), file('src/e.ts', 30),
      file('src/removed.ts', 500, 'deleted'), file('src/big.test.ts', 400), file('pnpm-lock.yaml', 9000),
    ])
    expect(picked.map((f) => f.path)).toEqual(['src/b.ts', 'src/e.ts', 'src/c.ts', 'src/a.ts'])
  })

  it('lists CLAUDE.md candidates nearest first, ending at the root', () => {
    expect(claudeMdCandidates('packages/ui/src/Table.tsx')).toEqual([
      'packages/ui/src/CLAUDE.md', 'packages/ui/CLAUDE.md', 'packages/CLAUDE.md', 'CLAUDE.md',
    ])
    expect(claudeMdCandidates('README.md')).toEqual(['CLAUDE.md'])
  })
})

describe('linked issues', () => {
  const self = { owner: 'ivx', repo: 'ui-pack', number: 2532 }

  it('reads #N, owner/repo#N and issue or pull URLs, skipping the PR itself', () => {
    const body = [
      'Closes #12. Stacked on #2531; see ivx/design#7 and',
      'https://github.com/ivx/ui-pack/issues/40 and https://github.com/other/lib/pull/3.',
      'Also this PR: #2532.',
    ].join('\n')
    expect(parseIssueRefs(body, self)).toEqual([
      { owner: 'ivx', repo: 'ui-pack', number: 12 },
      { owner: 'ivx', repo: 'ui-pack', number: 2531 },
      { owner: 'ivx', repo: 'design', number: 7 },
      { owner: 'ivx', repo: 'ui-pack', number: 40 },
      { owner: 'other', repo: 'lib', number: 3 },
    ])
  })

  it('ignores references inside code, HTML entities and URL fragments', () => {
    const body = 'Use `#12` literally.\n```\nfix #13\n```\nAn entity &#39; and https://x.dev/page#14 stay out.'
    expect(parseIssueRefs(body, self)).toEqual([])
  })

  it('puts closing references first, dedupes, and keeps at most three', () => {
    const closing = [{ owner: 'ivx', repo: 'ui-pack', number: 9 }]
    expect(linkedIssues(closing, 'Fixes #9, #10, #11, #12', self).map((r) => r.number)).toEqual([9, 10, 11])
  })
})

describe('parseDiscussion', () => {
  it('keeps line comments with their place, flags your own, drops empty bodies and changeset-bot', () => {
    const items = parseDiscussion({
      handle: 'Pago',
      lineComments: [
        { user: { login: 'dana' }, body: 'Why a Map here?', path: 'src/a.ts', line: null, original_line: 12, created_at: '2026-09-02' },
        { user: { login: 'pago' }, body: '  ', path: 'src/a.ts', line: 3, created_at: '2026-09-03' },
      ],
      comments: [
        { user: { login: 'changeset-bot[bot]' }, body: 'No Changeset found', created_at: '2026-09-01' },
        { user: { login: 'pago' }, body: 'Deferred to #2533.', created_at: '2026-09-04' },
      ],
      reviews: [
        { author: { login: 'lee' }, body: '', state: 'APPROVED', submittedAt: '2026-09-05' },
        { author: { login: 'lee' }, body: 'Needs a test.', state: 'CHANGES_REQUESTED', submittedAt: '2026-09-01T12:00:00Z' },
      ],
    })
    expect(items).toEqual([
      { kind: 'review', author: 'lee', own: false, body: 'Needs a test.', state: 'CHANGES_REQUESTED', at: '2026-09-01T12:00:00Z' },
      { kind: 'line', author: 'dana', own: false, body: 'Why a Map here?', path: 'src/a.ts', line: 12, at: '2026-09-02' },
      { kind: 'comment', author: 'pago', own: true, body: 'Deferred to #2533.', at: '2026-09-04' },
    ])
  })
})

describe('parseDiscussion — noise', () => {
  it('keeps only the latest comment per bot, and clips long bodies', () => {
    const items = parseDiscussion({
      handle: 'pago',
      lineComments: [],
      comments: [
        { user: { login: 'snapshot-bot[bot]' }, body: 'snapshot 1', created_at: '2026-09-01' },
        { user: { login: 'dana' }, body: 'x'.repeat(5000), created_at: '2026-09-02' },
        { user: { login: 'preview', type: 'Bot' }, body: 'preview a', created_at: '2026-09-03' },
        { user: { login: 'snapshot-bot[bot]' }, body: 'snapshot 2', created_at: '2026-09-04' },
        { user: { login: 'preview', type: 'Bot' }, body: 'preview b', created_at: '2026-09-05' },
      ],
      reviews: [],
    })
    expect(items.map((i) => i.body.slice(0, 12))).toEqual(['xxxxxxxxxxxx', 'snapshot 2', 'preview b'])
    expect(items[0].body.length).toBeLessThan(1600)
    expect(items[0].body).toMatch(/…\[comment truncated\]$/)
  })
})

describe('changeset', () => {
  const bot = [{ user: { login: 'changeset-bot[bot]' }, body: '### ⚠️ No Changeset found\n\nLatest commit: abc' }]

  it('finds changeset files in the review diff and the bot verdict', () => {
    const info = changesetInfo(diffFiles(DIFF), bot, undefined)
    expect(info).toEqual({ files: ['.changeset/brave-owls.md'], bot: 'No Changeset found' })
    expect(overviewFacts({ isDraft: false, changeset: info })).toEqual({ draft: false, changeset: 'yes' })
  })

  it('says "maybe in the lower layer" for a stacked PR without one, never "missing"', () => {
    const info = changesetInfo([file('src/a.ts', 3)], bot, '#2531')
    expect(overviewFacts({ isDraft: true, changeset: info })).toEqual({ draft: true, changeset: 'base', changesetBase: '#2531' })
  })

  it('reports none for a PR on the default branch without one', () => {
    expect(overviewFacts({ isDraft: false, changeset: changesetInfo([file('src/a.ts', 3)], [], undefined) }).changeset).toBe('no')
  })

  it('ignores the changeset README and a deleted changeset', () => {
    const files = [file('.changeset/README.md', 2), file('.changeset/old.md', 3, 'deleted')]
    expect(changesetInfo(files, [], undefined).files).toEqual([])
  })
})

describe('assembleInput', () => {
  it('fills sections in order, each within its own cap, and notes what was cut', () => {
    const { text, notSeen } = assembleInput(
      [
        { tag: 'a', body: 'x'.repeat(500), cap: 1000 },
        { tag: 'b', body: 'y'.repeat(5000), cap: 1000 },
        { tag: 'c', body: 'z'.repeat(600), cap: 1000 },
        { tag: 'd', body: 'w'.repeat(900), cap: 1000 },
      ],
      2200
    )
    expect(text).toContain(`<a>\n${'x'.repeat(500)}\n</a>`)
    expect(text).toMatch(/<b>\ny{1000}\n<\/b>/)
    expect(text).toContain(`<c>\n${'z'.repeat(600)}\n</c>`)
    // 100 left for d: under the useful minimum, so it is omitted, not shredded.
    expect(text).not.toContain('<d>')
    expect(notSeen).toEqual(['b: truncated to 1 KB of 5 KB', 'd: omitted (1 KB, over the input budget)'])
  })

  it('cuts at a line boundary', () => {
    const body = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const { text } = assembleInput([{ tag: 'a', body, cap: 450 }], 10_000)
    const inner = text.slice(4, -5)
    expect(inner.split('\n').every((l) => /^line \d+$/.test(l))).toBe(true)
  })

  it('skips empty sections without a note', () => {
    expect(assembleInput([{ tag: 'a', body: '', cap: 10 }])).toEqual({ text: '', notSeen: [] })
  })
})

const PR: PrContext = {
  owner: 'ivx', repo: 'ui-pack', number: 2532, url: 'https://github.com/ivx/ui-pack/pull/2532',
  title: 'Virtualize the Table', author: 'dana', updatedAt: '2026-09-01', headSha: 'head123',
  additions: 3, deletions: 1, changedFiles: 2, baseRefName: 'compact-density', headRefName: 'table-virt',
  ci: 'failing', ciFailing: ['lint'], reviewers: [{ login: 'lee', state: 'approved' }], approvedByOther: true,
  body: 'Closes #12', diff: DIFF,
  base: { kind: 'polluted', basePr: 2531, foreign: 2, behindBy: 5, isolated: true, own: [{ sha: 'own1', subject: 'Virtualize rows' }] },
}

function ctxWith(over: Partial<OverviewContext> = {}): OverviewContext {
  return {
    pr: PR, handle: 'pago', defaultBranch: 'main', isDraft: false, commits: ['Virtualize rows'], foreignCommits: 2,
    issues: [], discussion: [], changeset: { files: [], stackedOn: '#2531' }, keyFiles: [], guides: [],
    triage: [], deep: [], unavailable: [], ...over,
  }
}

describe('renderOverviewInput', () => {
  it('frames the stale base, CI, the changeset and your own comments for the model', () => {
    const input = renderOverviewInput(
      ctxWith({
        discussion: [{ kind: 'comment', author: 'pago', own: true, body: 'Deferred to #2533.' }],
        triage: [{ label: 'issue', file: 'src/a.ts', line: '3', title: 'Off by one' }],
      })
    )
    expect(input).toContain("GitHub's \"Files changed\" includes 2 commit(s) from #2531")
    expect(input).toContain('(2 lower-layer commit(s) left out)')
    expect(input).toContain('Failing: lint')
    expect(input).toContain('the changeset may be in #2531')
    expect(input).toContain('[pago (you) comment]\nDeferred to #2533.')
    expect(input).toContain('- triage [issue] src/a.ts:3 — Off by one')
    expect(input).not.toContain('<not-seen>')
  })

  it('lists what was cut or unavailable in a not-seen block', () => {
    const input = renderOverviewInput(ctxWith({ pr: { ...PR, diff: 'd\n'.repeat(60_000) }, unavailable: ['line comments'] }))
    expect(input).toMatch(/<not-seen>\n- line comments: could not be fetched\n- diff: truncated to 80 KB of 120 KB\n<\/not-seen>$/)
  })

  it('keeps the existing findings when a huge PR starves the key files and guides', () => {
    const big = 'k\n'.repeat(20_000)
    const input = renderOverviewInput(
      ctxWith({
        pr: { ...PR, diff: 'd\n'.repeat(60_000) },
        discussion: [{ kind: 'comment', author: 'lee', own: false, body: 'c\n'.repeat(8_000) }],
        issues: [{ ref: '#12', title: 'Slow', body: 'i\n'.repeat(8_000) }],
        keyFiles: [{ path: 'src/a.ts', head: big, base: big }, { path: 'src/b.ts', head: big, base: big }],
        guides: [{ path: 'CLAUDE.md', text: 'g\n'.repeat(6_000) }],
        triage: [{ label: 'issue', file: 'src/a.ts', line: '3', title: 'Off by one' }],
      })
    )
    expect(input).toContain('<existing-findings>\n- triage [issue] src/a.ts:3 — Off by one\n</existing-findings>')
    const notSeen = input.slice(input.indexOf('<not-seen>'))
    expect(notSeen).toMatch(/- key-files: truncated/)
    expect(notSeen).toMatch(/- guides: (truncated|omitted)/)
    expect(notSeen).not.toContain('existing-findings')
  })

  it('shows key files at both refs, and marks a new file', () => {
    const input = renderOverviewInput(
      ctxWith({ keyFiles: [{ path: 'src/a.ts', head: 'HEAD TEXT', base: 'MAIN TEXT' }, { path: 'src/new.ts', head: 'NEW' }, { path: 'src/huge.ts', skipped: 'over 40 KB' }] })
    )
    expect(input).toContain('=== src/a.ts at the PR head\nHEAD TEXT')
    expect(input).toContain('=== src/a.ts on main\nMAIN TEXT')
    expect(input).toContain('=== src/new.ts does not exist on main (new file)')
    expect(input).toContain('=== src/huge.ts: not included (over 40 KB)')
  })
})

describe('gatherOverviewContext (gh layer)', () => {
  const resolver: BaseResolver = { defaultBranch: async () => 'main', compare: async () => ({ behindBy: 0, commits: [] }) }

  beforeEach(() => {
    runGhMock.mockReset()
    runGhMock.mockImplementation(async (args) => {
      const joined = args.join(' ')
      if (joined.includes('--json isDraft')) {
        return JSON.stringify({ isDraft: true, closingIssuesReferences: [{ number: 12 }], reviews: [] })
      }
      if (joined.includes('--json commits')) {
        return JSON.stringify({ commits: [{ oid: 'lower1', messageHeadline: 'Lower' }, { oid: 'own1', messageHeadline: 'Virtualize rows' }] })
      }
      if (joined.includes('pulls/2532/comments')) return ''
      if (joined.includes('issues/2532/comments')) return JSON.stringify({ user: { login: 'pago' }, body: 'note to self' })
      if (args[0] === 'issue') return JSON.stringify({ title: 'Table is slow', body: 'It lags.' })
      if (joined.includes('/contents/')) {
        const path = /contents\/(.+)\?ref=(.+)$/.exec(args.at(-1) ?? '')
        if (!path) throw new Error('bad path')
        if (path[1] === 'CLAUDE.md' && path[2] === 'main') return 'root guide'
        if (path[1].endsWith('CLAUDE.md')) throw new Error('404')
        return `${path[1]}@${path[2]}`
      }
      throw new Error(`unexpected gh ${joined}`)
    })
  })

  it('pins every file read to a ref: the head SHA, and the default branch by name', async () => {
    const ctx = await gatherOverviewContext(PR, { handle: 'pago', resolver })
    const reads = runGhMock.mock.calls.map(([a]) => a.at(-1) ?? '').filter((p) => p.includes('/contents/'))
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((p) => /\?ref=(head123|main)$/.test(p))).toBe(true)
    expect(ctx.keyFiles).toEqual([
      { path: 'src/a.ts', head: 'src/a.ts@head123', base: 'src/a.ts@main' },
      { path: 'src/new.ts', head: 'src/new.ts@head123' },
    ])
    expect(ctx.guides).toEqual([{ path: 'CLAUDE.md', text: 'root guide' }])
  })

  it('keeps only the own commits of a polluted PR, and gathers issues, discussion and facts', async () => {
    const ctx = await gatherOverviewContext(PR, { handle: 'pago', resolver })
    expect(ctx.commits).toEqual(['Virtualize rows'])
    expect(ctx.foreignCommits).toBe(1)
    expect(ctx.issues).toEqual([{ ref: '#12', title: 'Table is slow', body: 'It lags.' }])
    expect(ctx.discussion).toEqual([{ kind: 'comment', author: 'pago', own: true, body: 'note to self', at: undefined }])
    expect(overviewFacts(ctx)).toEqual({ draft: true, changeset: 'yes' })
    expect(ctx.unavailable).toEqual([])
  })

  it('notes a source that failed instead of failing the overview', async () => {
    const base = runGhMock.getMockImplementation()
    runGhMock.mockImplementation(async (args) => {
      if (args.join(' ').includes('pulls/2532/comments')) throw new Error('gh api exited 1')
      return base ? base(args) : ''
    })
    const ctx = await gatherOverviewContext(PR, { handle: 'pago', resolver })
    expect(ctx.unavailable).toEqual(['line comments'])
  })
})
