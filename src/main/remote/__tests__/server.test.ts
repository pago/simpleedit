import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { request, createServer } from 'http'

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

import { startRemoteServer, stopRemoteServer, getRemoteStatus, currentRemoteToken, closeSocketsForHub, originOf, isLoopbackPeer } from '../server'
import { handleInvoke } from '../../ipc-registry'
import { ClientHub } from '../../client-hub'
import type { ServerFrame } from '../../../shared/remote-protocol'

const HOST = '127.0.0.1'
let hub: ClientHub

handleInvoke('test:remote-echo', (_event, value: string) => `echo:${value}`)
handleInvoke('test:remote-who', (event) => event.sender.clientKey ?? String(event.sender.id))
handleInvoke('test:remote-boom', () => { throw new Error('handler exploded') })
handleInvoke('test:remote-is-window', (event) => event.sender.clientKey === undefined)

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

// Generous: these wait on real loopback sockets, and the suite shares a
// machine with an Electron build when the full gate runs.
async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** An ephemeral port, released before it is returned. */
async function freePort(): Promise<number> {
  const probe = createServer()
  const port = await new Promise<number>((res) => {
    probe.listen(0, HOST, () => {
      const addr = probe.address()
      res(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
  await new Promise<void>((res) => probe.close(() => res()))
  return port
}

/** True if `port` can be bound — i.e. nothing is listening on it. */
function bindable(port: number): Promise<boolean> {
  return new Promise((res) => {
    const probe = createServer()
    probe.once('error', () => res(false))
    probe.listen(port, HOST, () => probe.close(() => res(true)))
  })
}

/** A GET with headers `fetch` will not let us set (notably `Host`). */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, method: 'GET', headers, setHost: false }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
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

  // A DNS-rebound page sends an Origin and a Host that agree with each OTHER
  // while naming a hostname that resolves to us. Self-consistency proves
  // nothing, and neither does resolving the hostname — rebinding makes it
  // resolve to the bound address by construction. `fetch` refuses to forge
  // Host, so this goes out over a raw request.
  it('refuses an origin belonging to no page it ever served', async () => {
    const { url, token } = await start()
    const { port } = new URL(url)
    const status = await rawGet(Number(port), `/${token}/`, {
      host: `rebound.example:${port}`,
      origin: `http://rebound.example:${port}`,
    })
    expect(status).toBe(403)
  })

  // The blocker: string-comparing the Origin against the bound IP rejects
  // `localhost` and every MagicDNS name. Module scripts and stylesheets are
  // fetched in CORS mode, so they carry Origin — the page loads and then every
  // asset 403s, which is a blank screen with no error, on the phone path this
  // whole feature exists for.
  it('serves assets to a page reached by a name, not just the bound IP', async () => {
    const { url, token } = await start()
    const { port } = new URL(url)
    const asName = { host: `localhost:${port}`, origin: `http://localhost:${port}` }

    // Before any navigation under that name, the origin is unknown.
    expect(await rawGet(Number(port), `/${token}/`, asName)).toBe(403)

    // The navigation itself carries the token and no Origin — which is what
    // makes it proof that a token holder reached us under this name.
    expect(await rawGet(Number(port), `/${token}/`, { host: `localhost:${port}` })).toBe(404)

    // Now the page's subresources are recognised as ours. (404 rather than 200
    // only because the bundle is not built in this suite.)
    expect(await rawGet(Number(port), `/${token}/assets/app.js`, asName)).toBe(404)
  })

  // `tailscale serve` terminates TLS and reverse-proxies to a local HTTP
  // server, so the browser's Origin is `https://<name>.ts.net` while the
  // request reaching us is plain HTTP. Recording `http://` there means every
  // module script and stylesheet 403s — a blank page, on the deployment phase
  // 4 requires, since getUserMedia needs a secure context.
  it('recognises a page served through a TLS-terminating proxy', async () => {
    const { url, token } = await start()
    const { port } = new URL(url)
    const NAME = 'mac.tailnet.ts.net'

    // The navigation, as the proxy forwards it: plain HTTP, no Origin, with
    // the real scheme and name in the forwarded headers.
    expect(
      await rawGet(Number(port), `/${token}/`, {
        host: `127.0.0.1:${port}`,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': NAME,
      }),
    ).toBe(404)

    // The assets the browser then fetches, carrying the origin it really has.
    expect(
      await rawGet(Number(port), `/${token}/assets/app.js`, {
        host: `127.0.0.1:${port}`,
        origin: `https://${NAME}`,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': NAME,
      }),
    ).toBe(404)

    // And not some other name the proxy never mentioned.
    expect(
      await rawGet(Number(port), `/${token}/assets/app.js`, {
        host: `127.0.0.1:${port}`,
        origin: 'https://elsewhere.ts.net',
      }),
    ).toBe(403)
  })

  it('will not learn an origin from a request without the token', async () => {
    const { url, token } = await start()
    const { port } = new URL(url)
    // A navigation with the WRONG token must not register its Host, or an
    // attacker could enrol their own origin without holding the credential.
    expect(await rawGet(Number(port), `/wrong-token/`, { host: `evil.example:${port}` })).toBe(404)
    expect(
      await rawGet(Number(port), `/${token}/`, {
        host: `evil.example:${port}`,
        origin: `http://evil.example:${port}`,
      }),
    ).toBe(403)
  })

  it('survives a URL that will not percent-decode', async () => {
    const { url, token } = await start()
    // A truncated pasted link. An uncaught URIError here would take the whole
    // main process with it, orphaning every agent PTY.
    expect((await fetch(`${url}/${token}/%`)).status).toBe(404)
    expect(getRemoteStatus().running).toBe(true)
  })

  it('redirects the token path without a trailing slash', async () => {
    const { url, token } = await start()
    const res = await fetch(`${url}/${token}`, { redirect: 'manual' })
    // Serving index.html here would resolve every asset and the socket URL one
    // level up, without the token: a blank page and a silent reconnect loop.
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe(`/${token}/`)
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

  // A socket can hold state main keys by `PtyClientId` — today the PTY size
  // claim. Nothing else notices it is gone: a PTY outlives every client, and
  // `pty:claim` only fires on an attention CHANGE, so a window already sitting
  // on that terminal never reclaims. The claim has to be released here.
  it('reports a departed socket\'s client key, so its claims can be released', async () => {
    const gone: string[] = []
    const status = await startRemoteServer({
      host: HOST,
      port: 0,
      webRoot: '/nonexistent-web-root',
      attachTarget: () => hub,
      onClientGone: (key) => { gone.push(key) },
    })
    const token = currentRemoteToken()!
    const url = `http://${HOST}:${status.port}`
    const { ws, hello } = await connect(url, token)
    const key = (hello as { clientKey: string }).clientKey

    ws.close()
    await waitFor(() => gone.length > 0)
    expect(gone).toEqual([key])
  })

  // A socket joins an existing hub, so `sender.id` is the window's id and a
  // handler keyed by it cannot tell the two apart on its own. Channels that
  // WRITE per-window state have to; `clientKey` is what distinguishes them.
  it('carries a clientKey a handler can refuse, unlike the window itself', async () => {
    const { url, token } = await start()
    const { ws, frames, hello } = await connect(url, token)

    invoke(ws, 9, 'test:remote-is-window')
    await waitFor(() => frames.length > 1)
    expect(frames[1]).toEqual({ kind: 'result', id: 9, ok: true, value: false })
    // Same hub id as the window it joined — which is exactly why the id is not
    // enough to tell them apart.
    expect((hello as { windowId: number }).windowId).toBe(hub.id)

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

  // `running` is assigned only after `listen` resolves, so `if (running)` was
  // no guard at all: two concurrent starts each built a server and each took a
  // power assertion, and the second overwrote `running` — leaving the first's
  // blocker id unreachable forever, so the Mac would not suspend again.
  it('joins a start already in flight instead of building a second server', async () => {
    const options = {
      host: HOST,
      port: 0,
      webRoot: '/nonexistent-web-root',
      attachTarget: () => hub,
    }
    const [a, b] = await Promise.all([startRemoteServer(options), startRemoteServer(options)])

    expect(a.port).toBe(b.port)
    expect(blockers.size).toBe(1)

    stopRemoteServer()
    expect(blockers.size).toBe(0)
  })

  // The hub sheds a transport as soon as `isDestroyed()` is true, which is
  // throughout CLOSING; `server.sockets` was only pruned on `close`. The two
  // must never disagree, or the pane reports a client that is already gone.
  it('never reports a client count the hub disagrees with', async () => {
    const { url, token } = await start()
    const { ws } = await connect(url, token)

    const disagreements: string[] = []
    const sample = (): void => {
      const clients = getRemoteStatus().clients
      const transports = hub.transportCount - 1 // minus the window's own
      if (clients !== transports) disagreements.push(`${clients} vs ${transports}`)
    }

    sample()
    ws.close()
    for (let i = 0; i < 40; i++) {
      sample()
      await new Promise((r) => setTimeout(r, 5))
    }
    await waitFor(() => hub.transportCount === 1)
    sample()

    expect(disagreements).toEqual([])
  })

  it('closes a hub\'s sockets when its window goes', async () => {
    const { url, token } = await start()
    const { ws } = await connect(url, token)
    const closed = new Promise<void>((res) => ws.once('close', () => res()))

    // A socket left open outlives its window, and its next invoke names a
    // destroyed window id — which would mint a fresh hub and revive an MCP
    // bridge and watchers behind the teardown that already ran.
    closeSocketsForHub(42)

    await closed
    await waitFor(() => hub.transportCount === 1)
    expect(getRemoteStatus().clients).toBe(0)
  })

  it('leaves other hubs alone when one window goes', async () => {
    const { url, token } = await start()
    const { ws } = await connect(url, token)

    closeSocketsForHub(999)
    await new Promise((r) => setTimeout(r, 100))

    expect(ws.readyState).toBe(ws.OPEN)
    expect(getRemoteStatus().clients).toBe(1)
    ws.close()
  })

  // `running` is assigned only after `listen` resolves, so a stop arriving
  // before then used to find nothing and no-op — leaving a listening socket
  // with a live token and a held power assertion, while config and UI said OFF.
  it('honours a stop that arrives while the start is still in flight', async () => {
    // A fixed port, so "nothing is listening" can be PROVEN by binding it
    // again rather than merely inferred from the reported status.
    const port = await freePort()
    const pending = startRemoteServer({
      host: HOST,
      port,
      webRoot: '/nonexistent-web-root',
      attachTarget: () => hub,
    })
    stopRemoteServer()
    await pending

    expect(getRemoteStatus().running).toBe(false)
    expect(blockers.size).toBe(0)
    expect(currentRemoteToken()).toBeNull()
    await expect(bindable(port)).resolves.toBe(true)
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

describe('originOf', () => {
  const LOCAL = '127.0.0.1'

  it('uses the Host header when nothing is in front of the server', () => {
    expect(originOf({ host: 'localhost:8080' }, LOCAL)).toBe('http://localhost:8080')
  })

  it('takes the scheme and name from a loopback proxy', () => {
    const origin = originOf(
      { host: '127.0.0.1:8080', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mac.ts.net' },
      LOCAL,
    )
    expect(origin).toBe('https://mac.ts.net')
  })

  // A remote client reaching the Tailscale interface directly is not a proxy,
  // and must not get to name its own scheme or host.
  it('ignores forwarded headers from a peer that is not on loopback', () => {
    const origin = originOf(
      { host: '100.101.102.103:8080', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' },
      '100.64.0.9',
    )
    expect(origin).toBe('http://100.101.102.103:8080')
  })

  it('reads only the first value of a forwarded header list', () => {
    expect(originOf({ host: 'h', 'x-forwarded-proto': 'https, http' }, LOCAL)).toBe('https://h')
    expect(originOf({ host: 'h', 'x-forwarded-proto': ['https', 'http'] }, LOCAL)).toBe('https://h')
  })

  it('treats any scheme but https as http, never as arbitrary text', () => {
    expect(originOf({ host: 'h', 'x-forwarded-proto': 'javascript' }, LOCAL)).toBe('http://h')
  })

  it('has no origin without a host', () => {
    expect(originOf({}, LOCAL)).toBeNull()
  })

  it('recognises loopback in its IPv4, IPv6 and mapped forms', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('::1')).toBe(true)
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('100.64.0.9')).toBe(false)
    expect(isLoopbackPeer(undefined)).toBe(false)
  })
})
