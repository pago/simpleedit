import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import SessionScreen from '../SessionScreen.svelte'
import type { RemoteConnection } from '../api-shim'
import type { WindowSession } from '../../shared/ipc-types'
import { initAgentThreadsListeners, _resetAgentThreadsForTests } from '../../renderer/stores/agentThreads.svelte'
import type { AgentThread, ThreadChange } from '../../shared/agent-threads'
import { nav } from '../lib/nav.svelte'

/**
 * The screen's second pane.
 *
 * `ChangesPane.test.ts` proves what the review surface reads; this proves the
 * one thing only the screen can get wrong — that reaching it does not cost you
 * the terminal, whose scrollback IS the conversation and whose attachment is
 * what fills the gap after a disconnect.
 */

const WORKTREE = '/code/simpleedit/feat/pty'

const session: WindowSession = {
  terminalId: 'agent-claude-1',
  label: 'Fix the parser',
  kind: 'agent',
  provider: 'claude',
  worktreePath: WORKTREE,
  status: 'waiting',
  statusSince: 0,
  trail: [{ repoPath: '/code/simpleedit/simpleedit.git', worktrees: [WORKTREE] }],
}

const connection: RemoteConnection = {
  state: () => 'open',
  reconnect: () => {},
  identity: () => ({ windowId: 1, clientKey: 'w1.1' }),
  onStateChange: () => () => {},
  setKey: () => {},
    onIdentity: (fn) => {
    fn({ windowId: 1, clientKey: 'w1.1' })
    return () => {}
  },
}

let writes: string[] = []
let failEnter = false

beforeEach(() => {
  writes = []
  failEnter = false
  vi.stubGlobal('api', {
    on: () => () => {},
    invoke: (channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'pty:write':
          if (failEnter && args[1] === '\r') return Promise.reject(new Error('socket closed'))
          writes.push(String(args[1]))
          return Promise.resolve(undefined)
        case 'pty:backlog':
          return Promise.resolve({ data: 'hello from the pty', start: 0, end: 18 })
        case 'agent:capabilities':
          return Promise.resolve({ shiftEnter: 'escape-newline' })
        case 'stt:status':
          return Promise.resolve({ ready: true, hint: '' })
        case 'worktree:list':
          return Promise.resolve([{ path: WORKTREE, branch: 'feat/pty', isMain: false, isCurrent: true }])
        case 'git:log':
          return Promise.resolve([])
        case 'git:staging-files':
          return Promise.resolve([])
        default:
          return Promise.resolve(undefined)
      }
    },
  })
})

describe('SessionScreen', () => {
  it('starts on the terminal, with the keys and the composer', () => {
    render(SessionScreen, { props: { session, connection } })
    expect(screen.getByTestId('pane-terminal').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('mobile-terminal')).toBeTruthy()
    expect(screen.getByTestId('composer-text')).toBeTruthy()
  })

  it('submits an agent reply in one bracketed-paste write', async () => {
    render(SessionScreen, { props: { session, connection } })
    await fireEvent.input(screen.getByTestId('composer-text'), { target: { value: 'ship it\nthen tag it' } })
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(writes).toEqual(['\x1b[200~ship it\nthen tag it\x1b[201~\r']))
  })

  it('sends a plain terminal its text, then Enter as a write of its own', async () => {
    const shell: WindowSession = { ...session, kind: 'terminal', provider: undefined }
    render(SessionScreen, { props: { session: shell, connection } })
    await fireEvent.input(screen.getByTestId('composer-text'), { target: { value: 'make test' } })
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(writes).toEqual(['make test', '\r']))
  })

  // Resending would type the text a second time.
  it('clears the field when the text arrived but Enter did not', async () => {
    failEnter = true
    const shell: WindowSession = { ...session, kind: 'terminal', provider: undefined }
    render(SessionScreen, { props: { session: shell, connection } })
    const field = screen.getByTestId('composer-text') as HTMLTextAreaElement
    await fireEvent.input(field, { target: { value: 'make test' } })
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(screen.getByTestId('composer-error').textContent).toMatch(/Enter did not get through/))
    expect(writes).toEqual(['make test'])
    expect(field.value).toBe('')
  })

  it('shows the changes pane without tearing the terminal down', async () => {
    render(SessionScreen, { props: { session, connection } })
    const terminal = screen.getByTestId('mobile-terminal')

    await fireEvent.click(screen.getByTestId('pane-changes'))
    await waitFor(() => expect(screen.getByTestId('changes-pane')).toBeTruthy())

    // Still the SAME element, merely hidden: a remount would lose the
    // scrollback and reopen a gap the attachment has already filled.
    expect(screen.getByTestId('mobile-terminal')).toBe(terminal)
    expect(terminal.closest('.hidden')).toBeTruthy()
    expect(screen.getByTestId('pane-changes').getAttribute('aria-selected')).toBe('true')
  })

  // Reading is all the Changes pane can do, so it offers nothing to type at —
  // but "offers nothing" has to mean HIDDEN, never unmounted.
  it('puts the keys and the composer away without destroying what was typed', async () => {
    render(SessionScreen, { props: { session, connection } })
    const composer = screen.getByTestId('composer-text') as HTMLTextAreaElement
    await fireEvent.input(composer, { target: { value: 'rebase once more before you merge' } })

    await fireEvent.click(screen.getByTestId('pane-changes'))
    await waitFor(() => expect(screen.getByTestId('changes-pane')).toBeTruthy())
    expect(composer.closest('.hidden')).toBeTruthy()

    await fireEvent.click(screen.getByTestId('pane-terminal'))
    // The same element, still holding the reply. Unmounting it would have eaten
    // a half-typed reply — and DISCARDED a live recording, which is the one
    // thing the composer's lifetime rules exist to prevent.
    expect(screen.getByTestId('composer-text')).toBe(composer)
    expect(composer.value).toBe('rebase once more before you merge')
    expect(screen.getByTestId('changes-pane').closest('.hidden')).toBeTruthy()
  })

  it('builds the changes pane once and then keeps it', async () => {
    render(SessionScreen, { props: { session, connection } })
    // Never opened, never built: a session read only as a terminal should not
    // pay for four reads it will not look at.
    expect(screen.queryByTestId('changes-pane')).toBeNull()

    await fireEvent.click(screen.getByTestId('pane-changes'))
    const pane = await screen.findByTestId('changes-pane')
    await fireEvent.click(screen.getByTestId('pane-terminal'))
    await fireEvent.click(screen.getByTestId('pane-changes'))

    // The same pane, so the repo/worktree/commit the reader picked survives
    // and the reads that produced it are not re-issued per visit.
    expect(screen.getByTestId('changes-pane')).toBe(pane)
  })

  it("counts the session's unread threads on the Threads tab and builds the pane on first visit", async () => {
    const api = (window as unknown as { api: { on: unknown } }).api
    let changed: (c: ThreadChange) => void = () => {}
    api.on = (channel: string, cb: (c: ThreadChange) => void) => {
      if (channel === 'agent-threads:changed') changed = cb
      return () => {}
    }
    const dispose = initAgentThreadsListeners()
    try {
      render(SessionScreen, { props: { session, connection } })
      expect(screen.queryByTestId('threads-unread')).toBeNull()
      changed({
        threadId: 't_aaaaaaaa',
        rev: 5,
        thread: {
          id: 't_aaaaaaaa',
          sessionId: session.terminalId,
          worktreePath: WORKTREE,
          anchor: { path: 'src/a.ts', startLine: 3, endLine: 3, snippet: 'x', before: '', after: '', context: 'file' },
          status: 'open',
          messages: [{ id: 'm_aaaaaaaa', author: 'agent', body: 'Fixed.', at: '2026-10-08T10:00:00.000Z' }],
          lastReadAt: null,
          createdAt: '2026-10-08T10:00:00.000Z',
          updatedAt: '2026-10-08T10:00:00.000Z',
        },
      })
      expect((await screen.findByTestId('threads-unread')).textContent).toBe('1')

      expect(screen.queryByTestId('threads-pane')).toBeNull()
      await fireEvent.click(screen.getByTestId('pane-threads'))
      expect(await screen.findByText('src/a.ts:3')).toBeInTheDocument()
      expect(screen.getByTestId('mobile-terminal').closest('.hidden')).toBeTruthy()
    } finally {
      dispose()
      _resetAgentThreadsForTests()
    }
  })

  it('opens on the Threads pane when a reply notification was tapped', async () => {
    const { rerender } = render(SessionScreen, { props: { session, connection } })
    expect(screen.getByTestId('pane-terminal').getAttribute('aria-selected')).toBe('true')
    await rerender({ session, connection, openThread: { threadId: 't_aaaaaaaa' } })
    await waitFor(() => expect(screen.getByTestId('pane-threads').getAttribute('aria-selected')).toBe('true'))
    expect(screen.getByTestId('threads-pane')).toBeTruthy()

    // Moving away and tapping the same thread again lands there again.
    await fireEvent.click(screen.getByTestId('pane-terminal'))
    await rerender({ session, connection, openThread: { threadId: 't_aaaaaaaa' } })
    await waitFor(() => expect(screen.getByTestId('pane-threads').getAttribute('aria-selected')).toBe('true'))
  })

  it('offers no Threads tab on a plain terminal', () => {
    const shell: WindowSession = { ...session, kind: 'terminal', provider: undefined }
    render(SessionScreen, { props: { session: shell, connection } })
    expect(screen.queryByTestId('pane-threads')).toBeNull()
  })

  it('lets Back leave with typed text, but holds for a recording in progress', async () => {
    let left = 0
    vi.stubGlobal('MediaRecorder', class {
      state = 'inactive'
      start(): void { this.state = 'recording' }
      stop(): void { this.state = 'inactive' }
      addEventListener(): void {}
    })
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
    })
    const { component } = render(SessionScreen, { props: { session, connection, onleave: () => { left++ } } })
    await fireEvent.input(screen.getByTestId('composer-text'), { target: { value: 'half a reply' } })
    expect(component.holdForRecording()).toBe(false)

    await waitFor(() => expect(screen.getByTestId('mic-start')).not.toBeDisabled())
    await fireEvent.click(screen.getByTestId('mic-start'))
    await waitFor(() => expect(screen.getByTestId('mic-stop')).toBeInTheDocument())
    expect(component.holdForRecording()).toBe(true)
    await fireEvent.click(await screen.findByTestId('recording-discard-confirmed'))
    expect(left).toBe(1)
    expect(screen.queryByTestId('mic-stop')).toBeNull()
    vi.unstubAllGlobals()
  })
})

/**
 * Between the Threads pane and the diff: a notification lands on its thread,
 * and a thread's "Show in diff" lands on its row in Changes.
 */
describe('SessionScreen threads and the diff', () => {
  const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO'].join('\n')

  function thread(id: string, line: number, over: Partial<AgentThread> = {}): AgentThread {
    return {
      id,
      sessionId: session.terminalId,
      worktreePath: WORKTREE,
      anchor: { path: 'src/a.ts', startLine: line, endLine: line, snippet: 'x', before: '', after: '', context: 'file' },
      status: 'open',
      messages: [{ id: 'm_aaaaaaaa', author: 'user', body: 'Why?', at: '2026-10-08T10:00:00.000Z', delivery: 'delivered' }],
      lastReadAt: null,
      createdAt: '2026-10-08T10:00:00.000Z',
      updatedAt: '2026-10-08T10:00:00.000Z',
      ...over,
    }
  }

  let dispose: () => void
  let scrolled: Element[]

  beforeEach(() => {
    nav.reset()
    scrolled = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this)
    })
    const threads = [thread('t_inline1', 2), thread('t_faraway', 40), thread('t_resolved', 2, { status: 'resolved' })]
    vi.stubGlobal('api', {
      on: () => () => {},
      invoke: (channel: string) => {
        switch (channel) {
          case 'agent-threads:load':
            return Promise.resolve({ threads, rev: 1 })
          case 'git:staging-files':
            return Promise.resolve([{ path: 'src/a.ts', status: 'modified' }])
          case 'git:staging-diff':
            return Promise.resolve(DIFF)
          case 'git:log':
          case 'worktree:list':
            return Promise.resolve([])
          default:
            return Promise.resolve(undefined)
        }
      },
    })
    dispose = initAgentThreadsListeners()
  })

  afterEach(() => {
    dispose()
    _resetAgentThreadsForTests()
    vi.restoreAllMocks()
  })

  const card = (id: string): HTMLElement => screen.getAllByTestId('thread-card').find((c) => c.dataset.threadId === id)!

  it('expands and scrolls to the thread a notification names, unfolding Resolved for it', async () => {
    render(SessionScreen, { props: { session, connection, openThread: { threadId: 't_resolved' } } })
    await waitFor(() => expect(scrolled).toContain(card('t_resolved')))
    expect(within(card('t_resolved')).getByTestId('thread-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(within(card('t_inline1')).getByTestId('thread-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it("shows a thread's line in Changes, with the thread open under it", async () => {
    render(SessionScreen, { props: { session, connection } })
    await fireEvent.click(screen.getByTestId('pane-threads'))
    await waitFor(() => expect(card('t_inline1')).toBeTruthy())
    await fireEvent.click(within(card('t_inline1')).getByTestId('thread-toggle'))
    await fireEvent.click(within(card('t_inline1')).getByTestId('thread-jump'))

    await waitFor(() => expect(screen.getByTestId('pane-changes')).toHaveAttribute('aria-selected', 'true'))
    await waitFor(() => expect(document.querySelector('[data-revealed]')).toHaveAttribute('data-line', '2'))
    const inline = screen.getByTestId('inline-threads')
    expect(within(inline).getByTestId('thread-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  it("stays on Threads and says so when the diff doesn't hold the line", async () => {
    render(SessionScreen, { props: { session, connection } })
    await fireEvent.click(screen.getByTestId('pane-threads'))
    await waitFor(() => expect(card('t_faraway')).toBeTruthy())
    await fireEvent.click(within(card('t_faraway')).getByTestId('thread-toggle'))
    await fireEvent.click(within(card('t_faraway')).getByTestId('thread-jump'))

    expect(await within(card('t_faraway')).findByRole('alert')).toHaveTextContent("isn't in the diff")
    expect(screen.getByTestId('pane-threads')).toHaveAttribute('aria-selected', 'true')
  })
})
