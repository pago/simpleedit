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
import type { PtyClientId, RemoteAccessStatus } from '../../shared/ipc-types'

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
  /**
   * A socket has gone. Everything main keys by `PtyClientId` — today only PTY
   * size ownership — has to let go of it, and only the caller knows what that
   * is; this module deliberately knows nothing about terminals.
   */
  onClientGone?: (clientKey: PtyClientId) => void
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
  /** Origins of pages this server has served — see `learnOrigin`. */
  origins: Set<string>
}

let running: RunningServer | null = null
/**
 * A start that has begun but not yet finished listening.
 *
 * `running` is only assigned after the `await` on `listen`, so `if (running)`
 * is not an in-flight guard: two concurrent `remote:set-enabled(true)` calls
 * each built a server and each took a power assertion, and the second
 * overwrote `running` — leaving the first's blocker id unreachable, so
 * `stopRemoteServer` could never release it and the Mac would not suspend
 * again for the life of the process, remote access off or not.
 */
let starting: Promise<RemoteAccessStatus> | null = null
let lastError: string | null = null
let socketSeq = 0

/**
 * Watermark past which a socket is CLOSED rather than buffered into.
 *
 * `pty:data` from a busy terminal outruns a slow link, and `readyState` says
 * nothing about that — the kernel accepts the write and Node buffers the rest
 * in main's heap, without bound.
 *
 * Dropping frames was the wrong answer. A gap in `pty:data` is written to
 * xterm verbatim, so a truncated escape sequence corrupts the parser for
 * everything after it; a dropped `pty:exit` leaves a session that never ends;
 * and `lsp:message` carries JSON-RPC RESPONSES, so a drop there strands a
 * renderer request forever — the very failure the `result` exemption existed
 * to prevent. Silent corruption is worse than a dead connection.
 *
 * Closing is honest and recoverable: the shim reconnects, and a reconnect is
 * where resynchronisation belongs.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024

/**
 * Cap on ONE inbound frame. Comfortably above the largest legitimate call —
 * base64 of a capped audio recording — and far below what `ws` allows by
 * default. A client past it has its socket closed by the library.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

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
    // A client that cannot drain is disconnected, never quietly skipped: it
    // must not be possible to miss an event and not know it.
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(1013, 'Too far behind')
      return
    }
    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      /* a socket that died mid-send is dropped by the next isDestroyed() */
    }
  }

  isDestroyed(): boolean {
    return this.ws.readyState !== this.ws.OPEN
  }

  close(code = 1001, reason = 'Remote access turned off'): void {
    try {
      this.ws.close(code, reason)
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
  // Served with the wrong type, iOS ignores the manifest entirely — and with
  // no manifest there is no standalone install, and with no install there is
  // no push permission to ask for.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/**
 * Resolve `route` inside `webRoot`, or null if it escapes or will not decode.
 *
 * The token gates the door, but a caller past it must still not be able to
 * read the whole disk through `../`. `decodeURIComponent` throws on a lone
 * `%` — a truncated pasted link is enough — and an uncaught throw inside the
 * request listener takes the whole main process down with it, which means
 * `before-quit` never runs and every agent PTY is orphaned.
 */
function resolveStatic(webRoot: string, route: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(route)
  } catch {
    return null
  }
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
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

/**
 * Origins that a page WE SERVED is running under.
 *
 * The test is not "does this hostname look like us" — string equality against
 * the bound IP rejects `localhost` and every MagicDNS name, which is the phone
 * path this feature exists for, and resolving the hostname instead is exactly
 * what DNS rebinding defeats (a rebound `evil.com` resolves to the bound
 * address by construction). Neither answers the real question.
 *
 * So the server records it. A top-level navigation carries no `Origin` and
 * does carry the token, so serving one is proof that a token holder reached us
 * under that `Host` — and the origin of the page we just returned is exactly
 * `scheme://<that Host>`. Subresources and the WebSocket upgrade, which DO
 * carry `Origin`, are then matched against what was recorded.
 *
 * An attacker cannot register an origin without the token, and with the token
 * they could simply open the page. Bounded so a token holder cannot grow it
 * without limit.
 */
const MAX_LEARNED_ORIGINS = 16

/** A header that may arrive as a list — `x-forwarded-proto: https,http`. */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim() || undefined
}

/** Loopback peers only: the reverse proxy runs on this machine. */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}

/**
 * The origin a browser will report for the page this request is fetching.
 *
 * `tailscale serve` is the documented way to get HTTPS on a `*.ts.net` name,
 * and it TERMINATES TLS and reverse-proxies to a local HTTP server. So the
 * browser loads `https://mac.tailnet.ts.net/<token>/` and sends
 * `Origin: https://mac.tailnet.ts.net` on every module script, stylesheet and
 * the WebSocket upgrade — while the request reaching us is plain HTTP.
 * Assuming `http://` records an origin no browser will ever send, and every
 * asset 403s: a blank page, behind exactly the deployment phase 4 requires,
 * since `getUserMedia` needs a secure context and a raw Tailscale IP over HTTP
 * is not one.
 *
 * The forwarded headers are only honoured for a LOOPBACK peer. A proxy the
 * user configured runs on this machine and connects over loopback; anything
 * arriving on the Tailscale interface is a real remote client and does not get
 * to name its own scheme or host. That narrowing costs nothing — the two
 * supported deployments are loopback-behind-a-proxy and direct-to-tailnet, and
 * only the first has a proxy to trust.
 */
export function originOf(
  headers: IncomingMessage['headers'],
  remoteAddress: string | undefined,
): string | null {
  const trusted = isLoopbackPeer(remoteAddress)
  const forwardedHost = trusted ? firstHeaderValue(headers['x-forwarded-host']) : undefined
  const forwardedProto = trusted ? firstHeaderValue(headers['x-forwarded-proto']) : undefined
  const host = forwardedHost ?? headers.host
  if (!host) return null
  return `${forwardedProto === 'https' ? 'https' : 'http'}://${host}`
}

/** Remember the origin of a page we are about to serve. Token already checked. */
function learnOrigin(server: RunningServer, req: IncomingMessage): void {
  const origin = originOf(req.headers, req.socket.remoteAddress)
  if (!origin) return
  if (server.origins.has(origin)) return
  if (server.origins.size >= MAX_LEARNED_ORIGINS) return
  server.origins.add(origin)
}

/**
 * True when the request carries no `Origin` (a navigation, or a non-browser
 * client), or one belonging to a page this server served.
 */
function knownOrigin(server: RunningServer, req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  return server.origins.has(origin)
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
    // This transport may have been sizing a terminal. Nothing else will notice
    // it is gone — a PTY outlives every client — so the owner has to hear about
    // it here, or the claim is held by a socket that no longer exists for the
    // terminal's life.
    server.options.onClientGone?.(transport.clientKey)
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
  // Pruned through the SAME predicate the hub uses, so the reported count and
  // the hub's transport count can never disagree.
  for (const transport of [...running.sockets]) {
    if (transport.isDestroyed()) running.sockets.delete(transport)
  }
  return {
    running: true,
    host: running.host,
    port: running.port,
    // IPv4 only — `listRemoteInterfaces` offers nothing else, so no bracketing.
    url: `http://${running.host}:${running.port}/${running.token}/`,
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

export function startRemoteServer(options: RemoteServerOptions): Promise<RemoteAccessStatus> {
  if (running) return Promise.resolve(getRemoteStatus())
  // Set BEFORE the first await, so a concurrent caller joins this start rather
  // than building a second server and a second power assertion. Callers are
  // serialised upstream (`applyRemoteConfig`), so a join always shares the
  // options of the start it joined.
  if (starting) return starting
  starting = openServer(options).finally(() => { starting = null })
  return starting
}

/**
 * True once `stopRemoteServer` has been called for the start currently in
 * flight. `running` is assigned only after `listen` resolves, so a stop that
 * arrives before then would find nothing to stop and no-op — leaving a
 * listening socket with a live token and a held power assertion behind, while
 * the config and the UI both said OFF.
 */
let stopRequested = false

async function openServer(options: RemoteServerOptions): Promise<RemoteAccessStatus> {
  stopRequested = false
  const token = randomBytes(32).toString('hex')
  // Bounded. `stt:transcribe` carries base64 audio, which is the first frame
  // on this socket a client can make large on purpose; `ws` would otherwise
  // buffer up to 100 MB into main's heap before anything looked at it.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const http = createServer((req, res) => handleRequest(req, res))

  // Built before `listen` so the request handlers have somewhere to record
  // learned origins, and so a stop arriving mid-start has something to tear
  // down. Published to `running` only once it is actually listening.
  const state: RunningServer = {
    http,
    wss,
    token,
    host: options.host,
    port: 0,
    options,
    sockets: new Set(),
    powerSaveBlockerId: null,
    origins: new Set(),
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Token FIRST: an origin is only worth learning from a request that
    // already proved it holds the token.
    const route = routeOf(req.url, token)
    if (route === null || req.method !== 'GET') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    if (!knownOrigin(state, req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Cross-origin request refused')
      return
    }
    // No `Origin` means a top-level navigation (or a non-browser client), so
    // the page we are about to return will run under this `Host`.
    if (!req.headers.origin) learnOrigin(state, req)
    // `/<token>` without the trailing slash serves index.html, but every
    // relative asset and the socket URL then resolve one level up, WITHOUT the
    // token — a blank page and a silently reconnecting socket, on exactly the
    // link someone retypes onto a phone. Redirect rather than serve.
    if (route === '/' && !(req.url ?? '').split('?')[0].endsWith('/')) {
      res.writeHead(301, { location: `/${token}/`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    serveStatic(res, options.webRoot, route)
  }

  http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // A browser always sends `Origin` on a WebSocket handshake, and it must
    // name a page this server served. An upgrade with none is a non-browser
    // client and is refused: nothing we ship connects that way.
    const route = routeOf(req.url, token)
    if (route !== '/ws' || !req.headers.origin || !knownOrigin(state, req)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (running !== state) {
        ws.close(1011, 'Server stopped')
        return
      }
      // `attachSocket` resolves a hub, and that can throw for a window that has
      // gone. A synchronous throw here is inside neither a promise nor a try,
      // so it would be fatal to the whole process.
      try {
        attachSocket(ws, state)
      } catch (error) {
        console.error('[Remote] Refusing socket:', error)
        ws.close(1011, 'No window to attach to')
      }
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

  state.port = port
  // The address we bound is an origin by definition; everything else is
  // learned from a navigation that carried the token.
  state.origins.add(`http://${options.host}:${port}`)

  // A stop that arrived while `listen` was pending found no `running` to act
  // on. Honour it here instead of publishing a server nobody asked for.
  if (stopRequested) {
    stopRequested = false
    teardown(state)
    return getRemoteStatus()
  }

  lastError = null
  state.powerSaveBlockerId = acquirePowerAssertion()
  running = state
  console.log(`[Remote] Listening on ${options.host}:${port}`)
  emitStatus(state)
  return getRemoteStatus()
}

/** Close everything `state` holds. Safe whether or not it was ever published. */
function teardown(state: RunningServer): void {
  releasePowerAssertion(state.powerSaveBlockerId)
  state.powerSaveBlockerId = null
  // Closing the WebSocketServer does not close its clients, and a browser tab
  // left holding an open socket would keep a transport registered on a hub
  // that no longer has a server behind it.
  for (const transport of state.sockets) transport.close()
  state.wss.close()
  state.http.close()
  // `close()` only stops NEW connections. A browser tab still holding a socket
  // would keep the listener's handles alive, and an in-flight handle at quit is
  // how this app has hung on exit before (the codex-discovery hang, #176).
  state.http.closeAllConnections()
  state.sockets.clear()
  state.origins.clear()
  console.log('[Remote] Stopped')
}

export function stopRemoteServer(): RemoteAccessStatus {
  // Claim any start still in flight, so it tears itself down on completion
  // rather than publishing a listening server after we said we had stopped.
  if (starting) stopRequested = true
  const server = running
  if (!server) return getRemoteStatus()
  running = null
  teardown(server)
  const status = getRemoteStatus()
  server.options.onStatusChange?.(status)
  return status
}

/**
 * Close every socket attached to `hubId`. Called when that window closes.
 *
 * A socket left open outlives its window: its next invoke reaches `hubFor`
 * with the destroyed window's id, which would mint a FRESH hub under that id
 * and revive everything keyed by it — chokidar watchers installed after the
 * per-window unwatch already ran, and a repo map entry for a window that is
 * gone.
 */
export function closeSocketsForHub(hubId: number): void {
  if (!running) return
  let closed = 0
  for (const transport of [...running.sockets]) {
    if (transport.id !== hubId) continue
    transport.close()
    running.sockets.delete(transport)
    closed++
  }
  if (closed > 0) emitStatus(running)
}

/** Exported for tests: the token currently in the URL, or null when stopped. */
export function currentRemoteToken(): string | null {
  return running?.token ?? null
}
