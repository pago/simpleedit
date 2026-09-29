import { describe, it, expect, vi, beforeEach } from 'vitest'

const handle = vi.fn()
const on = vi.fn()
vi.mock('electron', () => ({ ipcMain: { handle: (...a: unknown[]) => handle(...a), on: (...a: unknown[]) => on(...a) } }))

import { handleInvoke, handleSend, dispatchInvoke, dispatchSend, hasInvokeHandler, type CallOrigin } from '../ipc-registry'

const origin: CallOrigin = {
  sender: { id: 7, clientKey: 'w7.1', send: () => {}, isDestroyed: () => false },
}

beforeEach(() => {
  handle.mockClear()
  on.mockClear()
})

describe('ipc-registry', () => {
  it('registers with ipcMain and serves the same handler to a remote dispatch', async () => {
    handleInvoke('test:echo', (_event, value: string) => `echo:${value}`)

    expect(handle).toHaveBeenCalledWith('test:echo', expect.any(Function))
    expect(hasInvokeHandler('test:echo')).toBe(true)
    await expect(dispatchInvoke('test:echo', origin, ['hi'])).resolves.toBe('echo:hi')
  })

  it('hands the dispatching transport to the handler as the event sender', async () => {
    handleInvoke('test:who', (event) => event.sender.clientKey ?? String(event.sender.id))
    await expect(dispatchInvoke('test:who', origin, [])).resolves.toBe('w7.1')
  })

  it('awaits an async handler', async () => {
    handleInvoke('test:async', async () => 42)
    await expect(dispatchInvoke('test:async', origin, [])).resolves.toBe(42)
  })

  it('propagates a handler throw rather than swallowing it', async () => {
    handleInvoke('test:boom', () => { throw new Error('nope') })
    await expect(dispatchInvoke('test:boom', origin, [])).rejects.toThrow('nope')
  })

  // A remote client can name any string; an unregistered one must fail loudly
  // instead of resolving to undefined and reading as a call that did nothing.
  it('rejects an unregistered channel', async () => {
    expect(hasInvokeHandler('test:missing')).toBe(false)
    await expect(dispatchInvoke('test:missing', origin, [])).rejects.toThrow('Unknown channel')
  })

  it('dispatches send handlers too', () => {
    const seen: unknown[] = []
    handleSend('test:fire', (_event, payload: string) => { seen.push(payload) })
    expect(on).toHaveBeenCalledWith('test:fire', expect.any(Function))
    dispatchSend('test:fire', origin, ['payload'])
    expect(seen).toEqual(['payload'])
  })
})
