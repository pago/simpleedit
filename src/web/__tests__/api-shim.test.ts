import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRemoteApi, NotSentError } from '../api-shim'

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
    installRemoteApi()
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
    installRemoteApi()
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
    installRemoteApi()
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
    installRemoteApi()
    const first = FakeSocket.instances[0]
    first.open()

    const sent = window.api.invoke('session:list')
    first.beginClose()
    const held = window.api.invoke('session:list')
    first.close()

    await expect(sent).rejects.not.toBeInstanceOf(NotSentError)
    await expect(held).rejects.toBeInstanceOf(NotSentError)
  })

  it('still delivers a call made while waiting for the reconnect', async () => {
    installRemoteApi()
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
