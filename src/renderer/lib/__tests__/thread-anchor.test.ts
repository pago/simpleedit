import { describe, it, expect } from 'vitest'
import { anchorLines, threadAnchorFor } from '../thread-anchor'
import { deliveryInfo, implicitAnswerIds } from '../thread-labels'
import type { AgentContext } from '../agent-message'
import type { AgentThread, ThreadMessage } from '../../../shared/agent-threads'

function model(text: string) {
  const lines = text.split('\n')
  return { getLineCount: () => lines.length, getLineContent: (n: number) => lines[n - 1]! }
}

const TEN = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')
const LINES = { startLine: 5, endLine: 5, snippet: 'l5', before: 'l2\nl3\nl4', after: 'l6\nl7\nl8' }

describe('anchorLines', () => {
  it('takes whole lines with three lines of context either side', () => {
    expect(anchorLines(model(TEN), { startLineNumber: 5, endLineNumber: 6, endColumn: 2 })).toEqual({
      startLine: 5,
      endLine: 6,
      snippet: 'l5\nl6',
      before: 'l2\nl3\nl4',
      after: 'l7\nl8\nl9',
    })
  })

  it('drops a last line the selection only reaches the start of', () => {
    expect(anchorLines(model(TEN), { startLineNumber: 5, endLineNumber: 6, endColumn: 1 })).toMatchObject({ endLine: 5, snippet: 'l5' })
  })

  it('clips context at the file edges', () => {
    expect(anchorLines(model(TEN), { startLineNumber: 1, endLineNumber: 1, endColumn: 1 })).toMatchObject({ before: '', after: 'l2\nl3\nl4' })
    expect(anchorLines(model(TEN), { startLineNumber: 10, endLineNumber: 10, endColumn: 3 })).toMatchObject({ before: 'l7\nl8\nl9', after: '' })
  })
})

describe('threadAnchorFor', () => {
  const editor = (filePath: string): AgentContext => ({ kind: 'editor', filePath, selectedText: 'l5', lineRange: [5, 5], lines: LINES })
  const diff = (over: Partial<Extract<AgentContext, { kind: 'diff' }>>): AgentContext => ({
    kind: 'diff',
    filePath: 'src/a.ts',
    commitHash: null,
    side: 'modified',
    selectedText: 'l5',
    lineRange: [5, 5],
    lines: LINES,
    worktreePath: '/wt',
    ...over,
  })

  it('anchors an editor selection relative to the session worktree, on the working copy', () => {
    expect(threadAnchorFor(editor('/wt/src/a.ts'), '/wt/')).toEqual({
      worktreePath: '/wt',
      anchor: { path: 'src/a.ts', ...LINES, context: 'file' },
    })
  })

  it('leaves a file outside the worktree to the old prompt', () => {
    expect(threadAnchorFor(editor('/elsewhere/a.ts'), '/wt')).toBeNull()
    expect(threadAnchorFor(editor('/wt-other/a.ts'), '/wt')).toBeNull()
  })

  it('anchors the new side of a diff to its commit, or to uncommitted', () => {
    expect(threadAnchorFor(diff({ commitHash: 'abc1234def' }), '/session-wt')).toEqual({
      worktreePath: '/wt',
      anchor: { path: 'src/a.ts', ...LINES, context: { commit: 'abc1234def' } },
    })
    expect(threadAnchorFor(diff({}), '/wt')?.anchor.context).toEqual({ commit: 'uncommitted' })
  })

  it('leaves the old side, branch changes and other contexts to the old prompt', () => {
    expect(threadAnchorFor(diff({ side: 'original' }), '/wt')).toBeNull()
    expect(threadAnchorFor(diff({ commitHash: 'branch' }), '/wt')).toBeNull()
    expect(threadAnchorFor(diff({ worktreePath: undefined }), '/wt')).toBeNull()
    expect(threadAnchorFor({ kind: 'block', blockId: 'b', blockType: 'Prose', content: 'x', selectedText: '' }, '/wt')).toBeNull()
  })
})

describe('thread labels', () => {
  const user = (over: Partial<ThreadMessage>): ThreadMessage => ({ id: 'm_u', author: 'user', body: 'b', at: '', ...over })

  it('names each held reason', () => {
    expect(deliveryInfo(user({ delivery: 'held', heldReason: 'busy' }))?.label).toBe("waiting for the agent's turn to end")
    expect(deliveryInfo(user({ delivery: 'held', heldReason: 'dialog' }))?.label).toBe('waiting: the agent is asking you something')
    expect(deliveryInfo(user({ delivery: 'held', heldReason: 'draft' }))).toMatchObject({
      label: 'held: unsent text in the terminal',
      action: 'force-send',
    })
    expect(deliveryInfo(user({ delivery: 'held', heldReason: 'not-running' }))?.label).toBe('session not running')
  })

  it('offers retry with the reason for failed and unanswered messages', () => {
    expect(deliveryInfo(user({ delivery: 'failed', failedReason: "the agent didn't receive it" }))).toMatchObject({
      label: "failed: the agent didn't receive it",
      action: 'retry',
    })
    expect(deliveryInfo(user({ delivery: 'unanswered' }))).toMatchObject({ label: 'unanswered', action: 'retry' })
    expect(deliveryInfo({ id: 'm_a', author: 'agent', body: 'x', at: '' })).toBeNull()
  })

  it('marks only the agent message that answered an implicitly answered comment', () => {
    const t = {
      messages: [
        user({ id: 'm_1', delivery: 'answered-implicitly' }),
        { id: 'm_2', author: 'agent', body: 'final text', at: '' },
        { id: 'm_3', author: 'agent', body: 'explicit', at: '' },
        user({ id: 'm_4', delivery: 'answered' }),
        { id: 'm_5', author: 'agent', body: 'explicit', at: '' },
      ],
    } as AgentThread
    expect([...implicitAnswerIds(t)]).toEqual(['m_2'])
  })
})
