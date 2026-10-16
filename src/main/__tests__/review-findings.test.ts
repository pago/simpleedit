import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
vi.mock('../review-room-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../review-room-store')>()
  return { ...actual, appendReviewMessage: vi.fn(actual.appendReviewMessage) }
})

import { openDb, useDbForTests } from '../db'
import { materialiseFindings, triageSeverity } from '../review-findings'
import {
  appendReviewMessage,
  applyReviewOp,
  createReview,
  getReviewThread,
  setReviewLayerHead,
  setReviewProposal,
  threadsForReview,
} from '../review-room-store'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 context before
+const added = true
 context after
 final context
`

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
  createReview({
    id: 'r_aaaaaa',
    repo: 'github.com/acme/app',
    layers: [{ url: 'https://github.com/acme/app/pull/12', number: 12, headSha: 'head1' }],
    companionAgent: { provider: 'claude', model: 'sonnet' },
  })
})

// DIFF's hunk five lines lower: what a push that adds lines above it looks like.
const SHIFTED = DIFF.replace('@@ -10,3 +10,4 @@', '@@ -15,3 +15,4 @@')

type Findings = Parameters<typeof materialiseFindings>[0]['findings']

function run(findings: Findings, draftThreadIds?: ReadonlySet<string>) {
  return materialiseFindings({ reviewId: 'r_aaaaaa', pr: 12, headSha: 'head1', source: 'deep', diff: DIFF, findings, draftThreadIds })
}

function origins() {
  return new Map(threadsForReview('r_aaaaaa').map((thread) => [thread.origin.kind === 'finding' ? thread.origin.key : '', thread]))
}

describe('finding materialisation', () => {
  it('marks context and outside-diff findings pre-existing', () => {
    run([
      { key: 'changed', file: 'src/a.ts', line: '11', title: 'changed line' },
      { key: 'context', file: 'src/a.ts', line: '10', title: 'context line' },
      { key: 'outside', file: 'src/a.ts', line: '100', title: 'outside' },
    ])
    const byKey = new Map(threadsForReview('r_aaaaaa').map((thread) => [thread.origin.kind === 'finding' ? thread.origin.key : '', thread]))
    expect(byKey.get('changed')?.origin).toMatchObject({ preExisting: false })
    expect(byKey.get('context')?.origin).toMatchObject({ preExisting: true })
    expect(byKey.get('outside')?.origin).toMatchObject({ preExisting: true })
  })

  it('matches reworded findings by a unique file snippet and keeps a reasoned thread done', () => {
    const first = run([{ key: 'old-key', file: 'src/a.ts', line: '11', title: 'old wording', detail: 'details' }])
    const id = first.threadIds[0]!
    applyReviewOp('r_aaaaaa', { kind: 'set-status', threadId: id, status: 'done', closeReason: 'not-a-problem' })
    run([])
    expect(getReviewThread(id)).toMatchObject({ status: 'done', closeReason: 'not-a-problem', outdated: true })
    const second = run([{ key: 'new-key', file: 'src/a.ts', line: '11', title: 'completely reworded', detail: 'new details' }])
    expect(second.threadIds).toEqual([id])
    expect(getReviewThread(id)).toMatchObject({ status: 'done', closeReason: 'not-a-problem', outdated: false })
    expect(getReviewThread(id)?.messages.map((message) => message.body)).toEqual([
      'completely reworded\n\nnew details',
      'Reported again: completely reworded\n\nnew details',
    ])
  })

  it('deletes untouched disappeared findings but retains conversations, drafts and proposals as outdated', () => {
    const ids = run([
      { key: 'plain', file: 'src/a.ts', line: '11', title: 'plain' },
      { key: 'conversation', file: 'src/a.ts', line: '10', title: 'conversation' },
      { key: 'draft', file: 'src/a.ts', line: '12', title: 'draft' },
      { key: 'proposal', file: 'src/a.ts', line: '13', title: 'proposal' },
    ]).threadIds
    applyReviewOp('r_aaaaaa', { kind: 'append', threadId: ids[1]!, message: { id: 'rm_aaaaaa', body: 'is this real?' } })
    setReviewProposal(ids[3]!, 'say this instead')
    run([], new Set([ids[2]!]))
    expect(getReviewThread(ids[0]!)).toBeNull()
    for (const id of ids.slice(1)) expect(getReviewThread(id)).toMatchObject({ outdated: true })
  })

  it('treats findings that cite no line as the PR\'s own, and files outside the diff as pre-existing', () => {
    run([
      { key: 'pr-level', file: '', title: 'missing tests' },
      { key: 'no-line', file: 'src/a.ts', title: 'naming in this file' },
      { key: 'bad-line', file: 'src/a.ts', line: 'somewhere', title: 'unparseable line' },
      { key: 'other-file', file: 'src/untouched.ts', line: '3', title: 'old bug elsewhere' },
      { key: 'other-file-no-line', file: 'src/untouched.ts', title: 'old file' },
    ])
    const byKey = origins()
    expect(byKey.get('pr-level')?.origin).toMatchObject({ preExisting: false })
    expect(byKey.get('no-line')?.origin).toMatchObject({ preExisting: false })
    expect(byKey.get('bad-line')?.origin).toMatchObject({ preExisting: false })
    expect(byKey.get('other-file')?.origin).toMatchObject({ preExisting: true })
    expect(byKey.get('other-file-no-line')?.origin).toMatchObject({ preExisting: true })
  })

  it('matches a reworded PR-level finding with a new key by its title', () => {
    const [id] = run([{ key: 'k1', file: '', title: 'Missing tests for the importer retry path' }]).threadIds
    applyReviewOp('r_aaaaaa', { kind: 'append', threadId: id!, message: { id: 'rm_aaaaaa', body: 'which retry path?' } })
    const second = run([{ key: 'k2', file: '', title: 'Missing tests for importer retry path' }])
    expect(second.threadIds).toEqual([id])
    expect(getReviewThread(id!)?.messages.map((message) => message.body)).toEqual([
      'Missing tests for importer retry path',
      'which retry path?',
    ])
  })

  it('does not guess between two equally similar PR-level threads', () => {
    const ids = run([
      { key: 'a1', file: '', title: 'alpha beta gamma delta' },
      { key: 'a2', file: '', title: 'alpha beta gamma epsilon' },
    ]).threadIds
    const next = run([{ key: 'new', file: '', title: 'alpha beta gamma' }])
    expect(ids).not.toContain(next.threadIds[0])
  })

  it('follows a finding across a push that shifts its lines, keeping the conversation', () => {
    const [id] = run([{ key: 'k1', file: 'src/a.ts', line: '11', title: 'flag is never read' }]).threadIds
    applyReviewOp('r_aaaaaa', { kind: 'append', threadId: id!, message: { id: 'rm_bbbbbb', body: 'is this real?' } })
    setReviewLayerHead('r_aaaaaa', 12, 'head2')
    const second = materialiseFindings({
      reviewId: 'r_aaaaaa', pr: 12, headSha: 'head2', source: 'deep', diff: SHIFTED,
      findings: [{ key: 'k-new', file: 'src/a.ts', line: '16', title: 'the flag is not read anywhere' }],
    })
    expect(second.threadIds).toEqual([id])
    const thread = getReviewThread(id!)
    expect(thread?.anchor).toMatchObject({ kind: 'line', headSha: 'head2', startLine: 16, endLine: 16, snippet: 'const added = true' })
    expect(thread?.outdated).toBe(false)
    expect(thread?.messages.map((message) => message.body)).toEqual(['the flag is not read anywhere', 'is this real?'])
    expect(threadsForReview('r_aaaaaa')).toHaveLength(1)
  })

  it('refuses findings for a head the review does not have, writing nothing', () => {
    run([{ key: 'k1', file: 'src/a.ts', line: '11', title: 'kept' }])
    const before = threadsForReview('r_aaaaaa')
    expect(() =>
      materialiseFindings({
        reviewId: 'r_aaaaaa', pr: 12, headSha: 'head-moved', source: 'deep', diff: DIFF,
        findings: [{ key: 'k2', file: 'src/a.ts', line: '11', title: 'other' }],
      })
    ).toThrow(/no longer has/)
    expect(threadsForReview('r_aaaaaa')).toEqual(before)
  })

  it('rolls the whole reconcile back when one write fails', () => {
    const [done] = run([{ key: 'done', file: 'src/a.ts', line: '11', title: 'reasoned' }]).threadIds
    applyReviewOp('r_aaaaaa', { kind: 'set-status', threadId: done!, status: 'done', closeReason: 'intentional' })
    const before = threadsForReview('r_aaaaaa')
    // The re-report note on the reasoned thread fails after a new thread was already added.
    vi.mocked(appendReviewMessage).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() =>
      run([
        { key: 'fresh', file: '', title: 'a new PR-level finding' },
        { key: 'done', file: 'src/a.ts', line: '11', title: 'reasoned' },
      ])
    ).toThrow('disk full')
    expect(threadsForReview('r_aaaaaa')).toEqual(before)
  })

  it('cuts an oversized finding to fit rather than failing the reconcile', () => {
    const [id] = run([{ key: 'big', file: 'src/a.ts', line: '11', title: 'huge', detail: 'x'.repeat(70 * 1024) }]).threadIds
    expect(getReviewThread(id!)?.messages[0]?.body).toMatch(/\[SimpleEdit cut this message at its size limit\.\]$/)
  })
})

describe('triageSeverity', () => {
  it('maps triage labels to proposed severities', () => {
    expect(triageSeverity('issue')).toBe('consider')
    expect(triageSeverity('nitpick')).toBe('nit')
    expect(triageSeverity('suggestion')).toBe('nit')
    expect(triageSeverity('question')).toBeUndefined()
  })
})
