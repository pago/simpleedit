import { cleanup, render, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '../../../lib/__tests__/ignore-monaco-cancellation'
import DiffReview from '../DiffReview.svelte'
import { agentThreadsStore, initAgentThreadsListeners, _resetAgentThreadsForTests } from '../../../stores/agentThreads.svelte'
import type { AgentThread, ThreadChange } from '../../../../shared/agent-threads'

let changed: (c: ThreadChange) => void
let dispose: () => void

const commitThread: AgentThread = {
  id: 't_aaaaaaaa',
  sessionId: 's1',
  worktreePath: '/wt',
  anchor: { path: 'src/b.txt', startLine: 2, endLine: 2, snippet: 'b', before: 'a', after: 'c', context: { commit: 'abc1234' } },
  status: 'open',
  messages: [{ id: 'm_1', author: 'user', body: 'Why?', at: '2026-10-08T10:00:00.000Z', delivery: 'delivered' }],
  lastReadAt: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:00.000Z',
}

beforeEach(() => {
  vi.stubGlobal('api', {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'agent-threads:load') return { threads: [], rev: 0 }
      if (channel === 'git:commit-files') {
        return [
          { path: 'src/a.txt', status: 'modified' },
          { path: 'src/b.txt', status: 'modified' },
        ]
      }
      if (channel === 'git:file-at-commit') return 'a\nb\nc\nd'
      return null
    }),
    on: vi.fn((channel: string, cb: (c: ThreadChange) => void) => {
      if (channel === 'agent-threads:changed') changed = cb
      return () => {}
    }),
  })
  dispose = initAgentThreadsListeners()
})

afterEach(() => {
  cleanup()
  dispose()
  _resetAgentThreadsForTests()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('DiffReview: a commit thread opened from the panel', () => {
  it("selects the thread's file and shows the thread inline", async () => {
    changed({ threadId: commitThread.id, thread: commitThread, rev: 2 })
    agentThreadsStore.openInline('s1', commitThread.id)
    const host = document.createElement('div')
    host.style.cssText = 'width: 800px; height: 400px; display: flex'
    document.body.append(host)
    render(DiffReview, {
      target: host,
      props: { commitHash: 'abc1234', commitMessage: 'x', workspaceKey: 's1', worktreePath: '/wt', terminals: [], onclose: () => {} },
    })
    await waitFor(() => expect(document.querySelector('[data-inline-thread="t_aaaaaaaa"]')).not.toBeNull())
    expect(agentThreadsStore.inlineFor('s1')).toBeNull()
  })
})
