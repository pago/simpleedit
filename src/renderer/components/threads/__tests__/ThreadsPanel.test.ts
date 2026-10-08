import { render, screen, waitFor, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ThreadsPanel from '../ThreadsPanel.svelte'
import { agentThreadsStore, initAgentThreadsListeners, _resetAgentThreadsForTests } from '../../../stores/agentThreads.svelte'
import type { AgentThread, ThreadChange, ThreadMessage } from '../../../../shared/agent-threads'

let invoke: ReturnType<typeof vi.fn>
let dispose: () => void
let rev = 1

function thread(id: string, messages: ThreadMessage[], over: Partial<AgentThread> = {}): AgentThread {
  return {
    id,
    sessionId: 's1',
    worktreePath: '/wt',
    anchor: { path: 'src/a.ts', startLine: 12, endLine: 14, snippet: 'x', before: '', after: '', context: 'file' },
    status: 'open',
    messages,
    lastReadAt: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    ...over,
  }
}

const user = (id: string, over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id,
  author: 'user',
  body: 'Why is this async?',
  at: '2026-10-08T10:00:00.000Z',
  delivery: 'delivered',
  ...over,
})
const agent = (id: string, body: string): ThreadMessage => ({ id, author: 'agent', body, at: '2026-10-08T10:01:00.000Z' })

let changed: (c: ThreadChange) => void
function put(t: AgentThread): void {
  changed({ threadId: t.id, thread: t, rev: ++rev })
}

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'agent-threads:load') return { threads: [], rev: 0 }
    if (channel === 'agent-threads:retry') return true
    return null
  })
  vi.stubGlobal('api', {
    invoke,
    on: vi.fn((channel: string, cb: (c: ThreadChange) => void) => {
      if (channel === 'agent-threads:changed') changed = cb
      return () => {}
    }),
  })
  dispose = initAgentThreadsListeners()
})

afterEach(() => {
  dispose()
  _resetAgentThreadsForTests()
  vi.unstubAllGlobals()
})

function renderPanel(onopen = vi.fn(), visible = true) {
  return { onopen, ...render(ThreadsPanel, { sessionId: 's1', visible, onopen, onclose: vi.fn() }) }
}

describe('ThreadsPanel', () => {
  it('lists the session threads by anchor and opens the anchor on click', async () => {
    put(thread('t_aaaaaaaa', [user('m_1')]))
    put(thread('t_bbbbbbbb', [user('m_2')], { sessionId: 's2' }))
    const { onopen } = renderPanel()
    const anchor = screen.getByRole('button', { name: 'src/a.ts:12-14' })
    expect(screen.getAllByRole('button', { name: /src\/a\.ts/ })).toHaveLength(1)
    await fireEvent.click(anchor)
    expect(onopen).toHaveBeenCalledWith(expect.objectContaining({ id: 't_aaaaaaaa' }))
  })

  it('renders agent answers as markdown, notes an implicit answer, and marks the thread read when expanded', async () => {
    put(thread('t_aaaaaaaa', [user('m_1', { delivery: 'answered-implicitly' }), agent('m_2', 'It **awaits** the lock.')]))
    renderPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Expand thread' }))
    expect(screen.getByText('awaits').tagName).toBe('STRONG')
    expect(screen.getByText("from the agent's final message")).toBeInTheDocument()
    expect(screen.getByText('answered')).toBeInTheDocument()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'mark-read', threadId: 't_aaaaaaaa', at: '2026-10-08T10:01:00.000Z' }),
    )
  })

  it("doesn't mark an expanded thread read while its workspace is hidden", async () => {
    put(thread('t_aaaaaaaa', [user('m_1'), agent('m_2', 'done')]))
    renderPanel(vi.fn(), false)
    await fireEvent.click(screen.getByRole('button', { name: 'Expand thread' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(invoke).not.toHaveBeenCalledWith('agent-threads:op', expect.objectContaining({ kind: 'mark-read' }))
  })

  it('opens a thread created from Discuss with Agent expanded', async () => {
    invoke.mockImplementation(async (channel: string, op: { kind: string; thread: { id: string } }) => {
      if (channel === 'agent-threads:op' && op.kind === 'add-thread') {
        return { threadId: op.thread.id, thread: thread(op.thread.id, [user('m_1', { delivery: 'held', heldReason: 'busy' })]), rev: 99 }
      }
      return null
    })
    renderPanel()
    await agentThreadsStore.create({ sessionId: 's1', worktreePath: '/wt', anchor: thread('t_x', []).anchor, body: 'Why?' })
    expect(await screen.findByText("waiting for the agent's turn to end")).toBeInTheDocument()
  })

  it('force-sends a draft-held message only after a confirm', async () => {
    put(thread('t_aaaaaaaa', [user('m_1', { delivery: 'held', heldReason: 'draft' })]))
    renderPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Expand thread' }))
    expect(screen.getByText('held: unsent text in the terminal')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'My prompt is empty, send' }))
    expect(invoke).not.toHaveBeenCalledWith('agent-threads:force-send', 's1')
    await fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(invoke).toHaveBeenCalledWith('agent-threads:force-send', 's1')
  })

  it('copies a draft-held message so it can be pasted after the draft', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    put(thread('t_aaaaaaaa', [user('m_1', { delivery: 'held', heldReason: 'draft', body: 'Hold this one' })]))
    renderPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Expand thread' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('Hold this one')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('shows why a message failed and retries it', async () => {
    put(thread('t_aaaaaaaa', [user('m_1', { delivery: 'failed', failedReason: "the agent didn't receive it" })]))
    renderPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Expand thread' }))
    expect(screen.getByText("failed: the agent didn't receive it")).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(invoke).toHaveBeenCalledWith('agent-threads:retry', 's1', 'm_1')
  })

  it('appends from the composer and keeps the text when main refuses it', async () => {
    put(thread('t_aaaaaaaa', [user('m_1')]))
    renderPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Expand thread' }))
    const box = screen.getByRole('textbox', { name: 'Reply to thread' })
    await fireEvent.input(box, { target: { value: 'And the retry?' } })
    invoke.mockRejectedValueOnce(new Error('Malformed thread op'))
    await fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Malformed thread op')
    expect(box).toHaveValue('And the retry?')

    await fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(box).toHaveValue(''))
    expect(invoke).toHaveBeenLastCalledWith('agent-threads:op', {
      kind: 'append',
      threadId: 't_aaaaaaaa',
      message: { id: expect.stringMatching(/^m_/), body: 'And the retry?' },
    })
  })

  it('resolves, then lists the thread under Resolved where it can be reopened', async () => {
    put(thread('t_aaaaaaaa', [user('m_1')]))
    renderPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Expand thread' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'set-status', threadId: 't_aaaaaaaa', status: 'resolved' })

    put(thread('t_aaaaaaaa', [user('m_1')], { status: 'resolved' }))
    await fireEvent.click(await screen.findByRole('button', { name: /Resolved \(1\)/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'set-status', threadId: 't_aaaaaaaa', status: 'open' })
  })

  it('removes a thread after a confirm', async () => {
    put(thread('t_aaaaaaaa', [user('m_1')]))
    renderPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Expand thread' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Remove thread' }))
    expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'remove-thread', threadId: 't_aaaaaaaa' })
  })
})
