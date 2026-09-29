import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { attachPty } from '../pty-attach'

/**
 * The byte arithmetic every terminal view depends on.
 *
 * A PTY outlives its views and a socket reconnects underneath them, so what
 * this module gets wrong shows up as a screen that is subtly false — a
 * duplicated block, or a hole with a half-written escape sequence in it. None
 * of that is visible from a passing UI test.
 */

type Listener = (data: unknown) => void

let listeners: Map<string, Listener[]>
let backlog: { data: string; start: number; end: number }
let backlogCalls: number
let resolveBacklog: (() => void) | null

function emit(channel: string, data: unknown): void {
  for (const fn of [...(listeners.get(channel) ?? [])]) fn(data)
}

/** Let the backlog promise and its `finally` run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  listeners = new Map()
  backlogCalls = 0
  resolveBacklog = null
  backlog = { data: '', start: 0, end: 0 }
  vi.stubGlobal('api', {
    on: (channel: string, cb: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), cb])
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((fn) => fn !== cb))
    },
    invoke: async (channel: string) => {
      if (channel !== 'pty:backlog') return undefined
      backlogCalls++
      if (resolveBacklog) await new Promise<void>((r) => { resolveBacklog = r })
      return backlog
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('attachPty', () => {
  it('replays the backlog before any live output', async () => {
    backlog = { data: 'hello', start: 0, end: 5 }
    const written: string[] = []
    attachPty('t1', { write: (d) => written.push(d) })
    await settle()
    expect(written).toEqual(['hello'])
  })

  // The PTY spawns before any view mounts, so live chunks can arrive while the
  // replay is still in flight. Writing them first would put the terminal's
  // history after its present.
  it('queues live output until the replay lands, then keeps byte order', async () => {
    resolveBacklog = () => {}
    backlog = { data: 'abc', start: 0, end: 3 }
    const written: string[] = []
    attachPty('t2', { write: (d) => written.push(d) })
    await settle()

    emit('pty:data', { id: 't2', data: 'def', offset: 3 })
    expect(written).toEqual([])

    resolveBacklog?.()
    await settle()
    expect(written.join('')).toBe('abcdef')
  })

  it('writes only the part of an overlapping chunk it has not seen', async () => {
    backlog = { data: 'abcdef', start: 0, end: 6 }
    const written: string[] = []
    attachPty('t3', { write: (d) => written.push(d) })
    await settle()

    // Overlaps the replay by three bytes, as a live chunk racing it does.
    emit('pty:data', { id: 't3', data: 'defghi', offset: 3 })
    expect(written.join('')).toBe('abcdefghi')
  })

  it('ignores a chunk entirely behind what it has rendered', async () => {
    backlog = { data: 'abcdef', start: 0, end: 6 }
    const written: string[] = []
    attachPty('t4', { write: (d) => written.push(d) })
    await settle()
    emit('pty:data', { id: 't4', data: 'cd', offset: 2 })
    expect(written.join('')).toBe('abcdef')
  })

  it('ignores output for another terminal', async () => {
    const written: string[] = []
    attachPty('mine', { write: (d) => written.push(d) })
    await settle()
    emit('pty:data', { id: 'theirs', data: 'nope', offset: 0 })
    expect(written).toEqual([])
  })

  // The gap is what makes a reconnect honest. The offsets still add up, so
  // nothing is written twice — but an escape sequence was cut in the missing
  // span and the screen after it can be wrong in ways no later output corrects.
  it('reports a gap when output was produced that it will never see', async () => {
    backlog = { data: 'abc', start: 0, end: 3 }
    const onGap = vi.fn()
    attachPty('t5', { write: () => {}, onGap })
    await settle()
    expect(onGap).not.toHaveBeenCalled()

    emit('pty:data', { id: 't5', data: 'xyz', offset: 500 })
    expect(onGap).toHaveBeenCalledTimes(1)
  })

  it('does not call a gap the first time it writes anything', async () => {
    // A terminal whose backlog has already been trimmed starts mid-stream.
    // There is no earlier state for it to be inconsistent with.
    backlog = { data: 'late', start: 900, end: 904 }
    const onGap = vi.fn()
    attachPty('t6', { write: () => {}, onGap })
    await settle()
    expect(onGap).not.toHaveBeenCalled()
  })

  it('does not call a gap for contiguous output', async () => {
    backlog = { data: 'abc', start: 0, end: 3 }
    const onGap = vi.fn()
    attachPty('t7', { write: () => {}, onGap })
    await settle()
    emit('pty:data', { id: 't7', data: 'def', offset: 3 })
    expect(onGap).not.toHaveBeenCalled()
  })

  it('re-reads the backlog on resync and writes only what it missed', async () => {
    backlog = { data: 'abc', start: 0, end: 3 }
    const written: string[] = []
    const attachment = attachPty('t8', { write: (d) => written.push(d) })
    await settle()

    // What main holds after the socket was down.
    backlog = { data: 'abcdef', start: 0, end: 6 }
    attachment.resync()
    await settle()

    expect(written.join('')).toBe('abcdef')
    expect(backlogCalls).toBe(2)
  })

  it('reports the exit code without calling it an ownership change', async () => {
    const onExit = vi.fn()
    const onOwnerChange = vi.fn()
    attachPty('t9', { write: () => {}, onExit, onOwnerChange })
    await settle()

    emit('pty:exit', { id: 't9', exitCode: 1 })

    expect(onExit).toHaveBeenCalledWith(1)
    // A dead terminal needs no size. `onOwnerChange(null)` means the owner went
    // away and the PTY still needs sizing, so a view acting on it here would
    // fit and claim a terminal that no longer exists.
    expect(onOwnerChange).not.toHaveBeenCalled()
  })

  it('passes an ownership change through as main sent it', async () => {
    const onOwnerChange = vi.fn()
    attachPty('t10', { write: () => {}, onOwnerChange })
    await settle()

    emit('pty:owner-changed', { id: 't10', owner: 'w1.2' })
    emit('pty:owner-changed', { id: 't10', owner: null })

    expect(onOwnerChange.mock.calls).toEqual([['w1.2'], [null]])
  })

  it('goes silent once disposed', async () => {
    const written: string[] = []
    const onExit = vi.fn()
    const attachment = attachPty('t11', { write: (d) => written.push(d), onExit })
    await settle()

    attachment.dispose()
    emit('pty:data', { id: 't11', data: 'after', offset: 0 })
    emit('pty:exit', { id: 't11', exitCode: 0 })
    attachment.resync()
    await settle()

    expect(written).toEqual([])
    expect(onExit).not.toHaveBeenCalled()
    expect(backlogCalls).toBe(1)
  })

  it('renders live output when the backlog cannot be read', async () => {
    vi.stubGlobal('api', {
      on: (channel: string, cb: Listener) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), cb])
        return () => {}
      },
      invoke: async () => { throw new Error('no backlog') },
    })
    const written: string[] = []
    attachPty('t12', { write: (d) => written.push(d) })
    await settle()

    emit('pty:data', { id: 't12', data: 'live', offset: 0 })
    expect(written).toEqual(['live'])
  })
})
