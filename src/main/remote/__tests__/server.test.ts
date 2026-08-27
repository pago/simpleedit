import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'

const blockers = new Set<number>()
let nextBlockerId = 1
vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
  powerSaveBlocker: {
    start: () => {
      const id = nextBlockerId++
      blockers.add(id)
      return id
    },
    stop: (id: number) => { blockers.delete(id) },
    isStarted: (id: number) => blockers.has(id),
  },
}))

import { startRemoteServer, stopRemoteServer, getRemoteStatus, currentRemoteToken } from '../server'
import { handleInvoke } from '../../ipc-registry'
import { ClientHub } from '../../client-hub'
import type { ServerFrame } from '../../../shared/remote-protocol'

const HOST = '127.0.0.1'
let hub: ClientHub

handleInvoke('test:remote-echo', (_event, value: string) => `echo:${value}`)
handleInvoke('test:remote-who', (event) => event.sender.clientKey ?? String(event.sender.id))
handleInvoke('test:remote-boom', () => { throw new Error('handler exploded') })

async function start(): Promise<{ url: string; token: string }> {
  const status = await startRemoteServer({
    host: HOST,
    port: 0,
    webRoot: '/nonexistent-web-root',
    attachTarget: () => hub,
  })
  if (!status.running || !status.port) throw new Error(status.error ?? 'server did not start')
  const token = currentRemoteToken()!
  return { url: `http://${HOST}:${status.port}`, token }
}

/** Connect, and resolve once the `hello` frame has landed. */
async function connect(url: string, token: string): Promise<{ ws: WebSocket; frames: ServerFrame[]; hello: ServerFrame }> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/${token}/ws`, { origin: url })
  const frames: ServerFrame[] = []
  ws.on('message', (raw: Buffer) => { frames.push(JSON.parse(raw.toString('utf8')) as ServerFrame) })
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res())
    ws.once('error', rej)
  })
  await waitFor(() => frames.length > 0)
  return { ws, frames, hello: frames[0] }
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function invoke(ws: WebSocket, id: number, channel: string, args: unknown[] = []): void {
  ws.send(JSON.stringify({ kind: 'invoke', id, channel, args }))
}

beforeEach(() => {
  hub = new ClientHub(42, { id: 42, send: () => {}, isDestroyed: () => false })
})

afterEach(() => {
  stopRemoteServer()
})

describe('remote server', () => {
  it('is not running until started, and holds no power assertion', () => {
    const status = getRemoteStatus()
    expect(status.running).toBe(false)
    expect(status.powerSaveBlocked).toBe(false)
    expect(status.url).toBeNull()
  })

  it('holds a power assertion while running and releases it on stop', async () => {
    await start()
    expect(getRemoteStatus().powerSaveBlocked).toBe(true)
    stopRemoteServer()
    expect(getRemoteStatus().powerSaveBlocked).toBe(false)
    expect(blockers.size).toBe(0)
  })

  it('serves nothing without the token', async () => {
    const { url, token } = await start()
    expect((await fetch(`${url}/`)).status).toBe(404)
    expect((await fetch(`${url}/${'0'.repeat(token.length)}/`)).status).toBe(404)
    // With the right token the route resolves — the bundle just isn't built here.
    const ok = await fetch(`${url}/${token}/`)
    expect(ok.status).toBe(404)
    expect(await ok.text()).toContain('pnpm build:web')
  })

  it('refuses a cross-origin request', async () => {
    const { url, token } = await start()
    const res = await fetch(`${url}/${token}/`, { headers: { origin: 'http://evil.example' } })
    expect(res.status).toBe(403)
  })

  it('refuses a socket on the wrong path or a foreign origin', async () => {
    const { url, token } = await start()
    const wsUrl = url.replace('http', 'ws')
    for (const target of [`${wsUrl}/${token}/nope`, `${wsUrl}/wrong-token/ws`]) {
      await expect(
        new Promise((res, rej) => {
          const ws = new WebSocket(target, { origin: url })
          ws.once('open', () => res('opened'))
          ws.once('error', rej)
        }),
      ).rejects.toBeTruthy()
    }
    await expect(
      new Promise((res, rej) => {
        const ws = new WebSocket(`${wsUrl}/${token}/ws`, { origin: 'http://evil.example' })
        ws.once('open', () => res('opened'))
        ws.once('error', rej)
      }),
    ).rejects.toBeTruthy()
  })

  it('joins the existing hub rather than minting an identity', async () => {
    const { url, token } = await start()
    expect(hub.transportCount).toBe(1)
    const { ws, hello } = await connect(url, token)

    expect(hello).toEqual({ kind: 'hello', windowId: 42, clientKey: expect.stringMatching(/^w42\./) })
    expect(hub.transportCount).toBe(2)
    expect(getRemoteStatus().clients).toBe(1)

    ws.close()
    await waitFor(() => hub.transportCount === 1)
    expect(getRemoteStatus().clients).toBe(0)
  })

  it('round-trips an invoke through the same handler the renderer uses', async () => {
    const { url, token } = await start()
    const { ws, frames } = await connect(url, token)

    invoke(ws, 1, 'test:remote-echo', ['hello'])
    await waitFor(() => frames.length > 1)
    expect(frames[1]).toEqual({ kind: 'result', id: 1, ok: true, value: 'echo:hello' })

    ws.close()
  })

  it('stamps the socket as the event sender, distinct from the window', async () => {
    const { url, token } = await start()
    const { ws, frames, hello } = await connect(url, token)

    invoke(ws, 2, 'test:remote-who')
    await waitFor(() => frames.length > 1)
    const key = (hello as { clientKey: string }).clientKey
    expect(frames[1]).toEqual({ kind: 'result', id: 2, ok: true, value: key })
    expect(key).not.toBe('42')

    ws.close()
  })

  it('reports a handler throw as a failed result, not a dropped call', async () => {
    const { url, token } = await start()
    const { ws, frames } = await connect(url, token)

    invoke(ws, 3, 'test:remote-boom')
    await waitFor(() => frames.length > 1)
    expect(frames[1]).toEqual({ kind: 'result', id: 3, ok: false, error: 'handler exploded' })

    ws.close()
  })

  it('rejects an unregistered channel instead of resolving it', async () => {
    const { url, token } = await start()
    const { ws, frames } = await connect(url, token)

    invoke(ws, 4, 'definitely:not-a-channel')
    await waitFor(() => frames.length > 1)
    expect(frames[1]).toMatchObject({ kind: 'result', id: 4, ok: false })

    ws.close()
  })

  it('pushes a hub event to the attached socket', async () => {
    const { url, token } = await start()
    const { ws, frames } = await connect(url, token)

    hub.send('agent:status', { worktreePath: '/w', status: 'waiting' })
    await waitFor(() => frames.some((f) => f.kind === 'event'))
    expect(frames.find((f) => f.kind === 'event')).toEqual({
      kind: 'event',
      channel: 'agent:status',
      data: { worktreePath: '/w', status: 'waiting' },
    })

    ws.close()
  })

  it('closes attached sockets when remote access is turned off', async () => {
    const { url, token } = await start()
    const { ws } = await connect(url, token)
    const closed = new Promise<void>((res) => ws.once('close', () => res()))

    stopRemoteServer()
    await closed
    await waitFor(() => hub.transportCount === 1)
  })
})
