import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import SessionScreen from '../SessionScreen.svelte'
import type { RemoteConnection } from '../api-shim'
import type { WindowSession } from '../../shared/ipc-types'
import { initAgentThreadsListeners, _resetAgentThreadsForTests } from '../../renderer/stores/agentThreads.svelte'
import type { ThreadChange } from '../../shared/agent-threads'

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
