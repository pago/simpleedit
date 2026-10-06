import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrContext } from '../../shared/screenprs'
import type { Runner } from '../agent-tasks/runner'

const cache = vi.hoisted(() => ({
  getCachedOverview: vi.fn(),
  putOverview: vi.fn(),
  getCachedFindings: vi.fn(() => ({ triage: [], deep: [] })),
  analysisFingerprint: vi.fn(() => 'fp'),
}))
const gather = vi.hoisted(() => vi.fn())
const reviewDiffFor = vi.hoisted(() => vi.fn(async () => 'fetched diff'))
const answers = vi.hoisted(() => ({ items: [] as string[], seen: [] as { output?: string; user: string }[] }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../screenprs-cache', () => cache)
vi.mock('../screenprs', () => ({ reviewDiffFor }))
vi.mock('../github/gh', () => ({
  currentHandle: async () => 'pago',
  withGhSignal: (_signal: AbortSignal, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('../prompts/overrides', () => ({ resolveInstructions: () => ({ text: 'instructions' }), instructionsHash: (t: string) => t }))
vi.mock('../models/config', () => ({ getModelConfig: () => ({ defaults: {} }) }))
vi.mock('../github/pr-overview-context', async (orig) => ({
  ...(await orig<typeof import('../github/pr-overview-context')>()),
  gatherOverviewContext: gather,
}))
vi.mock('../agent-tasks/registry', async (orig) => {
  const runner: Runner = {
    run<Item>(req: { output?: string; user: string }): AsyncIterable<Item> {
      answers.seen.push({ output: req.output, user: req.user })
      return (async function* () {
        for (const a of answers.items) yield a as unknown as Item
      })()
    },
  }
  return {
    ...(await orig<typeof import('../agent-tasks/registry')>()),
    createTaskExecution: () => ({ runner, concurrency: 1 }),
  }
})

import { startOverview, cancelOverview, overviewSnapshot } from '../pr-overview'

const PR: PrContext = {
  owner: 'acme', repo: 'ui', number: 7, url: 'https://github.com/acme/ui/pull/7', title: 'Add widget', author: 'a',
  updatedAt: 'd', headSha: 'sha1', additions: 1, deletions: 0, changedFiles: 1, baseRefName: 'main',
  headRefName: 'w', ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false, body: '', diff: 'the diff',
}

function client() {
  const sent: [string, unknown][] = []
  return { sent, wc: { id: 1, send: (c: string, d: unknown) => sent.push([c, d]), isDestroyed: () => false } }
}

beforeEach(() => {
  vi.clearAllMocks()
  answers.items = []
  answers.seen = []
  cache.getCachedOverview.mockReturnValue(undefined)
  gather.mockImplementation(async (pr: PrContext) => ({
    pr, handle: 'pago', defaultBranch: 'main', isDraft: true, commits: [], foreignCommits: 0, issues: [], discussion: [],
    changeset: { files: ['.changeset/x.md'] }, keyFiles: [], guides: [], triage: [], deep: [], unavailable: [],
  }))
})

describe('startOverview', () => {
  it('serves a cached overview at once, without gathering or a model call', async () => {
    cache.getCachedOverview.mockReturnValue({ text: 'cached', facts: { draft: false, changeset: 'no' }, at: 'x' })
    const { sent, wc } = client()
    await startOverview(PR, wc)
    expect(sent).toEqual([
      ['screenprs:overview-status', { url: PR.url, status: 'running', error: undefined, headSha: 'sha1' }],
      ['screenprs:overview-result', { url: PR.url, headSha: 'sha1', text: 'cached', facts: { draft: false, changeset: 'no' } }],
      ['screenprs:overview-status', { url: PR.url, status: 'done', error: undefined }],
    ])
    expect(gather).not.toHaveBeenCalled()
    expect(answers.seen).toEqual([])
  })

  it('runs the task in text mode, caches the raw answer with its facts, and sends it', async () => {
    answers.items = ['## What changed\nA']
    const { sent, wc } = client()
    await startOverview(PR, wc)
    expect(answers.seen[0].output).toBe('text')
    expect(answers.seen[0].user).toContain('<diff>\nthe diff\n</diff>')
    const facts = { draft: true, changeset: 'yes' }
    expect(cache.putOverview).toHaveBeenCalledWith(PR.url, 'sha1', expect.objectContaining({ text: '## What changed\nA', facts }), 'fp')
    expect(sent.at(-2)).toEqual(['screenprs:overview-result', { url: PR.url, headSha: 'sha1', text: '## What changed\nA', facts }])
    expect(sent.at(-1)?.[1]).toMatchObject({ status: 'done' })
  })

  it('fetches the review diff when the caller sent none', async () => {
    answers.items = ['x']
    await startOverview({ ...PR, diff: '' }, client().wc)
    expect(reviewDiffFor).toHaveBeenCalled()
    expect(gather.mock.calls[0][0].diff).toBe('fetched diff')
  })

  it('reports an empty answer as an error rather than caching nothing', async () => {
    const { sent, wc } = client()
    await startOverview(PR, wc)
    expect(cache.putOverview).not.toHaveBeenCalled()
    expect(sent.at(-1)).toEqual(['screenprs:overview-status', { url: PR.url, status: 'error', error: 'The model returned no overview.' }])
  })

  // One overview per PR for the whole app: whoever asks second follows the
  // first, and whoever stops it stops it for everyone.
  it('joins an overview already running for the PR, and stops for every client', async () => {
    let release = (): void => {}
    gather.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ pr: PR }))))
    const { sent, wc } = client()
    const first = startOverview(PR, wc)

    await expect(startOverview(PR, client().wc)).resolves.toEqual({ joined: true })
    expect(overviewSnapshot()[PR.url]).toMatchObject({ status: 'running', headSha: 'sha1' })

    cancelOverview(PR.url)
    release()
    await expect(first).resolves.toEqual({ joined: false })

    expect(sent).toEqual([
      ['screenprs:overview-status', { url: PR.url, status: 'running', error: undefined, headSha: 'sha1' }],
      ['screenprs:overview-status', { url: PR.url, status: 'idle' }],
    ])
    expect(overviewSnapshot()[PR.url]).toMatchObject({ status: 'idle' })
    expect(answers.seen).toEqual([])
  })

  it('replaces a running overview when the head moved', async () => {
    const releases: (() => void)[] = []
    const full = gather.getMockImplementation()!
    gather.mockImplementation((pr: PrContext) => new Promise((resolve) => releases.push(() => resolve(full(pr)))))
    answers.items = ['x']
    const { sent, wc } = client()
    const old = startOverview({ ...PR, headSha: 'old' }, wc)
    const fresh = startOverview({ ...PR, headSha: 'new' }, wc)
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    for (const release of releases) release()
    await Promise.all([old, fresh])

    expect(sent.filter(([c]) => c === 'screenprs:overview-status').map(([, d]) => (d as { status: string; headSha?: string }))).toEqual([
      { url: PR.url, status: 'running', error: undefined, headSha: 'old' },
      { url: PR.url, status: 'idle' },
      { url: PR.url, status: 'running', error: undefined, headSha: 'new' },
      { url: PR.url, status: 'done', error: undefined },
    ])
    expect(overviewSnapshot()[PR.url]).toMatchObject({ status: 'done', headSha: 'new', text: 'x' })
  })

  it('keeps each finished overview for a client that missed it', async () => {
    answers.items = ['## What changed\nB']
    await startOverview(PR, client().wc)
    expect(overviewSnapshot()[PR.url]).toMatchObject({ status: 'done', text: '## What changed\nB', headSha: 'sha1' })
  })
})
