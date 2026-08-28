import { render, screen, waitFor } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import SessionsScreen from '../SessionsScreen.svelte'
import type { WindowSession } from '../../shared/ipc-types'

/**
 * The list is a read over the socket, and an `invoke` made while there is no
 * socket is refused rather than queued — the price of the outbox belonging to
 * one connection. So the load cannot be a one-shot in `onMount`: a mount that
 * lands during the reconnect backoff, or a read that failed because of it,
 * would leave the screen on its error for the rest of the page's life.
 */
const SESSION: WindowSession = {
  terminalId: 't1',
  label: 'rebase the stack',
  kind: 'agent',
  worktreePath: '/repo/feat/x',
  status: 'waiting',
  statusSince: Date.now(),
  provider: 'claude',
  trail: [],
}

let listResult: () => Promise<WindowSession[]>

beforeEach(() => {
  listResult = async () => [SESSION]
  vi.stubGlobal('api', {
    invoke: vi.fn(async (channel: string) => (channel === 'session:list' ? listResult() : undefined)),
    on: () => () => {},
  })
})

describe('SessionsScreen', () => {
  it('does not read while there is no connection, and reads as soon as there is', async () => {
    // Both halves in one test, and both asserted on CALLS rather than on what is
    // rendered: "Loading…" is on screen for a moment either way, so a
    // render-only assertion passes just as well against a one-shot load in
    // `onMount` — which is the thing this exists to rule out.
    const calls: string[] = []
    listResult = async () => {
      calls.push('list')
      return [SESSION]
    }

    const { rerender } = render(SessionsScreen, { connected: false, onopen: vi.fn() })
    await waitFor(() => expect(screen.getByText('Loading sessions…')).toBeInTheDocument())
    expect(calls).toHaveLength(0)

    await rerender({ connected: true, onopen: vi.fn() })
    await waitFor(() => expect(screen.getByTestId('session-row')).toHaveTextContent('rebase the stack'))
    expect(calls).toEqual(['list'])
  })

  it('retries after a read that failed with the connection down', async () => {
    listResult = () => Promise.reject(new Error('Not connected'))
    const { rerender } = render(SessionsScreen, { connected: true, onopen: vi.fn() })
    await waitFor(() => expect(screen.getByText(/Not connected/)).toBeInTheDocument())

    listResult = async () => [SESSION]
    await rerender({ connected: false, onopen: vi.fn() })
    await rerender({ connected: true, onopen: vi.fn() })
    await waitFor(() => expect(screen.getByTestId('session-row')).toHaveTextContent('rebase the stack'))
  })
})
