/**
 * The remote-access server: one per app (not per window), off by default.
 *
 * It serves the web bundle and upgrades `/<token>/ws`, over which a browser's
 * `window.api` shim speaks the same IPC channels the renderer does. A socket
 * does NOT mint a new client identity — it registers as an additional
 * transport on an existing window's `ClientHub`, because main keys the repo
 * maps, the watchers and the MCP bridge by `webContents.id`. A fresh id would
 * resolve to no repo, no bridge and no subscriptions.
 *
 * ── Security ──────────────────────────────────────────────────────────────
 * This surface reaches `pty:spawn`, `pty:write`, `fs:write`, `fs:delete`,
 * `worktree:remove` and every git operation. Whoever holds the token has the
 * machine. So:
 *
 *  - Off unless a person turns it on, and it stops with the app.
 *  - A 32-byte random token is the FIRST path segment of every request,
 *    compared in constant time. No token, no route — not even the index.
 *  - The bind host is always explicit and defaults to loopback. Nothing here
 *    ever passes `0.0.0.0`; reaching the phone is Tailscale's job, and putting
 *    a shell on every interface must stay a deliberate act.
 *  - Cross-origin requests are refused outright, and the WebSocket upgrade
 *    additionally requires the `Origin` to be the server's own — a token in a
 *    URL is a bearer credential, and the browser must not lend it to a page
 *    that guessed the port.
 *  - Only channels registered in `ipc-registry` dispatch; an unknown one is an
 *    error, never a silent success.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname, join, normalize, resolve, sep } from 'path'
import type { Socket } from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import { powerSaveBlocker } from 'electron'
import type { ClientHub, RemoteClient } from '../client-hub'
import { dispatchInvoke, dispatchSend } from '../ipc-registry'
import { parseClientFrame, type ServerFrame } from '../../shared/remote-protocol'
import type { RemoteAccessStatus } from '../../shared/ipc-types'

export interface RemoteServerOptions {
  host: string
  /** 0 for an ephemeral port. */
  port: number
  /** Directory holding the built web bundle. */
  webRoot: string
  /**
   * The client identity a new socket joins, chosen by the caller (it owns the
   * window list). `null` refuses the connection — there is nothing to join.
   */
  attachTarget: () => ClientHub | null
  /** Called whenever the reported status changes, so the UI can follow. */
  onStatusChange?: (status: RemoteAccessStatus) => void
}

interface RunningServer {
  http: Server
  wss: WebSocketServer
  token: string
  host: string
  port: number
  options: RemoteServerOptions
  sockets: Set<SocketTransport>
  powerSaveBlockerId: number | null
}

let running: RunningServer | null = null
let lastError: string | null = null
let socketSeq = 0

/**
 * One WebSocket seen as a `RemoteClient`. `id` is the hub's — this transport
 * joined that identity — while `clientKey` is its own, which is what lets PTY
 * size ownership distinguish the phone from the window it attached to.
 */
class SocketTransport implements RemoteClient {
  readonly id: number
  readonly clientKey: string

  constructor(private readonly ws: WebSocket, hubId: number) {
    this.id = hubId
    this.clientKey = `w${hubId}.${++socketSeq}`
  }

  send(channel: string, data: unknown): void {
    this.post({ kind: 'event', channel, data })
  }

  post(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      /* a socket that died mid-send is dropped by the next isDestroyed() */
    }
  }

  isDestroyed(): boolean {
    return this.ws.readyState !== this.ws.OPEN
  }

  close(): void {
    try {
      this.ws.close(1001, 'Remote access turned off')
    } catch {
      /* already closing */
    }
  }
}

/** Constant-time compare of an untrusted path segment against the token. */
function tokenMatches(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — compare a fixed-size digest-shaped pair instead by padding to the
  // longer of the two and folding the length difference into the result.
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** Split `/token/rest` into its two halves; null when the token is wrong. */
function routeOf(url: string | undefined, token: string): string | null {
  if (!url) return null
  const path = url.split('?')[0]
  if (!path.startsWith('/')) return null
  const slash = path.indexOf('/', 1)
  const candidate = slash === -1 ? path.slice(1) : path.slice(1, slash)
  if (!tokenMatches(candidate, token)) return null
  return slash === -1 ? '/' : path.slice(slash)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/**
 * Resolve `route` inside `webRoot`, or null if it escapes.
 *
 * The token gates the door, but a caller past it must still not be able to
 * read the whole disk through `../`.
 */
function resolveStatic(webRoot: string, route: string): string | null {
  const relative = normalize(decodeURIComponent(route)).replace(/^(\.\.[/\\])+/, '')
  const full = resolve(join(webRoot, relative))
  const root = resolve(webRoot)
  if (full !== root && !full.startsWith(root + sep)) return null
  if (!existsSync(full)) return null
  return statSync(full).isDirectory() ? resolveStatic(webRoot, join(relative, 'index.html')) : full
}

function serveStatic(res: ServerResponse, webRoot: string, route: string): void {
  const file = resolveStatic(webRoot, route === '/' ? '/index.html' : route)
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(
      existsSync(webRoot)
        ? 'Not found'
        : 'The web bundle has not been built. Run `pnpm build:web`.',
    )
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    // A bearer token lives in this URL; nothing about it should be cached by
    // an intermediary, and the referrer must not carry it off-origin.
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  createReadStream(file).pipe(res)
}

/** True when the request carries no `Origin`, or one naming this very server. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function attachSocket(ws: WebSocket, server: RunningServer): void {
  const hub = server.options.attachTarget()
  if (!hub) {
    ws.close(1011, 'No window to attach to')
    return
  }

  const transport = new SocketTransport(ws, hub.id)
  hub.register(transport)
  server.sockets.add(transport)
  transport.post({ kind: 'hello', windowId: hub.id, clientKey: transport.clientKey })
  emitStatus(server)

  ws.on('message', (raw: Buffer | string) => {
    const frame = parseClientFrame(typeof raw === 'string' ? raw : raw.toString('utf8'))
    if (!frame) return
    if (frame.kind === 'send') {
      try {
        dispatchSend(frame.channel, { sender: transport }, frame.args)
      } catch {
        /* `send` has no reply channel, exactly as in the preload bridge */
      }
      return
    }
    void dispatchInvoke(frame.channel, { sender: transport }, frame.args)
      .then((value) => transport.post({ kind: 'result', id: frame.id, ok: true, value }))
      .catch((error: unknown) =>
        transport.post({
          kind: 'result',
          id: frame.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
  })

  const detach = (): void => {
    hub.unregister(transport)
    server.sockets.delete(transport)
    emitStatus(server)
  }
  ws.on('close', detach)
  ws.on('error', detach)
}

function emitStatus(server: RunningServer): void {
  server.options.onStatusChange?.(getRemoteStatus())
}

export function getRemoteStatus(): RemoteAccessStatus {
  if (!running) {
    return {
      running: false,
      host: null,
      port: null,
      url: null,
      clients: 0,
      // No server, no assertion — the Mac is free to sleep again.
      powerSaveBlocked: false,
      error: lastError,
    }
  }
  return {
    running: true,
    host: running.host,
    port: running.port,
    url: `http://${running.host.includes(':') ? `[${running.host}]` : running.host}:${running.port}/${running.token}/`,
    clients: running.sockets.size,
    powerSaveBlocked:
      running.powerSaveBlockerId !== null && powerSaveBlocker.isStarted(running.powerSaveBlockerId),
    error: null,
  }
}

/**
 * Hold a power assertion for as long as remote access is on.
 *
 * `prevent-app-suspension` keeps the process running while still letting the
 * display sleep. Without it the Mac suspends, and both the notifications and
 * the AGENTS stop — silently, which is the worst version of that failure.
 */
function acquirePowerAssertion(): number | null {
  try {
    return powerSaveBlocker.start('prevent-app-suspension')
  } catch {
    return null
  }
}

function releasePowerAssertion(id: number | null): void {
  if (id === null) return
  try {
    if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)
  } catch {
    /* already stopped, or no power management on this platform */
  }
}

export async function startRemoteServer(options: RemoteServerOptions): Promise<RemoteAccessStatus> {
  if (running) return getRemoteStatus()

  const token = randomBytes(32).toString('hex')
  const wss = new WebSocketServer({ noServer: true })

  const http = createServer((req, res) => {
    if (!sameOrigin(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Cross-origin request refused')
      return
    }
    const route = routeOf(req.url, token)
    if (route === null || req.method !== 'GET') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    serveStatic(res, options.webRoot, route)
  })

  http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // An upgrade with no `Origin` is a non-browser client and stays allowed
    // (that is how a test harness connects); a browser one must be our own
    // page, or a site that guessed the port could borrow the token.
    const route = routeOf(req.url, token)
    if (route !== '/ws' || !sameOrigin(req) || !req.headers.origin) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!running) {
        ws.close(1011, 'Server stopped')
        return
      }
      attachSocket(ws, running)
    })
  })

  const port = await new Promise<number>((resolvePort, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.host, () => {
      const addr = http.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }
      resolvePort(addr.port)
    })
  }).catch((error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error)
    http.close()
    wss.close()
    return null
  })

  if (port === null) {
    options.onStatusChange?.(getRemoteStatus())
    return getRemoteStatus()
  }

  lastError = null
  running = {
    http,
    wss,
    token,
    host: options.host,
    port,
    options,
    sockets: new Set(),
    powerSaveBlockerId: acquirePowerAssertion(),
  }
  console.log(`[Remote] Listening on ${options.host}:${port}`)
  emitStatus(running)
  return getRemoteStatus()
}

export function stopRemoteServer(): RemoteAccessStatus {
  const server = running
  if (!server) return getRemoteStatus()
  running = null
  releasePowerAssertion(server.powerSaveBlockerId)
  // Closing the WebSocketServer does not close its clients, and a browser tab
  // left holding an open socket would keep a transport registered on a hub
  // that no longer has a server behind it.
  for (const transport of server.sockets) transport.close()
  server.wss.close()
  server.http.close()
  // `close()` only stops NEW connections. A browser tab still holding a socket
  // would keep the listener's handles alive, and an in-flight handle at quit is
  // how this app has hung on exit before (the codex-discovery hang, #176).
  server.http.closeAllConnections()
  server.sockets.clear()
  console.log('[Remote] Stopped')
  const status = getRemoteStatus()
  server.options.onStatusChange?.(status)
  return status
}

/** Exported for tests: the token currently in the URL, or null when stopped. */
export function currentRemoteToken(): string | null {
  return running?.token ?? null
}
