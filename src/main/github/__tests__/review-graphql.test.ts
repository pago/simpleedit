import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../gh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gh')>()),
  runGh: vi.fn(),
  getPrDiff: vi.fn(),
}))

import { runGh, getPrDiff, GhTimeoutError } from '../gh'
import { deletePendingReview, postReviewLayer, type PostReviewLayerInput } from '../review-graphql'
import type { PrReviewComment } from '../../../shared/screenprs'
import type { ReviewLayerSubmission } from '../../../shared/review-room'

const GH_DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@
 keep10
-gone11
+new11
+new12
 keep12
`

const PR = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7' }
const HEAD = 'head1'
const you = (over: Partial<PrReviewComment>): PrReviewComment => ({ id: over.id ?? 'c', source: 'you', file: 'a.ts', text: 'n', sha: HEAD, ...over })
const reply = (id: string, text = 'agreed'): PrReviewComment =>
  you({ id, file: 'a.ts', line: '11', text, threadId: 'rt_thread0001', inReplyTo: { threadNodeId: 'PRRT_1', rootCommentId: '9000000001' } })

interface FakeComment {
  id: string
  fullDatabaseId: string
  body: string
  commit: { oid: string }
  threadId?: string
}

interface FakeReview {
  id: string
  body: string
  viewerDidAuthor: boolean
  state: string
  url: string
  comments: FakeComment[]
}

type Vars = Record<string, unknown>
type Input = Record<string, unknown>

/** Just enough of GitHub's GraphQL API to post reviews against, plus knobs for each failure. */
class FakeGithub {
  head = HEAD
  reviews: FakeReview[] = []
  calls: Array<{ op: string; vars: Vars }> = []
  refuseThreadsAtCreate = false
  /** `path:line` GitHub answers `thread: null` for. */
  badLines = new Set<string>()
  /** `path:line` whose comment lands on another commit. */
  driftLines = new Set<string>()
  failReplies = false
  /** Op name → what happens on its next call, after the op ran (`landed-timeout`) or instead of it. */
  next = new Map<string, 'timeout' | 'landed-timeout' | 'error'>()
  private seq = 0

  ops(name?: string): Vars[] {
    return this.calls.filter((c) => !name || c.op === name).map((c) => c.vars)
  }

  pending(): FakeReview | undefined {
    return this.reviews.find((r) => r.state === 'PENDING')
  }

  private comment(body: string, oid = this.head): FakeComment {
    const n = ++this.seq
    return { id: `PRRC_${n}`, fullDatabaseId: String(9_000_000_000 + n), body, commit: { oid } }
  }

  answer(op: string, vars: Vars): unknown {
    const input = (vars.input ?? {}) as Input
    const review = (id: unknown): FakeReview | undefined => this.reviews.find((r) => r.id === id)
    switch (op) {
      case 'PendingReviews':
        return {
          data: {
            repository: {
              pullRequest: {
                id: 'PR_1',
                headRefOid: this.head,
                reviews: {
                  nodes: this.reviews
                    .filter((r) => r.state === 'PENDING')
                    .map((r) => ({ id: r.id, body: r.body, viewerDidAuthor: r.viewerDidAuthor, comments: { totalCount: r.comments.length } })),
                },
              },
            },
          },
        }
      case 'ReviewComments': {
        const r = review(vars.id)
        if (!r) return notFound()
        return { data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: r.comments } } } }
      }
      case 'ReviewState': {
        const r = review(vars.id)
        return r ? { data: { node: { state: r.state, url: r.url } } } : notFound()
      }
      case 'ReplyContext':
        return { data: { node: { path: 'a.ts', line: 11, comments: { nodes: [{ body: 'Why is this mutable?', author: { login: 'alice' } }] } } } }
      case 'AddReview': {
        const threads = (input.threads ?? []) as Input[]
        if (this.pending()) return unprocessable('User can only have one pending review per pull request')
        if (threads.length && this.refuseThreadsAtCreate) return unprocessable('Path could not be resolved')
        const id = `PRR_${++this.seq}`
        this.reviews.push({
          id,
          body: String(input.body ?? ''),
          viewerDidAuthor: true,
          state: 'PENDING',
          url: `${PR.url}#pullrequestreview-${this.seq}`,
          comments: threads.map((t) => this.comment(String(t.body), String(input.commitOID))),
        })
        return { data: { addPullRequestReview: { pullRequestReview: { id } } } }
      }
      case 'AddThread': {
        const r = review(input.pullRequestReviewId)
        if (!r) return notFound()
        const at = `${input.path}:${input.line}`
        if (this.badLines.has(at)) return { data: { addPullRequestReviewThread: { thread: null } } }
        const c = this.comment(String(input.body), this.driftLines.has(at) ? 'head9' : this.head)
        r.comments.push(c)
        return { data: { addPullRequestReviewThread: { thread: { comments: { nodes: [c] } } } } }
      }
      case 'AddReply': {
        const r = review(input.pullRequestReviewId)
        if (!r || this.failReplies) return unprocessable('Could not reply')
        const c = { ...this.comment(String(input.body)), threadId: String(input.pullRequestReviewThreadId) }
        r.comments.push(c)
        return { data: { addPullRequestReviewThreadReply: { comment: c } } }
      }
      case 'UpdateComment': {
        const c = this.reviews.flatMap((r) => r.comments).find((x) => x.id === input.pullRequestReviewCommentId)
        if (!c) return notFound()
        c.body = String(input.body)
        return { data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: c.id } } } }
      }
      case 'DeleteComment':
        for (const r of this.reviews) r.comments = r.comments.filter((c) => c.id !== input.id)
        return { data: { deletePullRequestReviewComment: { pullRequestReview: null } } }
      case 'SubmitReview': {
        const r = review(input.pullRequestReviewId)
        if (!r || r.state !== 'PENDING') return unprocessable('Can not submit a submitted review')
        r.state = String(input.event) === 'APPROVE' ? 'APPROVED' : String(input.event) === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED'
        r.body = String(input.body)
        return { data: { submitPullRequestReview: { pullRequestReview: { id: r.id, url: r.url, state: r.state } } } }
      }
      case 'DeleteReview': {
        const r = review(input.pullRequestReviewId)
        if (!r) return notFound()
        this.reviews = this.reviews.filter((x) => x !== r)
        return { data: { deletePullRequestReview: { pullRequestReview: { id: r.id } } } }
      }
    }
    throw new Error(`unexpected op ${op}`)
  }

  run(input: string): string {
    const { query, variables } = JSON.parse(input) as { query: string; variables: Vars }
    const op = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '?'
    this.calls.push({ op, vars: variables })
    const fault = this.next.get(op)
    this.next.delete(op)
    if (fault === 'timeout') throw new GhTimeoutError('gh api did not finish')
    if (fault === 'error') return JSON.stringify(unprocessable('Something went wrong'))
    const out = JSON.stringify(this.answer(op, variables))
    if (fault === 'landed-timeout') throw new GhTimeoutError('gh api did not finish')
    return out
  }
}

const notFound = (): unknown => ({ data: { node: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] })
const unprocessable = (message: string): unknown => ({ data: null, errors: [{ type: 'UNPROCESSABLE', message }] })

let gh: FakeGithub
let records: ReviewLayerSubmission[]

beforeEach(() => {
  gh = new FakeGithub()
  records = []
  vi.mocked(runGh).mockReset().mockImplementation(async (args, opts) => {
    if (args[0] === 'api' && args[1] === 'graphql') return gh.run(opts?.input ?? '{}')
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ baseRefOid: 'base1', headRefOid: gh.head })
    throw new Error(`unexpected gh ${args.join(' ')}`)
  })
  vi.mocked(getPrDiff).mockReset().mockResolvedValue(GH_DIFF)
})

const layer = (comments: PrReviewComment[], over: Partial<PostReviewLayerInput> = {}): PostReviewLayerInput => ({
  pr: PR,
  draft: { comments, summary: 'Looks good', verdict: 'comment' },
  readHead: HEAD,
  verdict: 'comment',
  isolatedBase: false,
  record: (s) => records.push(s),
  ...over,
})

const lastRecord = (): ReviewLayerSubmission => records[records.length - 1]
const created = (): Input => gh.ops('AddReview')[0].input as Input
const submitted = (): Input => gh.ops('SubmitReview').at(-1)?.input as Input

describe('postReviewLayer: anchors', () => {
  it('folds the one anchor outside GitHub\'s diff and keeps the rest on their lines', async () => {
    const { outcome, state } = await postReviewLayer(layer([you({ id: 'a', line: '11' }), you({ id: 'b', line: '40', text: 'far' })]))
    expect(created().threads).toEqual([{ path: 'a.ts', line: 11, side: 'RIGHT', body: 'n\n\n<!-- se:a -->' }])
    expect(submitted().body).toContain('a.ts:40 — far')
    expect(submitted().event).toBe('COMMENT')
    expect(outcome).toEqual({ prUrl: PR.url, kind: 'posted', reviewUrl: expect.stringContaining('#pullrequestreview-'), folded: 1 })
    expect(state).toMatchObject({ state: 'posted', postedCommentIds: ['a', 'b'], items: [{ draftId: 'a', nodeId: expect.any(String) }] })
  })

  it('pins the review to the head the user read', async () => {
    await postReviewLayer(layer([you({ line: '11' })]))
    expect(created().commitOID).toBe(HEAD)
    expect(created().pullRequestId).toBe('PR_1')
  })

  it('sends a range as start and end on one hunk', async () => {
    await postReviewLayer(layer([you({ line: '11-12' })]))
    expect(created().threads).toEqual([{ path: 'a.ts', line: 12, side: 'RIGHT', startLine: 11, startSide: 'RIGHT', body: 'n\n\n<!-- se:c -->' }])
  })

  it('folds anchors from another head, or none, and says so in the count', async () => {
    const { outcome } = await postReviewLayer(
      layer([you({ id: 'a', line: '11', sha: 'old' }), you({ id: 'b', line: '12', sha: undefined }), you({ id: 'c', line: '11' })])
    )
    expect(created().threads).toHaveLength(1)
    expect(submitted().body).toContain('a.ts:11 (on an earlier commit) — n')
    expect(outcome).toMatchObject({ kind: 'posted', folded: 2 })
  })

  it('folds a deleted-line comment read off an isolated stacked diff', async () => {
    const { outcome } = await postReviewLayer(layer([you({ line: '11', side: 'LEFT' })], { isolatedBase: true }))
    expect(created().threads).toEqual([])
    expect(submitted().body).toContain('a.ts:11 (deleted line) — n')
    expect(outcome).toMatchObject({ folded: 1 })
  })

  it('posts unchecked when GitHub\'s diff cannot be fetched', async () => {
    vi.mocked(getPrDiff).mockRejectedValue(new Error('gh pr diff exited 1'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { outcome } = await postReviewLayer(layer([you({ line: '40' })]))
    expect(created().threads).toEqual([{ path: 'a.ts', line: 40, side: 'RIGHT', body: 'n\n\n<!-- se:c -->' }])
    expect(outcome).toMatchObject({ kind: 'posted', folded: 0 })
  })

  it('does not count a note that never had a line', async () => {
    const { outcome } = await postReviewLayer(layer([you({ file: '', line: undefined, text: 'overall fine' })]))
    expect(submitted().body).toBe('Looks good\n\n- overall fine')
    expect(outcome).toMatchObject({ folded: 0 })
  })

  it('renders severity as a conventional-comment prefix, on a line and in the body', async () => {
    await postReviewLayer(layer([you({ id: 'a', line: '11', severity: 'blocking' }), you({ id: 'b', line: '40', severity: 'nit', text: 'far' })]))
    expect((created().threads as Input[])[0].body).toBe('**blocking:** n\n\n<!-- se:a -->')
    expect(submitted().body).toContain('a.ts:40 — **nit:** far')
  })

  it('refuses an empty Comment review before touching GitHub', async () => {
    const { outcome } = await postReviewLayer(layer([], { draft: { comments: [], summary: '', verdict: 'comment' } }))
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('summary') })
    expect(gh.calls).toEqual([])
  })
})

describe('postReviewLayer: replies', () => {
  it('adds a reply into the pending review, never on its own', async () => {
    await postReviewLayer(layer([reply('r1')]))
    const [add] = gh.ops('AddReply')
    expect(add.input).toEqual({ pullRequestReviewId: gh.reviews[0].id, pullRequestReviewThreadId: 'PRRT_1', body: 'agreed\n\n<!-- se:r1 -->' })
    expect(created().threads).toEqual([])
  })

  it('folds a reply GitHub refuses into the body, quoting what it answered', async () => {
    gh.failReplies = true
    const { outcome } = await postReviewLayer(layer([reply('r1')]))
    expect(submitted().body).toBe(
      'Looks good\n\n- In reply to @alice on a.ts:11 (https://github.com/acme/app/pull/7#discussion_r9000000001) — agreed\n  > Why is this mutable?'
    )
    expect(outcome).toMatchObject({ kind: 'posted', folded: 1 })
  })
})

describe('postReviewLayer: the pending review', () => {
  it('records the attempt before anything is created, then the review id', async () => {
    await postReviewLayer(layer([you({ line: '11' })]))
    expect(records[0]).toMatchObject({ state: 'pending', readHead: HEAD, claimToken: expect.any(String) })
    expect(records[0].reviewNodeId).toBeUndefined()
    expect(records.find((r) => r.reviewNodeId)?.items ?? []).toEqual([])
    // The claim marker went in with the creation.
    expect(created().body).toBe(`<!-- se-review:${records[0].claimToken} -->`)
  })

  it('stops at a pending review SimpleEdit did not create, adding nothing', async () => {
    gh.reviews.push({ id: 'PRR_web', body: 'started on the web', viewerDidAuthor: true, state: 'PENDING', url: '', comments: [] })
    gh.reviews[0].comments.push({ id: 'PRRC_w', fullDatabaseId: '1', body: 'mine', commit: { oid: HEAD } })
    const { outcome } = await postReviewLayer(layer([you({ line: '11' })]))
    expect(outcome).toEqual({ prUrl: PR.url, kind: 'foreign-pending', pendingReviewId: 'PRR_web', commentCount: 1 })
    expect(gh.calls.map((c) => c.op)).toEqual(['PendingReviews'])
  })

  it('posts into a foreign pending review the user adopted, keeping its body', async () => {
    gh.reviews.push({ id: 'PRR_web', body: 'started on the web', viewerDidAuthor: true, state: 'PENDING', url: 'u', comments: [] })
    gh.head = HEAD
    const { outcome } = await postReviewLayer(layer([you({ id: 'a', line: '11' })], { adoptPendingReviewId: 'PRR_web' }))
    expect(outcome).toMatchObject({ kind: 'posted' })
    expect(gh.ops('AddReview')).toEqual([])
    expect(gh.ops('AddThread')[0].input).toMatchObject({ pullRequestReviewId: 'PRR_web', path: 'a.ts', line: 11 })
    expect(submitted().body).toBe('started on the web\n\nLooks good')
  })

  it('leaves a submitted review alone on a failed submit, keeping the state for a retry', async () => {
    gh.next.set('SubmitReview', 'error')
    const { outcome, state } = await postReviewLayer(layer([you({ id: 'a', line: '11' })]))
    expect(outcome).toMatchObject({ kind: 'failed', error: 'Something went wrong' })
    expect(state).toMatchObject({ state: 'failed', reviewNodeId: gh.reviews[0].id, items: [{ draftId: 'a' }], postedCommentIds: [] })
  })
})

describe('postReviewLayer: retries', () => {
  it('adds only what is missing after a partial attempt', async () => {
    gh.next.set('AddReply', 'timeout')
    const first = await postReviewLayer(layer([you({ id: 'a', line: '11' }), reply('r1')]))
    expect(first.outcome).toMatchObject({ kind: 'unknown' })
    expect(first.state).toMatchObject({ state: 'unknown', items: [{ draftId: 'a' }] })

    gh.calls = []
    const second = await postReviewLayer(layer([you({ id: 'a', line: '11' }), reply('r1')], { prior: lastRecord() }))
    expect(second.outcome).toMatchObject({ kind: 'posted' })
    expect(gh.ops('AddReview')).toEqual([])
    expect(gh.ops('AddThread')).toEqual([])
    expect(gh.ops('AddReply')).toHaveLength(1)
    expect(gh.reviews[0].comments.map((c) => c.body)).toEqual(['n\n\n<!-- se:a -->', 'agreed\n\n<!-- se:r1 -->'])
  })

  it('finds its review by marker after a create that timed out but landed', async () => {
    gh.next.set('AddReview', 'landed-timeout')
    const first = await postReviewLayer(layer([you({ id: 'a', line: '11' })]))
    expect(first.outcome).toMatchObject({ kind: 'unknown' })
    expect(first.state.reviewNodeId).toBeUndefined()

    const second = await postReviewLayer(layer([you({ id: 'a', line: '11' })], { prior: lastRecord() }))
    expect(second.outcome).toMatchObject({ kind: 'posted' })
    expect(gh.ops('AddReview')).toHaveLength(1)
    expect(second.state.items).toEqual([{ draftId: 'a', draftRev: expect.any(String), nodeId: gh.reviews[0].comments[0].id, databaseId: gh.reviews[0].comments[0].fullDatabaseId }])
    expect(submitted().body).toBe('Looks good')
  })

  it('updates a comment edited since it was added', async () => {
    gh.next.set('SubmitReview', 'error')
    await postReviewLayer(layer([you({ id: 'a', line: '11', text: 'first' })]))
    const second = await postReviewLayer(layer([you({ id: 'a', line: '11', text: 'second' })], { prior: lastRecord() }))
    expect(second.outcome).toMatchObject({ kind: 'posted' })
    expect(gh.ops('UpdateComment')).toEqual([{ input: { pullRequestReviewCommentId: gh.reviews[0].comments[0].id, body: 'second\n\n<!-- se:a -->' } }])
    expect(gh.reviews[0].comments).toHaveLength(1)
  })

  it('drops a comment whose draft was removed since', async () => {
    gh.next.set('SubmitReview', 'error')
    await postReviewLayer(layer([you({ id: 'a', line: '11' }), you({ id: 'b', line: '12' })]))
    await postReviewLayer(layer([you({ id: 'a', line: '11' })], { prior: lastRecord() }))
    expect(gh.reviews[0].comments.map((c) => c.body)).toEqual(['n\n\n<!-- se:a -->'])
    expect(lastRecord().items?.map((i) => i.draftId)).toEqual(['a'])
  })

  it('starts over when the pending review was deleted on GitHub', async () => {
    gh.next.set('SubmitReview', 'error')
    await postReviewLayer(layer([you({ id: 'a', line: '11' })]))
    const gone = lastRecord().reviewNodeId
    gh.reviews = []
    const second = await postReviewLayer(layer([you({ id: 'a', line: '11' })], { prior: lastRecord() }))
    expect(second.outcome).toMatchObject({ kind: 'posted' })
    expect(gh.ops('AddReview')).toHaveLength(2)
    expect(second.state.reviewNodeId).not.toBe(gone)
  })

  it('never submits twice when a timed-out submit had landed', async () => {
    gh.next.set('SubmitReview', 'landed-timeout')
    const first = await postReviewLayer(layer([you({ id: 'a', line: '11' })]))
    expect(first.outcome).toMatchObject({ kind: 'unknown' })
    const second = await postReviewLayer(layer([you({ id: 'a', line: '11' })], { prior: lastRecord() }))
    expect(second.outcome).toMatchObject({ kind: 'posted', reviewUrl: gh.reviews[0].url })
    expect(second.state).toMatchObject({ state: 'posted', postedCommentIds: ['a'] })
    expect(gh.ops('SubmitReview')).toHaveLength(1)
  })

  it('does nothing for a layer already posted', async () => {
    const prior: ReviewLayerSubmission = { prUrl: PR.url, verdict: 'comment', postedCommentIds: ['a'], state: 'posted', reviewUrl: 'u' }
    const { outcome } = await postReviewLayer(layer([you({ id: 'a', line: '11' })], { prior }))
    expect(outcome).toMatchObject({ kind: 'posted', reviewUrl: 'u' })
    expect(gh.calls).toEqual([])
  })

  it('starts over when the read head changed since the last attempt', async () => {
    gh.next.set('SubmitReview', 'error')
    await postReviewLayer(layer([you({ id: 'a', line: '11' })]))
    const old = gh.reviews[0].id
    gh.head = 'head2'
    const second = await postReviewLayer(layer([you({ id: 'a', line: '11', sha: 'head2' })], { readHead: 'head2', prior: lastRecord() }))
    expect(second.outcome).toMatchObject({ kind: 'posted' })
    expect(gh.ops('DeleteReview')).toEqual([{ input: { pullRequestReviewId: old } }])
    expect((gh.ops('AddReview')[1].input as Input).commitOID).toBe('head2')
  })
})

describe('postReviewLayer: GitHub refuses the threads at creation', () => {
  it('adds them one by one while the head is unchanged, folding the ones it will not place', async () => {
    gh.refuseThreadsAtCreate = true
    gh.badLines.add('a.ts:12')
    gh.driftLines.add('a.ts:13')
    const { outcome, state } = await postReviewLayer(
      layer([you({ id: 'a', line: '11' }), you({ id: 'b', line: '12', text: 'null thread' }), you({ id: 'd', line: '13', text: 'drifted' })])
    )
    expect(gh.ops('AddReview').map((v) => (v.input as Input).threads)).toEqual([expect.any(Array), []])
    expect(gh.ops('AddThread')).toHaveLength(3)
    expect(gh.ops('DeleteComment')).toHaveLength(1)
    expect(gh.reviews[0].comments.map((c) => c.body)).toEqual(['n\n\n<!-- se:a -->'])
    expect(submitted().body).toBe('Looks good\n\n- a.ts:12 — null thread\n- a.ts:13 — drifted')
    expect(outcome).toMatchObject({ kind: 'posted', folded: 2 })
    expect(state.folded).toEqual(['b', 'd'])
  })

  it('folds every line thread once the head has moved', async () => {
    gh.refuseThreadsAtCreate = true
    // The read head is still on the PR, only no longer its head.
    vi.mocked(runGh).mockImplementation(async (args, opts) => {
      if (args[0] === 'api' && args[1] === 'graphql') return gh.run(opts?.input ?? '{}')
      if (args[0] === 'pr') return JSON.stringify({ baseRefOid: 'base1', headRefOid: gh.head })
      if (args.at(-1) === 'repos/acme/app/compare/base1...head1') return GH_DIFF
      throw new Error(`unexpected gh ${args.join(' ')}`)
    })
    gh.head = 'head2'
    const { outcome } = await postReviewLayer(layer([you({ id: 'a', line: '11' }), you({ id: 'b', line: '12' })]))
    expect(gh.ops('AddThread')).toEqual([])
    expect(submitted().body).toBe('Looks good\n\n- a.ts:11 — n\n- a.ts:12 — n')
    expect(outcome).toMatchObject({ kind: 'posted', folded: 2 })
  })

  it('posts nothing when GitHub refuses the commit itself', async () => {
    vi.mocked(runGh).mockImplementation(async (args, opts) => {
      if (args[0] === 'api' && args[1] === 'graphql') {
        const { query } = JSON.parse(opts?.input ?? '{}') as { query: string }
        if (query.includes('AddReview')) return JSON.stringify(unprocessable('Commit could not be found'))
        return gh.run(opts?.input ?? '{}')
      }
      return JSON.stringify({ baseRefOid: 'base1', headRefOid: gh.head })
    })
    const { outcome } = await postReviewLayer(layer([], { draft: { comments: [], summary: '', verdict: 'approve' }, verdict: 'approve' }))
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringMatching(/no longer on the PR.*Nothing was posted/) })
  })
})

describe('postReviewLayer: gh failures', () => {
  it('reports a gh that never got an answer as a failure', async () => {
    vi.mocked(runGh).mockImplementation(async (args) => {
      if (args[1] === 'graphql') return ''
      return JSON.stringify({ baseRefOid: 'base1', headRefOid: HEAD })
    })
    const { outcome } = await postReviewLayer(layer([you({ line: '11' })]))
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('gh auth status') })
  })
})

describe('deletePendingReview', () => {
  it('deletes the review, and counts one already gone as done', async () => {
    gh.reviews.push({ id: 'PRR_x', body: '', viewerDidAuthor: true, state: 'PENDING', url: '', comments: [] })
    await deletePendingReview('PRR_x')
    expect(gh.reviews).toEqual([])
    await expect(deletePendingReview('PRR_x')).resolves.toBeUndefined()
  })
})
