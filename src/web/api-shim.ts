/**
 * `window.api` over a WebSocket.
 *
 * The point of this file is to be INDISTINGUISHABLE from the preload bridge
 * (`src/preload/index.ts`). Every renderer component already talks to main
 * through those four methods, so a faithful shim is what lets the mobile
 * surfaces of later phases reuse them instead of reimplementing them.
 *
 * The socket needs the access key; the page that loads this does not. So the
 * key is handed in (`lib/remote-key.ts` decides which one), and a socket the
 * server refuses is followed by asking `/app/auth` whether that key is still
 * current — a refused upgrade looks the same to a browser as an unreachable
 * Mac, and only one of them is fixed by rescanning.
 */
import type { InvokeMap, EventMap, SendMap } from '../shared/ipc-types'
import type { ServerFrame } from '../shared/remote-protocol'

type Channel = keyof InvokeMap
type EventChannel = keyof EventMap
type SendChannel = keyof SendMap

type Listener = (data: never) => void

interface Pending {
  resolve: (value: never) => void
  reject: (reason: Error) => void
}

/** A frame waiting for the CURRENT socket to open. */
interface Queued {
  raw: string
  /** Set for an `invoke`, so a close can tell which promises never went out. */
  id?: number
}

/**
 * Thrown for a call that provably never left the device.
 *
 * Distinguished from a plain failure because the difference decides what the
 * user is told: a call that was never sent had no effect, while one that was
 * sent and never answered may have had every effect it asked for.
 */
export class NotSentError extends Error {
  // The draft store tells these apart by name, without importing this file.
  override name = 'NotSentError'
}

/** Thrown for a call that was sent and whose socket closed before an answer came. */
export class ConnectionLostError extends Error {
  override name = 'ConnectionLostError'
}

/** What the socket learned about itself when it attached. */
export interface RemoteIdentity {
  windowId: number
  clientKey: string
}

/**
 * `stale`: the Mac answered and does not know this key — it restarted, or
 * remote access went off and on. Retrying cannot fix that, so the shim stops
 * until it is given a new key. `unpaired`: there was no key to try at all.
 */
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'stale' | 'unpaired'

/** What `/app/auth` said. `unknown` covers every way of not getting an answer. */
export type KeyVerdict = 'current' | 'stale' | 'unknown'

export interface RemoteConnection {
  readonly state: () => ConnectionState
  /**
   * Who this socket currently is, or null before the first `hello`.
   *
   * NOT stable for the life of the page. A reconnect is a new socket and the
   * server mints it a new `clientKey`, so anything comparing an announced PTY
   * owner against "me" has to re-read this — a cached key would have the view
   * claiming it lost the terminal's size to itself.
   */
  readonly identity: () => RemoteIdentity | null
  /** Called on every state change, so a UI can show the connection honestly. */
  onStateChange: (fn: (state: ConnectionState) => void) => () => void
  /** Called on every `hello`, including a reconnect's. */
  onIdentity: (fn: (identity: RemoteIdentity) => void) => () => void
  /**
   * Reconnect with a new key, without navigating. A navigation would end the
   * standalone app's camera, its socket and every screen's state; the push
   * subscription belongs to the worker and is untouched either way.
   */
  setKey: (key: string) => void
  /**
   * Drop this socket and connect again at once, with no backoff.
   *
   * How the phone switches project: the new socket's URL names the other
   * window, so main runs exactly the detach and attach any connection gets —
   * the old window's hub loses the socket, and its size claims go with it.
   * Calls in flight fail as for any lost connection.
   */
  reconnect: () => void
}

export interface RemoteApiOptions {
  key: string | null
  /**
   * Query parameters for each new socket, read at every connect — which is
   * how a reconnect asks for the project the phone remembers.
   */
  attachParams?: () => Record<string, string>
  /** Injected by tests; the default asks the server. */
  checkKey?: (key: string) => Promise<KeyVerdict>
}

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

/** Relative to the page, so it follows wherever the server mounts the shell. */
function keyedUrl(name: string, key: string): URL {
  const url = new URL(name, window.location.href)
  url.search = `?k=${encodeURIComponent(key)}`
  url.hash = ''
  return url
}

export function socketUrl(key: string, params: Record<string, string> = {}): string {
  const url = keyedUrl('ws', key)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [name, value] of Object.entries(params)) {
    // The key is never something an attach parameter can replace.
    if (name !== 'k') url.searchParams.set(name, value)
  }
  return url.toString()
}

/**
 * Bounded: on a dead tailnet path a fetch can hang for minutes, and the retry
 * that follows this answer would never be scheduled. No answer is `unknown`.
 */
const KEY_CHECK_TIMEOUT_MS = 5_000

export async function checkKeyWithServer(key: string, timeoutMs = KEY_CHECK_TIMEOUT_MS): Promise<KeyVerdict> {
  try {
    const res = await fetch(keyedUrl('auth', key), { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 204) return 'current'
    if (res.status === 401) return 'stale'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export function installRemoteApi(options: RemoteApiOptions): RemoteConnection {
  const checkKey = options.checkKey ?? checkKeyWithServer
  let key = options.key
  let ws: WebSocket | null = null
  let state: ConnectionState = 'connecting'
  let nextId = 1
  let backoff = RECONNECT_MIN_MS
  let retry: ReturnType<typeof setTimeout> | null = null
  /** Bumped by `setKey`, so a verdict about the previous key is not acted on. */
  let generation = 0
  /** A `reconnect()` is waiting for this socket's close; skip the backoff. */
  let immediate = false

  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Set<Listener>>()
  const stateWatchers = new Set<(state: ConnectionState) => void>()
  /**
   * Frames waiting for a socket to carry them, flushed in order when one opens.
   *
   * A frame and the promise waiting on it share ONE fate. A close rejects every
   * pending call, so anything queued at that moment has already been reported
   * as failed and must not be replayed — otherwise a call the user saw fail
   * (and re-made) arrives twice on reconnect: two sessions from one confirmed
   * `session:create`, or a review posted after the user was told it might not
   * have been and a second time when they act on that advice.
   *
   * Frames queued AFTER a close belong to the next socket and still have a live
   * promise, so those flush as normal — that gap is what the outbox is for.
   */
  const outbox: Queued[] = []

  let identity: RemoteIdentity | null = null
  const identityWatchers = new Set<(identity: RemoteIdentity) => void>()

  function setState(next: ConnectionState): void {
    if (state === next) return
    state = next
    for (const fn of stateWatchers) fn(next)
  }

  /**
   * Send a frame, or hold it until a socket can carry it — the case every
   * screen hits on load, because the page mounts while the first socket is
   * still connecting, and again during a reconnect backoff.
   */
  function post(frame: object, id?: number): void {
    // No socket is coming until a new key arrives, which may be never. Holding
    // the frame would replay it minutes later — a keystroke typed at the stale
    // page landing in an agent's PTY after the rescan.
    if (state === 'stale' || state === 'unpaired') {
      if (id !== undefined) {
        pending.get(id)?.reject(new NotSentError('Not connected: this app needs a current key'))
        pending.delete(id)
      }
      return
    }
    const raw = JSON.stringify(frame)
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(raw)
    else outbox.push({ raw, id })
  }

  function handle(frame: ServerFrame): void {
    if (frame.kind === 'hello') {
      identity = { windowId: frame.windowId, clientKey: frame.clientKey }
      for (const fn of identityWatchers) fn(identity)
      return
    }
    if (frame.kind === 'event') {
      for (const fn of listeners.get(frame.channel) ?? []) fn(frame.data as never)
      return
    }
    const waiting = pending.get(frame.id)
    if (!waiting) return
    pending.delete(frame.id)
    if (frame.ok) waiting.resolve(frame.value as never)
    else waiting.reject(new Error(frame.error))
  }

  /**
   * Fail everything the socket was carrying. The outbox goes with the socket it
   * was filled for: anything still in it never left the device, which is a
   * materially different thing to tell the caller than "sent, no answer" — so
   * those calls are rejected apart.
   */
  function failInFlight(): void {
    // The key belonged to THAT socket. Holding it would have the next
    // `pty:owner-changed` compared against an identity that no longer exists.
    identity = null
    const neverSent = new Set(outbox.map((queued) => queued.id))
    outbox.length = 0
    // Every in-flight call dies with the socket. Leaving them pending would
    // hang whatever awaited them for the rest of the page's life.
    for (const [id, waiting] of pending) {
      waiting.reject(
        neverSent.has(id)
          ? new NotSentError('The connection went before the call was sent')
          : new ConnectionLostError('Connection lost'),
      )
    }
    pending.clear()
  }

  function scheduleRetry(): void {
    retry = setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
  }

  async function retryUnlessStale(attempt: number, tried: string): Promise<void> {
    const verdict = await checkKey(tried).catch((): KeyVerdict => 'unknown')
    if (attempt !== generation) return
    if (verdict === 'stale') {
      setState('stale')
      failInFlight()
      return
    }
    scheduleRetry()
  }

  function connect(): void {
    retry = null
    if (!key) {
      setState('unpaired')
      failInFlight()
      return
    }
    setState('connecting')
    const attempt = generation
    const tried = key
    let opened = false
    const socket = new WebSocket(socketUrl(tried, options.attachParams?.()))
    ws = socket

    socket.addEventListener('open', () => {
      opened = true
      backoff = RECONNECT_MIN_MS
      setState('open')
      for (const { raw } of outbox.splice(0)) socket.send(raw)
    })

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(event.data) as ServerFrame
      } catch {
        return
      }
      handle(frame)
    })

    socket.addEventListener('close', () => {
      if (ws !== socket) return
      ws = null
      setState('closed')
      failInFlight()
      if (immediate) {
        immediate = false
        connect()
        return
      }
      // A socket that never opened may have been refused for its key. One that
      // opened and then dropped had a good key a moment ago; its retry will ask
      // if that has changed.
      if (opened) scheduleRetry()
      else void retryUnlessStale(attempt, tried)
    })

    // `error` is always followed by `close`, which owns the retry.
    socket.addEventListener('error', () => { /* handled by close */ })
  }

  const api = {
    send<K extends SendChannel>(channel: K, data: SendMap[K]): void {
      post({ kind: 'send', channel, args: [data] })
    },

    invoke<K extends Channel>(
      channel: K,
      ...args: InvokeMap[K]['args']
    ): Promise<InvokeMap[K]['result']> {
      const id = nextId++
      return new Promise<InvokeMap[K]['result']>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: never) => void, reject })
        // `id` rides along so a close can tell this frame apart from one that
        // already went out — see `NotSentError`.
        post({ kind: 'invoke', id, channel, args }, id)
      })
    },

    on<K extends EventChannel>(channel: K, callback: (data: EventMap[K]) => void): () => void {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      const listener = callback as Listener
      set.add(listener)
      return () => { set.delete(listener) }
    },

    once<K extends EventChannel>(channel: K, callback: (data: EventMap[K]) => void): void {
      const off = api.on(channel, (data) => {
        off()
        callback(data)
      })
    },

    /**
     * A browser `File` has no filesystem path, which is the documented no-path
     * case `Terminal.svelte` already handles by falling back to the file's
     * contents. Nothing to do differently here.
     */
    getPathForFile(_file: File): string {
      return ''
    },
  }

  connect()
  ;(globalThis as unknown as { api: typeof api }).api = api

  function setKey(next: string): void {
    key = next
    generation++
    if (retry !== null) clearTimeout(retry)
    backoff = RECONNECT_MIN_MS
    const previous = ws
    ws = null
    if (previous) {
      failInFlight()
      previous.close()
    }
    connect()
  }

  return {
    state: () => state,
    identity: () => identity,
    onStateChange(fn) {
      stateWatchers.add(fn)
      return () => { stateWatchers.delete(fn) }
    },
    onIdentity(fn) {
      identityWatchers.add(fn)
      if (identity) fn(identity)
      return () => { identityWatchers.delete(fn) }
    },
    setKey,
    reconnect() {
      // While stale or unpaired only a new key helps; a reconnect would just
      // be refused again.
      if (state === 'stale' || state === 'unpaired') return
      // During a backoff there is no socket to close; bring the retry forward.
      // Its timer has to go, or it would open a second socket later.
      if (!ws) {
        if (retry !== null) clearTimeout(retry)
        // A key check may still be out for the socket that dropped; its answer
        // would schedule a retry alongside this connect.
        generation++
        connect()
        return
      }
      immediate = true
      ws.close()
    },
  }
}
