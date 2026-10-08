import { render, screen, waitFor, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ThreadsPane from '../ThreadsPane.svelte'
import { initAgentThreadsListeners, _resetAgentThreadsForTests } from '../../renderer/stores/agentThreads.svelte'
import type { AgentThread, ThreadChange, ThreadMessage } from '../../shared/agent-threads'

/**
 * The phone's threads pane. What matters beyond showing a thread: every
 * action goes to main as an op or a delivery request, never as a PTY write —
 * main alone decides when the agent is written to.
 */

let invoke: ReturnType<typeof vi.fn>
let dispose: () => void
let rev = 1
let changed: (c: ThreadChange) => void

function thread(id: string, messages: ThreadMessage[], over: Partial<AgentThread> = {}): AgentThread {
  return {
    id,
    sessionId: 's1',
    worktreePath: '/wt',
    anchor: { path: 'src/a.ts', startLine: 12, endLine: 12, snippet: 'x', before: '', after: '', context: 'file' },
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

function put(t: AgentThread): void {
  changed({ threadId: t.id, thread: t, rev: ++rev })
}

function renderPane(active = true) {
  return render(ThreadsPane, { sessionId: 's1', active })
}

async function expand(): Promise<void> {
  await fireEvent.click(screen.getByTestId('thread-toggle'))
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
  expect(invoke).not.toHaveBeenCalledWith('pty:write', expect.anything(), expect.anything())
  dispose()
  _resetAgentThreadsForTests()
  vi.unstubAllGlobals()
})

describe('ThreadsPane', () => {
  it("lists this session's threads by path:line, with an unread dot", () => {
    put(thread('t_aaaaaaaa', [user('m_1'), agent('m_2', 'Because of the lock.')]))
    put(thread('t_bbbbbbbb', [user('m_3')], { sessionId: 's2' }))
    renderPane()
    expect(screen.getAllByTestId('thread-card')).toHaveLength(1)
    expect(screen.getByText('src/a.ts:12')).toBeInTheDocument()
    expect(screen.getByText('Agent: Because of the lock.')).toBeInTheDocument()
    expect(screen.getByTestId('thread-unread')).toBeInTheDocument()
  })

  it('says how to start a thread when there are none', () => {
    renderPane()
    expect(screen.getByText(/No threads yet/)).toBeInTheDocument()
  })

  it('renders agent answers as markdown and marks the thread read when expanded', async () => {
    put(thread('t_aaaaaaaa', [user('m_1', { delivery: 'answered-implicitly' }), agent('m_2', 'It **awaits** the lock.')]))
    renderPane()
    await expand()
    expect(screen.getByText('awaits').tagName).toBe('STRONG')
    expect(screen.getByText("from the agent's final message")).toBeInTheDocument()
    expect(screen.getByText('answered')).toBeInTheDocument()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'mark-read', threadId: 't_aaaaaaaa', at: '2026-10-08T10:01:00.000Z' }),
    )
  })

  it('reads nothing while the pane is hidden, even with a thread left expanded', async () => {
    put(thread('t_aaaaaaaa', [user('m_1')]))
    const { rerender } = renderPane()
    await expand()
    await rerender({ sessionId: 's1', active: false })
    put(thread('t_aaaaaaaa', [user('m_1'), agent('m_2', 'Done.')]))
    await new Promise((r) => setTimeout(r, 20))
    expect(invoke).not.toHaveBeenCalledWith('agent-threads:op', expect.objectContaining({ kind: 'mark-read' }))

    await rerender({ sessionId: 's1', active: true })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agent-threads:op', expect.objectContaining({ kind: 'mark-read' })))
  })

  it('appends from the composer as an op and keeps the text when main refuses it', async () => {
    put(thread('t_aaaaaaaa', [user('m_1')]))
    renderPane()
    await expand()
    const box = screen.getByRole('textbox', { name: 'Reply to thread' })
    await fireEvent.input(box, { target: { value: 'And the retry?' } })
    // A phone's return key types a newline; only the button sends.
    await fireEvent.keyDown(box, { key: 'Enter' })
    expect(invoke).not.toHaveBeenCalledWith('agent-threads:op', expect.objectContaining({ kind: 'append' }))

    invoke.mockRejectedValueOnce(new Error('Malformed thread op'))
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Malformed thread op')
    expect(box).toHaveValue('And the retry?')

    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(box).toHaveValue(''))
    expect(invoke).toHaveBeenLastCalledWith('agent-threads:op', {
      kind: 'append',
      threadId: 't_aaaaaaaa',
      message: { id: expect.stringMatching(/^m_/), body: 'And the retry?' },
    })
  })

  it('retries a failed message through main', async () => {
    put(thread('t_aaaaaaaa', [user('m_1', { delivery: 'failed', failedReason: "the agent didn't receive it" })]))
    renderPane()
    await expand()
    expect(screen.getByText("failed: the agent didn't receive it")).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(invoke).toHaveBeenCalledWith('agent-threads:retry', 's1', 'm_1')
  })

  it('force-sends a draft-held message only after a confirm', async () => {
    put(thread('t_aaaaaaaa', [user('m_1', { delivery: 'held', heldReason: 'draft' })]))
    renderPane()
    await expand()
    expect(screen.getByText('held: unsent text in the terminal')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'My prompt is empty, send' }))
    expect(invoke).not.toHaveBeenCalledWith('agent-threads:force-send', 's1')
    expect(screen.getByText('Anything typed in the terminal is submitted with it.')).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await fireEvent.click(screen.getByRole('button', { name: 'My prompt is empty, send' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(invoke).toHaveBeenCalledWith('agent-threads:force-send', 's1')
  })

  it('copies a draft-held message', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    put(thread('t_aaaaaaaa', [user('m_1', { delivery: 'held', heldReason: 'draft', body: 'Hold this one' })]))
    renderPane()
    await expand()
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('Hold this one')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('resolves, then lists the thread under Resolved where it can be reopened', async () => {
    put(thread('t_aaaaaaaa', [user('m_1')]))
    renderPane()
    await expand()
    await fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'set-status', threadId: 't_aaaaaaaa', status: 'resolved' })

    put(thread('t_aaaaaaaa', [user('m_1')], { status: 'resolved' }))
    await fireEvent.click(await screen.findByRole('button', { name: /Resolved \(1\)/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(invoke).toHaveBeenCalledWith('agent-threads:op', { kind: 'set-status', threadId: 't_aaaaaaaa', status: 'open' })
  })
})
