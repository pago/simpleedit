/**
 * `window.api` over a WebSocket.
 *
 * The point of this file is to be INDISTINGUISHABLE from the preload bridge
 * (`src/preload/index.ts`). Every renderer component already talks to main
 * through those four methods, so a faithful shim is what lets the mobile
 * surfaces of later phases reuse them instead of reimplementing them.
 *
 * The page is served from `/<token>/`, so the socket URL is derived from
 * `location` and the token is never written down here.
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

/** What the socket learned about itself when it attached. */
export interface RemoteIdentity {
  windowId: number
  clientKey: string
}

export type ConnectionState = 'connecting' | 'open' | 'closed'

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
}

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

export function socketUrl(): string {
  // `location.pathname` is `/<token>/`, so a relative 'ws' lands on the
  // token-gated endpoint without this file ever handling the token itself.
  const url = new URL('ws', window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function installRemoteApi(): RemoteConnection {
  let ws: WebSocket | null = null
  let state: ConnectionState = 'connecting'
  let nextId = 1
  let backoff = RECONNECT_MIN_MS

  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Set<Listener>>()
  const stateWatchers = new Set<(state: ConnectionState) => void>()
  /**
   * Frames written before the socket opened. Flushed in order on open.
   *
   * A frame and the promise waiting on it share ONE fate. A close rejects
   * every pending call, so anything still queued here has already been
   * reported as failed and must not be replayed — otherwise a call the user
   * saw fail (and re-made) arrives twice on reconnect, and a channel like
   * `session:create` turns one confirmed intent into two sessions. Frames
   * queued AFTER a close belong to the next socket and still have a live
   * promise, so those flush as normal.
   */
  const outbox: string[] = []

  let identity: RemoteIdentity | null = null
  const identityWatchers = new Set<(identity: RemoteIdentity) => void>()

  function setState(next: ConnectionState): void {
    if (state === next) return
    state = next
    for (const fn of stateWatchers) fn(next)
  }

  function post(frame: object): void {
    const raw = JSON.stringify(frame)
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(raw)
    else outbox.push(raw)
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

  function connect(): void {
    setState('connecting')
    const socket = new WebSocket(socketUrl())
    ws = socket

    socket.addEventListener('open', () => {
      backoff = RECONNECT_MIN_MS
      setState('open')
      for (const raw of outbox.splice(0)) socket.send(raw)
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
      // The key belonged to THAT socket. Holding it would have the next
      // `pty:owner-changed` compared against an identity that no longer exists.
      identity = null
      setState('closed')
      // Every in-flight call dies with the socket. Leaving them pending would
      // hang whatever awaited them for the rest of the page's life.
      for (const [, waiting] of pending) waiting.reject(new Error('Connection lost'))
      pending.clear()
      // …and so does everything queued behind it, for the same reason: those
      // promises were just rejected, so replaying their frames on the next
      // socket would run a call the caller has already been told failed.
      outbox.length = 0
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
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
        post({ kind: 'invoke', id, channel, args })
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
  }
}
