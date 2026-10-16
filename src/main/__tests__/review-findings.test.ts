import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import { materialiseFindings } from '../review-findings'
import { applyReviewOp, createReview, getReviewThread, setReviewProposal, threadsForReview } from '../review-room-store'

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

function run(findings: Parameters<typeof materialiseFindings>[0]['findings'], draftThreadIds?: ReadonlySet<string>) {
  return materialiseFindings({ reviewId: 'r_aaaaaa', pr: 12, headSha: 'head1', source: 'deep', diff: DIFF, findings, draftThreadIds })
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
})
