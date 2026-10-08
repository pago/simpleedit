import { describe, it, expect, afterEach } from 'vitest'
import { threadOpenFor } from '../thread-open'
import { agentThreadsStore, _resetAgentThreadsForTests } from '../../stores/agentThreads.svelte'
import type { AgentThread, ThreadAnchor } from '../../../shared/agent-threads'

function thread(anchor: Partial<ThreadAnchor> = {}, over: Partial<AgentThread> = {}): AgentThread {
  return {
    id: 't_aaaaaaaa',
    sessionId: 's1',
    worktreePath: '/wt',
    anchor: { path: 'src/a.ts', startLine: 7, endLine: 8, snippet: '', before: '', after: '', context: 'file', ...anchor },
    status: 'open',
    messages: [],
    lastReadAt: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    ...over,
  }
}

afterEach(() => _resetAgentThreadsForTests())

describe('threadOpenFor', () => {
  it('opens a working-copy thread at its line, inline', () => {
    expect(threadOpenFor(thread())).toEqual({ kind: 'file', path: '/wt/src/a.ts', line: 7, tabId: 'file:/wt/src/a.ts', inline: true })
    expect(threadOpenFor(thread({ context: { commit: 'uncommitted' } })).kind).toBe('file')
  })

  it("opens a commit's thread in that commit's diff", () => {
    expect(threadOpenFor(thread({ context: { commit: 'abc1234' } }))).toEqual({
      kind: 'diff',
      commit: 'abc1234',
      tabId: 'diff:/wt:abc1234',
      inline: true,
    })
  })

  it('shows an orphaned thread in the panel, with no line and nothing inline', () => {
    expect(threadOpenFor(thread({ orphaned: true }))).toEqual({ kind: 'panel', path: '/wt/src/a.ts' })
  })

  it("doesn't ask for a resolved thread inline: it has no glyph", () => {
    expect(threadOpenFor(thread({}, { status: 'resolved' }))).toMatchObject({ kind: 'file', inline: false })
  })
})

describe('the open-inline request', () => {
  it('is dropped by clearInline, only for its own workspace', () => {
    agentThreadsStore.openInline('s1', 't_aaaaaaaa')
    agentThreadsStore.clearInline('s2')
    expect(agentThreadsStore.inlineFor('s1')).toBe('t_aaaaaaaa')
    agentThreadsStore.clearInline('s1')
    expect(agentThreadsStore.inlineFor('s1')).toBeNull()
  })
})
