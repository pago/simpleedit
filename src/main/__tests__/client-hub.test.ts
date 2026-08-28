import { describe, it, expect, vi } from 'vitest'
import { ClientHub, type RemoteClient } from '../client-hub'
import type { WebContents } from 'electron'

// Compile-time proof of the assumption the whole refactor rests on: a real
// Electron WebContents can be handed to any module that now takes a
// RemoteClient, with no adapter. If this ever stops compiling, the widened
// signatures in pty/claude-stream/mcp-bridge/... are no longer safe.
type WebContentsIsRemoteClient = WebContents extends RemoteClient ? true : false
const _webContentsSatisfiesRemoteClient: WebContentsIsRemoteClient = true
void _webContentsSatisfiesRemoteClient

function makeTransport(id = 1) {
  let destroyed = false
  return {
    id,
    send: vi.fn<(channel: string, data: unknown) => void>(),
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true },
  }
}

describe('ClientHub', () => {
  it('keeps the id it was constructed with, not a transport id', () => {
    const hub = new ClientHub(42, makeTransport(7))
    expect(hub.id).toBe(42)
  })

  it('splits a payload by transport: the window gets `local`, a socket `remote`', () => {
    // A socket transport is the one carrying a `clientKey`; a WebContents never
    // has one. Screen PRs rides this to keep full diffs off the wire.
    const windowTransport = makeTransport()
    const socket = { ...makeTransport(), clientKey: 'w1.3' }
    const hub = new ClientHub(1, windowTransport)
    hub.register(socket)

    hub.sendSplit('screenprs:card', { card: { diff: 'full' } }, { card: { diff: '' } })

    expect(windowTransport.send).toHaveBeenCalledWith('screenprs:card', { card: { diff: 'full' } })
    expect(socket.send).toHaveBeenCalledWith('screenprs:card', { card: { diff: '' } })
  })

  it('fans one send out to every registered transport', () => {
    const a = makeTransport()
    const b = makeTransport()
    const hub = new ClientHub(1, a)
    hub.register(b)

    hub.send('agent:status', { status: 'idle' })

    expect(a.send).toHaveBeenCalledWith('agent:status', { status: 'idle' })
    expect(b.send).toHaveBeenCalledWith('agent:status', { status: 'idle' })
  })

  it('stops sending to an unregistered transport', () => {
    const a = makeTransport()
    const hub = new ClientHub(1, a)
    hub.unregister(a)

    hub.send('x', null)

    expect(a.send).not.toHaveBeenCalled()
  })

  // The invariant the fan-out rests on: one window closing must not silence a
  // still-attached remote client, and callers guard on isDestroyed() before
  // sending exactly as they did with a bare WebContents.
  it('is destroyed only once every transport is gone', () => {
    const a = makeTransport()
    const b = makeTransport()
    const hub = new ClientHub(1, a)
    hub.register(b)

    a.destroy()
    expect(hub.isDestroyed()).toBe(false)

    hub.send('x', null)
    expect(a.send).not.toHaveBeenCalled()
    expect(b.send).toHaveBeenCalledTimes(1)

    b.destroy()
    expect(hub.isDestroyed()).toBe(true)
  })

  it('is destroyed when it has no transports at all', () => {
    expect(new ClientHub(1).isDestroyed()).toBe(true)
  })

  it('drops destroyed transports instead of retaining them', () => {
    const a = makeTransport()
    const hub = new ClientHub(1, a)
    expect(hub.transportCount).toBe(1)

    a.destroy()
    expect(hub.transportCount).toBe(0)

    hub.register(makeTransport())
    expect(hub.transportCount).toBe(1)
  })
})
