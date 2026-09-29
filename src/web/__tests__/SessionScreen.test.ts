import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import SessionScreen from '../SessionScreen.svelte'
import type { RemoteConnection } from '../api-shim'
import type { WindowSession } from '../../shared/ipc-types'

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
  identity: () => ({ windowId: 1, clientKey: 'w1.1' }),
  onStateChange: () => () => {},
  onIdentity: (fn) => {
    fn({ windowId: 1, clientKey: 'w1.1' })
    return () => {}
  },
}

beforeEach(() => {
  vi.stubGlobal('api', {
    on: () => () => {},
    invoke: (channel: string) => {
      switch (channel) {
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
