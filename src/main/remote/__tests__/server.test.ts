import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { request, createServer } from 'http'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

import { startRemoteServer, stopRemoteServer, getRemoteStatus, currentRemoteToken, closeSocketsForHub, originOf, isLoopbackPeer, MANIFEST_LINK } from '../server'
import { handleInvoke } from '../../ipc-registry'
import { ClientHub } from '../../client-hub'
import type { ServerFrame } from '../../../shared/remote-protocol'
import type { RemoteAccessStatus } from '../../../shared/ipc-types'

const HOST = '127.0.0.1'
let hub: ClientHub

handleInvoke('test:remote-echo', (_event, value: string) => `echo:${value}`)
handleInvoke('test:remote-who', (event) => event.sender.clientKey ?? String(event.sender.id))
handleInvoke('test:remote-boom', () => { throw new Error('handler exploded') })
handleInvoke('test:remote-is-window', (event) => event.sender.clientKey === undefined)

/** A stand-in for the built bundle: the shell files, and a secret outside it. */
const WEB_ROOT = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-web-'))
  const root = join(dir, 'web')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), `<html><head><link rel="manifest" ${MANIFEST_LINK} /></head><body>SimpleEdit</body></html>`)
  writeFileSync(join(root, 'manifest.webmanifest'), JSON.stringify({ id: '/app/', start_url: './', scope: './' }))
  writeFileSync(join(root, 'sw.js'), 'self.addEventListener("push", () => {})')
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(dir, 'secret.txt'), 'outside the bundle')
  return root
})()

async function start(webRoot = WEB_ROOT): Promise<{ url: string; token: string }> {
  const status = await startRemoteServer({
    host: HOST,
    port: 0,
    webRoot,
    attachTarget: () => hub,
  })
  if (!status.running || !status.port) throw new Error(status.error ?? 'server did not start')
  const token = currentRemoteToken()!
  return { url: `http://${HOST}:${status.port}`, token }
}

/** Connect, and resolve once the `hello` frame has landed. */
async function connect(url: string, token: string): Promise<{ ws: WebSocket; frames: ServerFrame[]; hello: ServerFrame }> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/app/ws?k=${token}`, { origin: url })
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

/** A WebSocket that either opens or is refused; resolves to which. */
function tryOpen(target: string, origin?: string): Promise<'opened' | 'refused'> {
  return new Promise((res) => {
    const ws = new WebSocket(target, origin ? { origin } : {})
    ws.once('open', () => { ws.close(); res('opened') })
    ws.once('error', () => res('refused'))
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

  it('hands out its link at the shell path, with the key in the query', async () => {
    const { url, token } = await start()
    expect(getRemoteStatus().url).toBe(`${url}/app/?k=${token}`)
  })

  // The boundary #190 moved: the shell is public, the socket is not. Every
  // route a caller WITHOUT the key can reach is listed here.
  it('serves the shell without the key, and nothing else', async () => {
    const { url } = await start()
    const shell = await fetch(`${url}/app/`)
    expect(shell.status).toBe(200)
    expect(shell.headers.get('cache-control')).toBe('no-store')
    expect(shell.headers.get('referrer-policy')).toBe('no-referrer')
    expect((await fetch(`${url}/app/assets/app.js`)).status).toBe(200)
    expect((await fetch(`${url}/app/sw.js`)).status).toBe(200)

    // Outside the bundle, by any spelling, is not reachable.
    expect((await fetch(`${url}/app/../secret.txt`)).status).toBe(404)
    expect((await fetch(`${url}/app/%2e%2e/secret.txt`)).status).toBe(404)
    expect((await fetch(`${url}/secret.txt`)).status).toBe(404)
    expect((await fetch(`${url}/app/nope.js`)).status).toBe(404)
    // And nothing but GET.
    expect((await fetch(`${url}/app/`, { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('refuses the socket without the current key', async () => {
    const { url, token } = await start()
    const ws = url.replace('http', 'ws')
    for (const target of [
      `${ws}/app/ws`,
      `${ws}/app/ws?k=`,
      `${ws}/app/ws?k=${'0'.repeat(64)}`,
      `${ws}/app/ws?k=${token.slice(0, 63)}`,
      `${ws}/app/ws?k=${token}0`,
      `${ws}/app/ws?k=${token.toUpperCase()}`,
      // The pre-#190 socket URL, key in the path.
      `${ws}/${token}/ws`,
      `${ws}/app/nope?k=${token}`,
    ]) {
      expect(await tryOpen(target, url), target).toBe('refused')
    }
    expect(await tryOpen(`${ws}/app/ws?k=${token}`, url)).toBe('opened')
  })

  it('reaches no IPC handler without the key', async () => {
    const { url } = await start()
    const seen: string[] = []
    handleInvoke('test:remote-canary', () => { seen.push('called'); return 'leaked' })
    const ws = new WebSocket(`${url.replace('http', 'ws')}/app/ws?k=${'1'.repeat(64)}`, { origin: url })
    const outcome = await new Promise<string>((res) => {
      ws.once('open', () => {
        invoke(ws, 1, 'test:remote-canary')
        res('opened')
      })
      ws.once('error', () => res('refused'))
    })
    expect(outcome).toBe('refused')
    // An HTTP request naming a channel is just a path that does not exist.
    expect((await fetch(`${url}/app/test:remote-canary`)).status).toBe(404)
    expect(seen).toEqual([])
  })

  it('answers whether a key is current, and nothing more', async () => {
    const { url, token } = await start()
    const current = await fetch(`${url}/app/auth?k=${token}`)
    expect(current.status).toBe(204)
    expect(await current.text()).toBe('')
    expect((await fetch(`${url}/app/auth?k=${'0'.repeat(64)}`)).status).toBe(401)
    expect((await fetch(`${url}/app/auth`)).status).toBe(401)
  })

  it('keeps a key from a previous start out', async () => {
    const first = await start()
    stopRemoteServer()
    const second = await start()
    expect(second.token).not.toBe(first.token)
    const ws = second.url.replace('http', 'ws')
    expect(await tryOpen(`${ws}/app/ws?k=${first.token}`, second.url)).toBe('refused')
    expect((await fetch(`${second.url}/app/auth?k=${first.token}`)).status).toBe(401)
  })

  // The old installed app and every saved link open `/<key>/`. They must land
  // on the page that says what happened, not a bare 404 — and must not be
  // forwarded anything from the path they came with.
  it('sends a pre-#190 link to the stale-key page', async () => {
    const { url, token } = await start()
    for (const old of [`/${'f'.repeat(64)}/`, `/${'f'.repeat(64)}`, `/${token}/`, `/${'f'.repeat(64)}/index.html`]) {
      const res = await fetch(`${url}${old}`, { redirect: 'manual' })
      expect(res.status, old).toBe(302)
      expect(res.headers.get('location'), old).toBe('/app/?from=legacy')
    }
  })

  it('redirects the root and the slashless shell path to the shell, keeping the query', async () => {
    const { url, token } = await start()
    const root = await fetch(`${url}/`, { redirect: 'manual' })
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/app/')
    const bare = await fetch(`${url}/app?k=${token}`, { redirect: 'manual' })
    expect(bare.headers.get('location')).toBe(`/app/?k=${token}`)
  })

  // iOS saves the manifest's start URL at install. It has to carry the key the
  // page was opened with — echoed from the request, never read from the server.
  it('carries the page\'s own key into the manifest an install reads', async () => {
    const { url, token } = await start()
    const page = await (await fetch(`${url}/app/?k=${token}`)).text()
    expect(page).toContain(`href="./manifest.webmanifest?k=${token}"`)
    const manifest = (await (await fetch(`${url}/app/manifest.webmanifest?k=${token}`)).json()) as Record<string, string>
    expect(manifest.start_url).toBe(`./?k=${token}`)
    expect(manifest.scope).toBe('./')
    expect(manifest.id).toBe('/app/')

    // Without a key, or with something that is not shaped like one, the files
    // are served as built — so no request can make them say anything else.
    expect(await (await fetch(`${url}/app/`)).text()).not.toContain('?k=')
    const odd = await (await fetch(`${url}/app/?k=%22%3E%3Cscript%3E`)).text()
    expect(odd).not.toContain('<script>')
    const plain = (await (await fetch(`${url}/app/manifest.webmanifest`)).json()) as Record<string, string>
    expect(plain.start_url).toBe('./')
  })

  it('pins the manifest link the server rewrites to the real index.html', () => {
    const source = readFileSync(join(__dirname, '../../../web/index.html'), 'utf8')
    expect(source).toContain(MANIFEST_LINK)
  })

  it('refuses a cross-origin request', async () => {
    const { url } = await start()
    const res = await fetch(`${url}/app/`, { headers: { origin: 'http://evil.example' } })
    expect(res.status).toBe(403)
  })

  // The blocker that shaped this check: string-comparing the Origin against the
  // bound IP rejects `localhost` and every MagicDNS name. Module scripts and
  // stylesheets are fetched in CORS mode, so they carry Origin — the page loads
  // and then every asset 403s, a blank screen with no error.
  it('serves assets to a page reached by a name, not just the bound IP', async () => {
    const { url } = await start()
    const { port } = new URL(url)
    expect(
      await rawGet(Number(port), '/app/assets/app.js', { host: `localhost:${port}`, origin: `http://localhost:${port}` }),
    ).toBe(200)
    // An Origin naming some other host than the one addressed is cross-origin.
    expect(
      await rawGet(Number(port), '/app/assets/app.js', { host: `localhost:${port}`, origin: `http://evil.example:${port}` }),
    ).toBe(403)
  })

  // `tailscale serve` terminates TLS and reverse-proxies to a local HTTP
  // server, so the browser's Origin is `https://<name>.ts.net` while the
  // request reaching us is plain HTTP.
  it('recognises a page served through a TLS-terminating proxy', async () => {
    const { url, token } = await start()
    const { port } = new URL(url)
    const NAME = 'mac.tailnet.ts.net'
    const proxied = { host: `127.0.0.1:${port}`, 'x-forwarded-proto': 'https', 'x-forwarded-host': NAME }
    expect(await rawGet(Number(port), '/app/assets/app.js', { ...proxied, origin: `https://${NAME}` })).toBe(200)
    // And not some other name the proxy never mentioned.
    expect(await rawGet(Number(port), '/app/assets/app.js', { ...proxied, origin: 'https://elsewhere.ts.net' })).toBe(403)

    const opened = await new Promise<string>((res) => {
      const ws = new WebSocket(`${url.replace('http', 'ws')}/app/ws?k=${token}`, {
        origin: `https://${NAME}`,
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': NAME },
      })
      ws.once('open', () => { ws.close(); res('opened') })
      ws.once('error', () => res('refused'))
    })
    expect(opened).toBe('opened')
  })

  // A DNS-rebound page sends an Origin and a Host that agree with each other.
  // It can read the public shell; what it must not reach is the socket, and
  // the key is what stops it there.
  it('lets a rebound name read only the shell', async () => {
    const { url } = await start()
    const { port } = new URL(url)
    const rebound = { host: `rebound.example:${port}`, origin: `http://rebound.example:${port}` }
    expect(await rawGet(Number(port), '/app/', rebound)).toBe(200)
    expect(await rawGet(Number(port), `/app/auth?k=${'0'.repeat(64)}`, rebound)).toBe(401)
    const opened = await new Promise<string>((res) => {
      const ws = new WebSocket(`ws://${HOST}:${port}/app/ws?k=${'0'.repeat(64)}`, {
        origin: `http://rebound.example:${port}`,
        headers: { host: `rebound.example:${port}` },
      })
      ws.once('open', () => res('opened'))
      ws.once('error', () => res('refused'))
    })
    expect(opened).toBe('refused')
  })

  it('survives a URL that will not percent-decode', async () => {
    const { url } = await start()
    // A truncated pasted link. An uncaught URIError here would take the whole
    // main process with it, orphaning every agent PTY.
    expect((await fetch(`${url}/app/%`)).status).toBe(404)
    expect(getRemoteStatus().running).toBe(true)
  })

  it('says the bundle is missing rather than serving nothing quietly', async () => {
    const { url } = await start('/nonexistent-web-root')
    const res = await fetch(`${url}/app/`)
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('pnpm build:web')
  })

  it('refuses a socket with the key but a foreign origin, or no origin', async () => {
    const { url, token } = await start()
    const target = `${url.replace('http', 'ws')}/app/ws?k=${token}`
    expect(await tryOpen(target, 'http://evil.example')).toBe('refused')
    expect(await tryOpen(target)).toBe('refused')
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

  it('emits status only when closing a hub actually closed a socket', async () => {
    const statuses: RemoteAccessStatus[] = []
    const status = await startRemoteServer({
      host: HOST,
      port: 0,
      webRoot: '/nonexistent-web-root',
      attachTarget: () => hub,
      onStatusChange: (s) => statuses.push(s),
    })
    const url = `http://${HOST}:${status.port}`
    const { ws } = await connect(url, currentRemoteToken()!)
    const closed = new Promise<void>((res) => ws.once('close', () => res()))
    statuses.length = 0

    closeSocketsForHub(999)
    expect(statuses).toEqual([])

    closeSocketsForHub(42)
    expect(statuses.at(-1)?.clients).toBe(0)
    await closed
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

describe('choosing the window a socket joins', () => {
  async function connectTo(url: string, token: string, query: string): Promise<{ ws: WebSocket; hello: ServerFrame }> {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/${token}/ws${query}`, { origin: url })
    const frames: ServerFrame[] = []
    ws.on('message', (raw: Buffer) => { frames.push(JSON.parse(raw.toString('utf8')) as ServerFrame) })
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res())
      ws.once('error', rej)
    })
    await waitFor(() => frames.length > 0)
    return { ws, hello: frames[0] }
  }

  it('hands the caller what the socket URL asked for', async () => {
    const asked: unknown[] = []
    const status = await startRemoteServer({
      host: HOST,
      port: 0,
      webRoot: '/nonexistent-web-root',
      attachTarget: (request) => {
        asked.push(request)
        return hub
      },
    })
    const url = `http://${HOST}:${status.port}`
    const token = currentRemoteToken()!

    const plain = await connectTo(url, token, '')
    const named = await connectTo(url, token, `?window=7&repo=${encodeURIComponent('/p/b.git')}`)
    const junk = await connectTo(url, token, '?window=-1&repo=')

    expect(asked).toEqual([null, { windowId: 7, repoPath: '/p/b.git' }, null])
    plain.ws.close()
    named.ws.close()
    junk.ws.close()
  })

  // A project switch is a reconnect naming the other window. The window left
  // behind must lose the socket and any size claim it made, exactly as for a
  // dropped connection — a hub still holding it would keep feeding it, and a
  // claim held by a socket that is gone freezes the desktop's terminal size.
  it('leaves nothing on the old window when a phone switches', async () => {
    const other = new ClientHub(7, { id: 7, send: () => {}, isDestroyed: () => false })
    const gone: string[] = []
    const status = await startRemoteServer({
      host: HOST,
      port: 0,
      webRoot: '/nonexistent-web-root',
      attachTarget: (request) => (request?.windowId === 7 ? other : hub),
      onClientGone: (key) => { gone.push(key) },
    })
    const url = `http://${HOST}:${status.port}`
    const token = currentRemoteToken()!

    const first = await connectTo(url, token, '')
    const firstKey = (first.hello as { clientKey: string }).clientKey
    expect(hub.transportCount).toBe(2)

    first.ws.close()
    const second = await connectTo(url, token, '?window=7&repo=%2Fp%2Fb.git')

    await waitFor(() => hub.transportCount === 1 && gone.length === 1)
    expect(gone).toEqual([firstKey])
    expect(second.hello).toEqual({ kind: 'hello', windowId: 7, clientKey: expect.stringMatching(/^w7\./) })
    expect(other.transportCount).toBe(2)
    expect(getRemoteStatus().clients).toBe(1)

    // And the old window's teardown no longer reaches it.
    closeSocketsForHub(42)
    expect(other.transportCount).toBe(2)
    second.ws.close()
  })
})
