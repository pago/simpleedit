import { describe, expect, it, vi } from 'vitest'
import type { ScreenPrCard } from '../../../shared/screenprs'
import { fetchGithubReviewThreads, mapGithubReviewThreads, type GithubReviewThread } from '../review-threads'
import { resolveStack } from '../stack-base'

function card(number: number, headRefName: string, baseRefName: string, bucket: ScreenPrCard['bucket']): ScreenPrCard {
  return {
    owner: 'acme', repo: 'repo', number, url: `https://github.com/acme/repo/pull/${number}`,
    title: `PR ${number}`, author: 'dev', updatedAt: '2026-01-01T00:00:00Z', headSha: `sha${number}`,
    additions: 1, deletions: 0, changedFiles: 1, baseRefName, headRefName, ci: 'green', ciFailing: [],
    reviewers: [], approvedByOther: false, body: '', diff: '', impact: 'low', findings: [], bucket,
  }
}

describe('resolveStack', () => {
  it('resolves parents and descendants across buckets', async () => {
    const root = card(1, 'layer-one', 'main', 'attention')
    const child = card(2, 'layer-two', 'layer-one', 'quick')
    await expect(resolveStack(child, [root, child])).resolves.toEqual([
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
    const layers = await resolveStack(child, [child], lookup)
    expect(layers.map((layer) => layer.number)).toEqual([2, 3])
    expect(lookup).toHaveBeenCalled()
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
      diffSide: 'RIGHT', comments: [{ id: 'comment', databaseId: 7, author: 'alice', body: 'note' }], ...over,
    })
    const mapped = mapGithubReviewThreads(layer, diff, [
      thread({ id: 'right' }),
      thread({ id: 'left', diffSide: 'LEFT' }),
      thread({ id: 'lower', path: 'src/lower.ts' }),
      thread({ id: 'outdated', isOutdated: true }),
    ], true)
    expect(mapped[0].anchor.kind).toBe('line')
    for (const imported of mapped.slice(1)) {
      expect(imported.anchor).toEqual({ kind: 'pr', pr: 42 })
      expect(imported.messages[0].body).toContain('outside this layer')
    }
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
})
