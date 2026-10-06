/**
 * The remote-access server: one per app (not per window), off by default.
 *
 * It serves the web bundle under `/app/` and upgrades `/app/ws?k=<key>`, over
 * which a browser's `window.api` shim speaks the same IPC channels the
 * renderer does. A socket does NOT mint a new client identity — it registers
 * as an additional transport on an existing window's `ClientHub`, because main
 * keys the repo maps, the watchers and the MCP bridge by `webContents.id`. A
 * fresh id would resolve to no repo, no bridge and no subscriptions.
 *
 * ── Security ──────────────────────────────────────────────────────────────
 * This surface reaches `pty:spawn`, `pty:write`, `fs:write`, `fs:delete`,
 * `worktree:remove` and every git operation. Whoever holds the key has the
 * machine. So:
 *
 *  - Off unless a person turns it on, and it stops with the app.
 *  - A 32-byte random key is minted on every start and never persisted.
 *  - **The key gates the socket, and the socket is the only way in.** The
 *    upgrade carries it as `?k=`, compared in constant time; without it there
 *    is no socket, and without a socket no IPC channel, no event and no byte
 *    of data. `/app/auth` answers one bit — is this key current — so the page
 *    can tell "out of date" from "unreachable", which a refused upgrade cannot.
 *  - **The shell is public, and only the shell.** The files of the built web
 *    bundle under `/app/` are served without the key: they are the same for
 *    every user and every start, and hold no data. That is what lets an
 *    installed app keep a stable scope across restarts and recover from a
 *    rotated key by rescanning (#190). Nothing else is served without it — a
 *    file outside the bundle, a directory listing or any dynamic content is a
 *    404. The two shell responses that vary echo a well-formed key the
 *    REQUEST carried (the manifest's start URL, so an install carries it); they
 *    never read the real one.
 *  - The bind host is always explicit and defaults to loopback. Nothing here
 *    ever passes `0.0.0.0`; reaching the phone is Tailscale's job, and putting
 *    a shell on every interface must stay a deliberate act.
 *  - Cross-origin requests are refused outright, and the WebSocket upgrade
 *    additionally requires an `Origin` naming the host it was sent to — see
 *    `sameOrigin` for what that does and does not stop.
 *  - Only channels registered in `ipc-registry` dispatch; an unknown one is an
 *    error, never a silent success.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'fs'
import { extname, join, resolve, sep } from 'path'
import type { Socket } from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import { powerSaveBlocker } from 'electron'
import type { ClientHub, RemoteClient } from '../client-hub'
import { dispatchInvoke, dispatchSend } from '../ipc-registry'
import { parseClientFrame, type ServerFrame } from '../../shared/remote-protocol'
import { parseAttachRequest, type AttachRequest } from './attach-target'
import type { PtyClientId, RemoteAccessStatus } from '../../shared/ipc-types'
import { APP_PATH, appLink } from '../../shared/remote-pairing'

export interface RemoteServerOptions {
  host: string
  /** 0 for an ephemeral port. */
  port: number
  /** Directory holding the built web bundle. */
  webRoot: string
  /**
   * The client identity a new socket joins, chosen by the caller (it owns the
   * window list) from what the socket asked for, if anything. `null` refuses
   * the connection — there is nothing to join.
   */
  attachTarget: (request: AttachRequest | null) => ClientHub | null
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

/** Constant-time compare of an untrusted key against the server's. */
function tokenMatches(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  // `timingSafeEqual` throws on a length mismatch, so a wrong length returns
  // early. That reveals only the length, which is public: every key is 64 hex
  // characters, and the callers have already refused any other shape.
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** The shape of a key — and therefore of the first path segment of a pre-#190 link. */
const KEY_SHAPE = /^[0-9a-f]{64}$/

/** The `k` query parameter, if it has the shape of a key. Says nothing about whether it is current. */
function keyParam(url: string | undefined): string | null {
  const query = (url ?? '').split('?')[1]?.split('#')[0]
  if (query === undefined) return null
  const value = new URLSearchParams(query).get('k')
  return value !== null && KEY_SHAPE.test(value) ? value : null
}

function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0].split('#')[0]
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}

function redirect(res: ServerResponse, location: string): void {
  // 302, not 301: a permanent redirect is cached, and these answers depend on
  // what this server is doing now.
  res.writeHead(302, { location, 'cache-control': 'no-store' })
  res.end()
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
 * This runs WITHOUT the key, so it is the whole of what an unauthenticated
 * caller can reach: the built bundle, and nothing outside it. Containment is
 * one check on the fully resolved path, AFTER decoding — `%2e%2e%2f` is `../`
 * only once decoded. `decodeURIComponent` throws on a lone `%` (a truncated
 * pasted link is enough), and an uncaught throw inside the request listener
 * takes the whole main process down with it, so `before-quit` never runs and
 * every agent PTY is orphaned.
 *
 * Exported for tests.
 */
export function resolveStatic(webRoot: string, route: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(route)
  } catch {
    return null
  }
  const root = resolve(webRoot)
  const full = resolve(root, `.${sep}${decoded}`)
  if (full !== root && !full.startsWith(root + sep)) return null
  if (!existsSync(full)) return null
  return statSync(full).isDirectory() ? resolveStatic(webRoot, join(full.slice(root.length), 'index.html')) : full
}

const SHELL_HEADERS = {
  // The URL can carry the key; nothing about it should be cached by an
  // intermediary, and the referrer must not carry it off-origin.
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  // Public now, so any site could frame it or probe for it. Neither framing
  // (clickjacking the scanner or a paste) nor a no-cors `<script src=sw.js>`
  // from another origin — which would tell a page that SimpleEdit runs here —
  // has a legitimate use.
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
} as const

/**
 * The manifest link in `index.html`, exactly as Vite emits it. Pinned by a test
 * against the source file, so a reformat fails loudly rather than shipping an
 * install that forgets its key.
 */
export const MANIFEST_LINK = 'href="./manifest.webmanifest"'

/**
 * The two shell files that differ per request, both only by echoing `key` —
 * the request's own, shape-checked, never the server's.
 *
 * iOS saves the start URL once, at install, from the manifest the page links.
 * A static `start_url` cannot carry a per-start key, so the page served at
 * `/app/?k=K` links `manifest.webmanifest?k=K`, and that manifest's start URL
 * is `/app/?k=K`. The installed app then launches with the key it was
 * installed with; a later in-app rescan supersedes it (`lib/remote-key.ts`).
 */
function personalise(file: string, body: string, key: string): string {
  if (file.endsWith('index.html')) {
    return body.replace(MANIFEST_LINK, `href="./manifest.webmanifest?k=${key}"`)
  }
  if (file.endsWith('.webmanifest')) {
    try {
      const manifest = JSON.parse(body) as Record<string, unknown>
      manifest.start_url = `./?k=${key}`
      return JSON.stringify(manifest)
    } catch {
      return body
    }
  }
  return body
}

function serveStatic(res: ServerResponse, webRoot: string, route: string, key: string | null): void {
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
  const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...SHELL_HEADERS }
  if (key && (file.endsWith('index.html') || file.endsWith('.webmanifest'))) {
    res.writeHead(200, headers)
    res.end(personalise(file, readFileSync(file, 'utf8'), key))
    return
  }
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
}

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
 * browser loads `https://mac.tailnet.ts.net/app/` and sends
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

/**
 * True when the request carries no `Origin` (a navigation, or a non-browser
 * client), or one naming the very host the request was addressed to.
 *
 * Stateless on purpose: the shell is reached without the key, so no
 * navigation proves anything worth remembering about its origin.
 *
 * What it stops: a page on another site opening a socket to this port with a
 * key it somehow holds (the browser sends that site's `Origin`, not ours).
 * What it does NOT stop: a DNS-rebound name, whose `Origin` and `Host` agree
 * by construction. That page can read the public shell, which is published
 * source; it cannot open the socket without the key, and with the key it
 * could simply open the real page. The key is the boundary; this is the
 * belt to its braces.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  return origin === originOf(req.headers, req.socket.remoteAddress)
}

function attachSocket(ws: WebSocket, server: RunningServer, request: AttachRequest | null): void {
  const hub = server.options.attachTarget(request)
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
    url: appLink(`http://${running.host}:${running.port}`, running.token),
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

  // Built before `listen` so a stop arriving mid-start has something to tear
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
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') return notFound(res)
    if (!sameOrigin(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Cross-origin request refused')
      return
    }
    const path = pathOf(req.url)
    const query = (req.url ?? '').includes('?') ? `?${(req.url ?? '').split('?')[1]}` : ''

    if (path === '/app/auth') {
      const key = keyParam(req.url)
      res.writeHead(key !== null && tokenMatches(key, token) ? 204 : 401, SHELL_HEADERS)
      res.end()
      return
    }
    // Without the trailing slash every relative asset and the socket URL
    // resolve one level up — a blank page on exactly the link someone retypes.
    if (path === '/' || path === '/app') return redirect(res, `${APP_PATH}${query}`)
    // A pre-#190 link, `/<key>/…`: the key moved out of the path, and whatever
    // key this one carried is from an earlier start. The stale-key page says
    // what to do. Nothing from the old path is forwarded.
    const first = path.split('/')[1] ?? ''
    if (KEY_SHAPE.test(first)) return redirect(res, `${APP_PATH}?from=legacy`)
    if (!path.startsWith(APP_PATH)) return notFound(res)
    serveStatic(res, options.webRoot, path.slice(APP_PATH.length - 1), keyParam(req.url))
  }

  http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // A browser always sends `Origin` on a WebSocket handshake, and it must
    // name the host the page was loaded from. An upgrade with none is a
    // non-browser client and is refused: nothing we ship connects that way.
    const key = keyParam(req.url)
    if (
      pathOf(req.url) !== `${APP_PATH}ws` ||
      key === null ||
      !tokenMatches(key, token) ||
      !req.headers.origin ||
      !sameOrigin(req)
    ) {
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
        attachSocket(ws, state, parseAttachRequest(req.url))
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

/** The key of the running server, or null when stopped. */
export function currentRemoteToken(): string | null {
  return running?.token ?? null
}
