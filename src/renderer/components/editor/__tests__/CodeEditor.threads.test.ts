import { cleanup, render, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import CodeEditor from '../CodeEditor.svelte'
import { agentThreadsStore, initAgentThreadsListeners, _resetAgentThreadsForTests } from '../../../stores/agentThreads.svelte'
import type { AgentThread, ThreadAnchor, ThreadChange } from '../../../../shared/agent-threads'

let changed: (c: ThreadChange) => void
let dispose: () => void
let rev = 1

function thread(id: string, anchor: Partial<ThreadAnchor> = {}): AgentThread {
  return {
    id,
    sessionId: 's1',
    worktreePath: '/wt',
    anchor: { path: 'src/a.txt', startLine: 2, endLine: 2, snippet: 'b', before: 'a', after: 'c', context: 'file', ...anchor },
    status: 'open',
    messages: [{ id: 'm_1', author: 'user', body: 'Why?', at: '2026-10-08T10:00:00.000Z', delivery: 'delivered' }],
    lastReadAt: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
  }
}

function put(t: AgentThread): void {
  changed({ threadId: t.id, thread: t, rev: ++rev })
}

beforeEach(() => {
  vi.stubGlobal('api', {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'agent-threads:load') return { threads: [], rev: 0 }
      if (channel === 'editor:open') return 'a\nb\nc\nd'
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

function renderEditor(workspaceKey = 's1') {
  const host = document.createElement('div')
  host.style.cssText = 'width: 600px; height: 300px'
  document.body.append(host)
  return render(CodeEditor, { target: host, props: { filePath: '/wt/src/a.txt', workspaceKey, worktreeRoot: '/wt' } })
}

describe('CodeEditor: a thread opened from the panel', () => {
  it('shows the thread inline once its file is loaded, and takes the request', async () => {
    put(thread('t_aaaaaaaa'))
    agentThreadsStore.openInline('s1', 't_aaaaaaaa')
    renderEditor()
    await waitFor(() => expect(document.querySelector('[data-inline-thread="t_aaaaaaaa"]')).not.toBeNull())
    expect(agentThreadsStore.inlineFor('s1')).toBeNull()
  })

  it("leaves another workspace's request alone", async () => {
    put(thread('t_aaaaaaaa'))
    agentThreadsStore.openInline('s2', 't_aaaaaaaa')
    renderEditor()
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector('[data-inline-thread]')).toBeNull()
    expect(agentThreadsStore.inlineFor('s2')).toBe('t_aaaaaaaa')
  })

  it("leaves a commit thread's request for that commit's diff", async () => {
    put(thread('t_aaaaaaaa', { context: { commit: 'abc1234' } }))
    agentThreadsStore.openInline('s1', 't_aaaaaaaa')
    renderEditor()
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector('[data-inline-thread]')).toBeNull()
    expect(agentThreadsStore.inlineFor('s1')).toBe('t_aaaaaaaa')
  })
})
