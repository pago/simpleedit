import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { checkKeyWithServer, installRemoteApi, NotSentError } from '../api-shim'

/**
 * The shim's queue, which is a correctness surface and not a convenience.
 *
 * A frame and the promise waiting on it have to share one fate. When they
 * don't, a call the caller was told had FAILED is replayed on the next socket
 * — and the caller, believing it failed, has already made it again. For
 * `session:create` that is two agents where the user confirmed one.
 */

class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1
  readyState = 0
  readonly sent: string[] = []
  private handlers = new Map<string, ((event: unknown) => void)[]>()

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(raw: string): void {
    this.sent.push(raw)
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn])
  }

  private fire(type: string, event: unknown = {}): void {
    for (const fn of this.handlers.get(type) ?? []) fn(event)
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.fire('open')
  }

  /** The server started a close: `readyState` moves first, the event follows. */
  beginClose(): void {
    this.readyState = 2
  }

  close(): void {
    this.readyState = 3
    this.fire('close')
  }

  deliver(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) })
  }
}

const KEY = 'a'.repeat(64)
const OPTIONS = { key: KEY, checkKey: async () => 'unknown' as const }

const RealWebSocket = globalThis.WebSocket

beforeEach(() => {
  FakeSocket.instances = []
  vi.useFakeTimers()
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
})

afterEach(() => {
  vi.useRealTimers()
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = RealWebSocket
})

/** Frames the socket carried, parsed, ignoring anything that is not an invoke. */
function invokes(socket: FakeSocket): { channel: string; args: unknown[] }[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as { kind: string; channel: string; args: unknown[] })
    .filter((frame) => frame.kind === 'invoke')
}

describe('api-shim outbox', () => {
  it('flushes a call made before the first open', async () => {
    installRemoteApi(OPTIONS)
    const first = FakeSocket.instances[0]

    const call = window.api.invoke('session:list')
    expect(first.sent).toHaveLength(0)

    first.open()
    expect(invokes(first).map((f) => f.channel)).toEqual(['session:list'])

    const frame = JSON.parse(first.sent[0]) as { id: number }
    first.deliver({ kind: 'result', id: frame.id, ok: true, value: [] })
    await expect(call).resolves.toEqual([])
  })

  it('does not replay a queued call whose promise it already rejected', async () => {
    installRemoteApi(OPTIONS)
    const first = FakeSocket.instances[0]

    // Queued while the socket is still connecting, then the connection fails.
    const call = window.api.invoke('session:create', {
      requestId: 'r1',
      brief: 'refill the fleet',
    })
    first.close()
    // Rejected as NEVER SENT rather than merely lost: this frame was still in
    // the outbox, so nothing reached the Mac and the caller is free to retry
    // without checking what happened first.
    await expect(call).rejects.toBeInstanceOf(NotSentError)

    // The caller saw a failure and re-made the call, as any honest retry does.
    vi.advanceTimersByTime(1000)
    const second = FakeSocket.instances[1]
    expect(second).toBeDefined()
    const retry = window.api.invoke('session:create', {
      requestId: 'r1',
      brief: 'refill the fleet',
    })
    second.open()

    // Exactly one `session:create` reaches the Mac: the retry. The abandoned
    // frame must not have ridden along on the new socket.
    expect(invokes(second).filter((f) => f.channel === 'session:create')).toHaveLength(1)

    const frame = JSON.parse(second.sent[0]) as { id: number }
    second.deliver({
      kind: 'result',
      id: frame.id,
      ok: true,
      value: { terminalId: 't1', label: 'refill the fleet' },
    })
    await expect(retry).resolves.toMatchObject({ terminalId: 't1' })
  })

  it('never replays a submit written while the socket was closing', async () => {
    // `readyState` reaches CLOSING a round trip before the `close` EVENT fires,
    // so no guard built on the observable connection state can cover this: the
    // frame is buffered, the close then rejects its promise, and the next
    // socket would carry it. For `screenprs:submit-review` that is a review
    // posted after the user was told it might not have been.
    installRemoteApi(OPTIONS)
    const first = FakeSocket.instances[0]
    first.open()

    first.beginClose()
    const posted = window.api.invoke('screenprs:submit-review', {
      pr: { owner: 'acme', repo: 'acme/widgets', number: 7, url: 'u' },
      draft: { comments: [], summary: '', verdict: 'approve' },
    })
    const settled = posted.then(() => 'resolved').catch(() => 'rejected')

    first.close()
    expect(await settled).toBe('rejected')
    expect(invokes(first)).toHaveLength(0)

    vi.advanceTimersByTime(1000)
    const second = FakeSocket.instances[1]
    second.open()
    expect(invokes(second)).toHaveLength(0)
  })

  it('says a call never left when it never left, and stays silent when it might have', async () => {
    // The difference decides what the user is told about an irreversible write:
    // a call that was never sent had no effect, while one that was sent and
    // never answered may have had every effect it asked for. Only the first is
    // safe to retry without checking GitHub first.
    installRemoteApi(OPTIONS)
    const first = FakeSocket.instances[0]
    first.open()

    const sent = window.api.invoke('session:list')
    first.beginClose()
    const held = window.api.invoke('session:list')
    first.close()

    await expect(sent).rejects.not.toBeInstanceOf(NotSentError)
    await expect(held).rejects.toBeInstanceOf(NotSentError)
    // By name, too: the draft store tells a lost connection from a refusal
    // without importing this module.
    await expect(sent).rejects.toMatchObject({ name: 'ConnectionLostError' })
    await expect(held).rejects.toMatchObject({ name: 'NotSentError' })
  })

  it('still delivers a call made while waiting for the reconnect', async () => {
    installRemoteApi(OPTIONS)
    const first = FakeSocket.instances[0]
    first.open()
    first.close()

    // No socket exists yet — this is the gap the outbox is FOR, and the frame
    // here has a live promise, so it must survive to the next open.
    const call = window.api.invoke('session:list')
    vi.advanceTimersByTime(1000)
    const second = FakeSocket.instances[1]
    second.open()

    expect(invokes(second).map((f) => f.channel)).toEqual(['session:list'])
    const frame = JSON.parse(second.sent[0]) as { id: number }
    second.deliver({ kind: 'result', id: frame.id, ok: true, value: [] })
    await expect(call).resolves.toEqual([])
  })
})

describe('api-shim reconnect', () => {
  it('names the remembered project on every socket it opens', () => {
    let params: Record<string, string> = { repo: '/p/a.git', window: '1' }
    const connection = installRemoteApi({ ...OPTIONS, attachParams: () => params })
    const first = FakeSocket.instances[0]
    expect(new URL(first.url).searchParams.get('repo')).toBe('/p/a.git')
    expect(new URL(first.url).searchParams.get('window')).toBe('1')
    first.open()

    params = { repo: '/p/b.git', window: '2' }
    connection.reconnect()
    const second = FakeSocket.instances[1]
    expect(first.readyState).toBe(3)
    expect(new URL(second.url).searchParams.get('repo')).toBe('/p/b.git')
    // The project pick and the key travel side by side; neither replaces the other.
    expect(new URL(second.url).searchParams.get('k')).toBe(KEY)
  })

  it('never lets an attach parameter stand in for the key', () => {
    installRemoteApi({ ...OPTIONS, attachParams: () => ({ k: 'f'.repeat(64), window: '3' }) })
    const url = new URL(FakeSocket.instances[0].url)
    expect(url.searchParams.getAll('k')).toEqual([KEY])
    expect(url.searchParams.get('window')).toBe('3')
  })

  // The refused socket's key check is still in flight when the reconnect
  // opens a new one; its answer must not schedule a second socket.
  it('drops the key check of a socket a reconnect replaced', async () => {
    let answer: (verdict: 'unknown') => void = () => {}
    const connection = installRemoteApi({ key: KEY, checkKey: () => new Promise((resolve) => { answer = resolve }) })
    FakeSocket.instances[0].close()
    connection.reconnect()
    expect(FakeSocket.instances).toHaveLength(2)
    answer('unknown')
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('does nothing while the key is out of date — only a new key helps', async () => {
    const connection = installRemoteApi({ key: KEY, checkKey: async () => 'stale' })
    FakeSocket.instances[0].close()
    await vi.waitFor(() => expect(connection.state()).toBe('stale'))
    connection.reconnect()
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('connects again at once, not after the backoff', () => {
    const connection = installRemoteApi(OPTIONS)
    FakeSocket.instances[0].open()
    connection.reconnect()
    expect(FakeSocket.instances).toHaveLength(2)
  })

  // A reconnect during a backoff brings the retry forward. Leaving its timer
  // armed would open a second socket later, attached to a window of its own.
  it('opens exactly one socket when asked during a backoff', () => {
    const connection = installRemoteApi(OPTIONS)
    FakeSocket.instances[0].close()
    connection.reconnect()
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('fails the calls the old socket carried, as for any lost connection', async () => {
    const connection = installRemoteApi(OPTIONS)
    FakeSocket.instances[0].open()
    const call = (globalThis as unknown as { api: { invoke: (c: string) => Promise<unknown> } }).api.invoke('session:list')
    connection.reconnect()
    await expect(call).rejects.toThrow('Connection lost')
  })
})

describe('api-shim key', () => {
  it('carries the key on the socket URL, not in the page path', () => {
    installRemoteApi(OPTIONS)
    const url = new URL(FakeSocket.instances[0].url)
    expect(url.pathname.endsWith('/ws')).toBe(true)
    expect(url.searchParams.get('k')).toBe(KEY)
  })

  it('does not try to connect with no key at all', () => {
    const connection = installRemoteApi({ key: null, checkKey: async () => 'unknown' })
    expect(FakeSocket.instances).toHaveLength(0)
    expect(connection.state()).toBe('unpaired')
  })

  // A refused upgrade and an unreachable Mac look identical to a browser.
  // Only the server can say which, and only one of them is fixed by a rescan.
  it('stops retrying once the server says the key is out of date', async () => {
    const asked: string[] = []
    const connection = installRemoteApi({ key: KEY, checkKey: async (k) => { asked.push(k); return 'stale' } })
    FakeSocket.instances[0].close()
    await vi.waitFor(() => expect(connection.state()).toBe('stale'))
    expect(asked).toEqual([KEY])
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('keeps retrying while the Mac is merely unreachable', async () => {
    installRemoteApi({ key: KEY, checkKey: async () => 'unknown' })
    FakeSocket.instances[0].close()
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('reconnects on a new key at once, without a reload', async () => {
    const connection = installRemoteApi({ key: KEY, checkKey: async () => 'stale' })
    FakeSocket.instances[0].close()
    await vi.waitFor(() => expect(connection.state()).toBe('stale'))

    const fresh = 'b'.repeat(64)
    connection.setKey(fresh)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(new URL(FakeSocket.instances[1].url).searchParams.get('k')).toBe(fresh)
    FakeSocket.instances[1].open()
    expect(connection.state()).toBe('open')
  })

  // The verdict about the OLD key can arrive after the user has already
  // scanned a new one; acting on it would throw them back to the stale page.
  it('ignores a verdict about a key it has since replaced', async () => {
    let answer: (verdict: 'stale') => void = () => {}
    const connection = installRemoteApi({
      key: KEY,
      checkKey: () => new Promise((resolve) => { answer = resolve }),
    })
    FakeSocket.instances[0].close()
    connection.setKey('b'.repeat(64))
    FakeSocket.instances[1].open()
    answer('stale')
    await Promise.resolve()
    await Promise.resolve()
    expect(connection.state()).toBe('open')
  })

  it('fails the calls of the socket a new key replaces', async () => {
    const connection = installRemoteApi(OPTIONS)
    FakeSocket.instances[0].open()
    const call = window.api.invoke('session:list')
    connection.setKey('b'.repeat(64))
    await expect(call).rejects.toThrow('Connection lost')
  })
})

describe('api-shim while out of date', () => {
  // Held, these would be flushed onto the socket a rescan opens minutes later:
  // a keystroke typed at the stale page arriving in an agent's PTY.
  it('fails calls at once instead of holding them for a key that may never come', async () => {
    const connection = installRemoteApi({ key: KEY, checkKey: async () => 'stale' })
    const early = window.api.invoke('session:list')
    FakeSocket.instances[0].close()
    await expect(early).rejects.toBeInstanceOf(NotSentError)
    await vi.waitFor(() => expect(connection.state()).toBe('stale'))

    const late = window.api.invoke('session:list')
    await expect(late).rejects.toBeInstanceOf(NotSentError)
    window.api.send('lsp:send', {} as never)

    connection.setKey('b'.repeat(64))
    FakeSocket.instances[1].open()
    expect(FakeSocket.instances[1].sent).toEqual([])
  })

  it('fails calls made with no key at all', async () => {
    installRemoteApi({ key: null, checkKey: async () => 'unknown' })
    await expect(window.api.invoke('session:list')).rejects.toBeInstanceOf(NotSentError)
  })
})

describe('checkKeyWithServer', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reads 204 as current and 401 as stale', async () => {
    vi.useRealTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await checkKeyWithServer(KEY)).toBe('current')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
    expect(await checkKeyWithServer(KEY)).toBe('stale')
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/auth?k=${KEY}`)
  })

  // On a dead tailnet path the fetch can hang for minutes, and the shim only
  // schedules its next attempt once this answers.
  it('gives up after its timeout and answers unknown', async () => {
    vi.useRealTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    expect(await checkKeyWithServer(KEY, 20)).toBe('unknown')
  })
})
