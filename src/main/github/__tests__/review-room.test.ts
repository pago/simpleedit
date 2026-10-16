import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runGhMock = vi.hoisted(() => vi.fn<(args: string[], opts?: { input?: string }) => Promise<string>>())
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
vi.mock('../gh', async (orig) => ({ ...(await orig<typeof import('../gh')>()), runGh: runGhMock }))

import type { ScreenPrCard } from '../../../shared/screenprs'
import { openDb, useDbForTests } from '../../db'
import { createReview, threadsForReview } from '../../review-room-store'
import {
  fetchGithubReviewThreads,
  importGithubReviewThreads,
  mapGithubReviewThreads,
  resetGithubReviewThreadsCache,
  type GithubReviewThread,
} from '../review-threads'
import { pickStackParent, resolveStack } from '../stack-base'

function card(number: number, headRefName: string, baseRefName: string, bucket: ScreenPrCard['bucket']): ScreenPrCard {
  return {
    owner: 'acme', repo: 'repo', number, url: `https://github.com/acme/repo/pull/${number}`,
    title: `PR ${number}`, author: 'dev', updatedAt: '2026-01-01T00:00:00Z', headSha: `sha${number}`,
    additions: 1, deletions: 0, changedFiles: 1, baseRefName, headRefName, ci: 'green', ciFailing: [],
    reviewers: [], approvedByOther: false, body: '', diff: '', impact: 'low', findings: [], bucket,
  }
}

describe('resolveStack', () => {
  const noParent = vi.fn(async () => undefined)

  it('resolves parents and descendants across buckets', async () => {
    const root = card(1, 'layer-one', 'main', 'attention')
    const child = card(2, 'layer-two', 'layer-one', 'quick')
    await expect(resolveStack(child, [root, child], 'main', noParent)).resolves.toEqual([
      { url: root.url, number: 1, headSha: 'sha1' },
      { url: child.url, number: 2, headSha: 'sha2' },
    ])
  })

  it('falls back to merged parents absent from the queue', async () => {
    const child = card(3, 'top', 'merged-layer', 'quick')
    const lookup = vi.fn(async () => ({
      url: 'https://github.com/acme/repo/pull/2', number: 2, headSha: 'sha2',
      headRefName: 'merged-layer', baseRefName: 'main',
    }))
    const layers = await resolveStack(child, [child], 'main', lookup)
    expect(layers.map((layer) => layer.number)).toEqual([2, 3])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('stops at the default branch, so a PR from a branch named like it is no parent', async () => {
    const releaseFromMain = card(9, 'main', 'release', 'attention')
    const single = card(4, 'feature', 'main', 'quick')
    const sibling = card(5, 'other', 'main', 'quick')
    const lookup = vi.fn(async () => undefined)
    await expect(resolveStack(single, [releaseFromMain, single, sibling], 'main', lookup)).resolves.toEqual([
      { url: single.url, number: 4, headSha: 'sha4' },
    ])
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('pickStackParent', () => {
  const pr = (number: number, state: string, isCrossRepository: boolean) => ({
    number, url: `https://github.com/acme/repo/pull/${number}`, headRefOid: `sha${number}`,
    headRefName: 'layer', baseRefName: 'main', state, isCrossRepository,
  })

  it("ignores a fork's same-named branch and prefers open over merged over closed", () => {
    expect(pickStackParent(JSON.stringify([pr(7, 'OPEN', true), pr(6, 'CLOSED', false), pr(5, 'MERGED', false)]))?.number).toBe(5)
    expect(pickStackParent(JSON.stringify([pr(5, 'MERGED', false), pr(8, 'OPEN', false)]))?.number).toBe(8)
    expect(pickStackParent(JSON.stringify([pr(7, 'OPEN', true)]))).toBeUndefined()
  })
})

describe('GitHub review thread import', () => {
  const layer = { url: 'https://github.com/acme/repo/pull/42', number: 42, headSha: 'abc' }
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' context',
  ].join('\n')

  it('maps only lines present in the isolated review diff', () => {
    const thread = (over: Partial<GithubReviewThread>): GithubReviewThread => ({
      id: 'node', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 1,
      diffSide: 'RIGHT', comments: [{ id: 'comment', databaseId: '7', author: 'alice', body: 'note' }], ...over,
    })
    const mapped = mapGithubReviewThreads(layer, diff, [
      thread({ id: 'right' }),
      thread({ id: 'left', diffSide: 'LEFT' }),
      thread({ id: 'lower', path: 'src/lower.ts' }),
      thread({ id: 'outdated', isOutdated: true }),
    ], true)
    expect(mapped[0]).toMatchObject({
      anchor: { kind: 'line', pr: 42, headSha: 'abc', path: 'src/a.ts', side: 'RIGHT', startLine: 1, endLine: 1, snippet: 'new' },
      origin: { kind: 'github', threadNodeId: 'right', rootCommentId: '7', author: 'alice', isResolved: false },
      status: 'open',
      messages: [{ author: 'reviewer', body: 'note' }],
    })
    for (const imported of mapped.slice(1)) {
      expect(imported.anchor).toEqual({ kind: 'pr', pr: 42 })
      expect(imported.messages[0].body).toContain('outside this layer')
    }
  })

  it('skips a thread whose root comment has no REST id, since a reply could not be posted to it', () => {
    const mapped = mapGithubReviewThreads(layer, diff, [{
      id: 'no-db-id', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 1, diffSide: 'RIGHT',
      comments: [{ id: 'comment', author: 'alice', body: 'note' }],
    }])
    expect(mapped).toEqual([])
  })

  it('paginates thread and nested comment connections', async () => {
    const run = vi.fn(async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('ReviewThreadComments')) {
        return { data: { node: { comments: { nodes: [{ id: 'c2', databaseId: 2, author: { login: 'bob' }, body: 'second' }], pageInfo: { hasNextPage: false } } } } }
      }
      const second = variables['cursor'] === 'next-threads'
      const node = {
        id: second ? 't2' : 't1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 1,
        diffSide: 'RIGHT',
        comments: {
          nodes: [{ id: second ? 'c3' : 'c1', databaseId: second ? 3 : 1, author: { login: 'alice' }, body: 'first' }],
          pageInfo: second ? { hasNextPage: false } : { hasNextPage: true, endCursor: 'next-comments' },
        },
      }
      return { data: { repository: { pullRequest: { reviewThreads: {
        nodes: [node],
        pageInfo: second ? { hasNextPage: false } : { hasNextPage: true, endCursor: 'next-threads' },
      } } } } }
    })
    const threads = await fetchGithubReviewThreads(layer, run)
    expect(threads.map((thread) => thread.id)).toEqual(['t1', 't2'])
    expect(threads[0].comments.map((comment) => comment.id)).toEqual(['c1', 'c2'])
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('takes the REST id from fullDatabaseId, which outgrows the Int32 databaseId', async () => {
    const run = vi.fn(async () => ({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [{
        id: 't1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 1, diffSide: 'RIGHT',
        comments: { nodes: [
          { id: 'c1', databaseId: null, fullDatabaseId: '3000000000', author: { login: 'alice' }, body: 'big id' },
          { id: 'c2', databaseId: 5, author: { login: 'bob' }, body: 'old id' },
        ], pageInfo: { hasNextPage: false } },
      }],
      pageInfo: { hasNextPage: false },
    } } } } }))
    const [thread] = await fetchGithubReviewThreads(layer, run)
    expect(thread?.comments.map((comment) => comment.databaseId)).toEqual(['3000000000', '5'])
  })
})

describe('importGithubReviewThreads', () => {
  const layer = { url: 'https://github.com/acme/repo/pull/42', number: 42, headSha: 'abc' }
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' context',
  ].join('\n')

  interface Comment { id: string; databaseId: number; body: string }

  /** One page of GraphQL answer with the given threads. */
  function answer(threads: Array<{ id: string; isResolved?: boolean; comments: Comment[] }>): string {
    return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: threads.map((thread) => ({
        id: thread.id, isResolved: thread.isResolved ?? false, isOutdated: false, path: 'src/a.ts', line: 1, diffSide: 'RIGHT',
        comments: {
          nodes: thread.comments.map((comment) => ({ ...comment, author: { login: 'alice' } })),
          pageInfo: { hasNextPage: false },
        },
      })),
      pageInfo: { hasNextPage: false },
    } } } } })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
    runGhMock.mockReset()
    resetGithubReviewThreadsCache()
    useDbForTests(openDb(':memory:'))
    createReview({ id: 'r_review01', repo: 'github.com/acme/repo', layers: [layer], companionAgent: { provider: 'claude', model: 'sonnet' } })
  })

  afterEach(() => {
    useDbForTests(null)
    vi.useRealTimers()
  })

  const imported = () => threadsForReview('r_review01').filter((thread) => thread.origin.kind === 'github')

  it('does not keep a failed fetch, so the next import tries again', async () => {
    runGhMock.mockRejectedValueOnce(new Error('rate limited'))
    await expect(importGithubReviewThreads('r_review01', layer, diff)).rejects.toThrow('rate limited')
    runGhMock.mockResolvedValueOnce(answer([{ id: 't1', comments: [{ id: 'c1', databaseId: 1, body: 'first' }] }]))
    await importGithubReviewThreads('r_review01', layer, diff)
    expect(imported()).toHaveLength(1)
    expect(runGhMock).toHaveBeenCalledTimes(2)
  })

  it('adds each thread once when two imports run at the same time', async () => {
    runGhMock.mockResolvedValue(answer([
      { id: 't1', comments: [{ id: 'c1', databaseId: 1, body: 'first' }, { id: 'c2', databaseId: 2, body: 'reply' }] },
      { id: 't2', comments: [{ id: 'c3', databaseId: 3, body: 'other' }] },
    ]))
    await Promise.all([importGithubReviewThreads('r_review01', layer, diff), importGithubReviewThreads('r_review01', layer, diff)])
    expect(imported().map((thread) => thread.origin.kind === 'github' && thread.origin.threadNodeId).sort()).toEqual(['t1', 't2'])
    expect(imported().find((thread) => thread.origin.kind === 'github' && thread.origin.threadNodeId === 't1')?.messages.map((m) => m.body))
      .toEqual(['first', 'reply'])
  })

  it('picks up new replies and the resolved flag once the cache has expired', async () => {
    runGhMock.mockResolvedValueOnce(answer([{ id: 't1', comments: [{ id: 'c1', databaseId: 1, body: 'first' }] }]))
    await importGithubReviewThreads('r_review01', layer, diff)
    runGhMock.mockResolvedValueOnce(answer([{
      id: 't1', isResolved: true,
      comments: [{ id: 'c1', databaseId: 1, body: 'first' }, { id: 'c2', databaseId: 2, body: 'late reply' }],
    }]))

    await importGithubReviewThreads('r_review01', layer, diff)
    expect(runGhMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-10-16T10:02:00Z'))
    await importGithubReviewThreads('r_review01', layer, diff)
    const [thread] = imported()
    expect(imported()).toHaveLength(1)
    expect(thread?.messages.map((message) => message.body)).toEqual(['first', 'late reply'])
    expect(thread?.origin).toMatchObject({ kind: 'github', isResolved: true })
  })

  it('stores an empty GitHub comment as a placeholder rather than failing the import', async () => {
    runGhMock.mockResolvedValueOnce(answer([{
      id: 't1', comments: [{ id: 'c1', databaseId: 1, body: 'first' }, { id: 'c2', databaseId: 2, body: '   ' }],
    }]))
    await importGithubReviewThreads('r_review01', layer, diff)
    expect(imported()[0]?.messages.map((message) => message.body)).toEqual(['first', '(empty comment)'])
  })
})
