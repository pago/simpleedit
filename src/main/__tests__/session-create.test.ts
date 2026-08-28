import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createSessionOnce,
  resolveSessionCreate,
  resetSessionCreate,
  CREATE_ANSWER_TIMEOUT_MS,
} from '../session-create'

/**
 * One confirmed intent, one session.
 *
 * These tests are about the three ways a single tap becomes two agents, none
 * of which the client can see: a double tap, a socket that drops after the
 * request was handled but before its answer arrived, and a frame replayed by
 * a transport that reconnected. All three arrive here as a second call
 * carrying the same `requestId`.
 */

/** A renderer that records what it was asked and answers when told to. */
function fakeRenderer() {
  const asks: { correlationId: string; brief: string; label?: string }[] = []
  return {
    asks,
    destroyed: false,
    send(channel: string, data: unknown): void {
      if (channel !== 'session:create-request') return
      asks.push(data as { correlationId: string; brief: string })
    },
    isDestroyed(): boolean {
      return this.destroyed
    },
    /** Answer the nth request the way a renderer that created a session would. */
    created(index: number, terminalId: string): void {
      resolveSessionCreate(asks[index].correlationId, {
        ok: true,
        terminalId,
        label: 'Refill the fleet',
      })
    },
    refused(index: number, reason: string): void {
      resolveSessionCreate(asks[index].correlationId, { ok: false, reason })
    },
  }
}

beforeEach(() => {
  resetSessionCreate()
})

afterEach(() => {
  vi.useRealTimers()
  resetSessionCreate()
})

describe('createSessionOnce', () => {
  it('asks the renderer once and returns what it made', async () => {
    const renderer = fakeRenderer()
    const call = createSessionOnce(
      { requestId: 'intent-1', brief: 'Refill the fleet, start with the flaky watcher test' },
      renderer,
    )
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    renderer.created(0, 'agent-claude-1')
    await expect(call).resolves.toEqual({ terminalId: 'agent-claude-1', label: 'Refill the fleet' })
  })

  it('derives the label from the brief so both ends agree on the name', async () => {
    const renderer = fakeRenderer()
    const call = createSessionOnce(
      { requestId: 'intent-label', brief: 'Refill the fleet. Then tell me.' },
      renderer,
    )
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    expect(renderer.asks[0].label).toBe('Refill the fleet')
    renderer.created(0, 'agent-claude-1')
    await call
  })

  it('joins a second call that lands while the first is still in flight', async () => {
    const renderer = fakeRenderer()
    const first = createSessionOnce({ requestId: 'intent-1', brief: 'do the thing' }, renderer)
    const second = createSessionOnce({ requestId: 'intent-1', brief: 'do the thing' }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    renderer.created(0, 'agent-claude-1')

    // A double tap: one ask, and both callers hold the same session.
    expect(renderer.asks).toHaveLength(1)
    expect(await first).toEqual(await second)
  })

  it('replays the answer rather than the spawn when the intent comes back', async () => {
    const renderer = fakeRenderer()
    const first = createSessionOnce({ requestId: 'intent-1', brief: 'do the thing' }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    renderer.created(0, 'agent-claude-1')
    await first

    // The socket dropped before the answer reached the phone, so the phone
    // re-sent the SAME intent. It must get the session it already has.
    const retry = await createSessionOnce(
      { requestId: 'intent-1', brief: 'do the thing' },
      renderer,
    )
    expect(retry.terminalId).toBe('agent-claude-1')
    expect(renderer.asks).toHaveLength(1)
  })

  it('lets a different intent through', async () => {
    const renderer = fakeRenderer()
    const a = createSessionOnce({ requestId: 'intent-1', brief: 'one' }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    renderer.created(0, 'agent-1')
    await a

    const b = createSessionOnce({ requestId: 'intent-2', brief: 'two' }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(2))
    renderer.created(1, 'agent-2')
    expect((await b).terminalId).toBe('agent-2')
  })

  it('lets the user try again after the renderer refused', async () => {
    const renderer = fakeRenderer()
    const first = createSessionOnce({ requestId: 'intent-1', brief: 'do the thing' }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    renderer.refused(0, 'No repo is open in that window.')
    await expect(first).rejects.toThrow('No repo is open in that window.')

    // Nothing was created, so the same intent is allowed a second attempt.
    const retry = createSessionOnce({ requestId: 'intent-1', brief: 'do the thing' }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(2))
    renderer.created(1, 'agent-claude-1')
    expect((await retry).terminalId).toBe('agent-claude-1')
  })

  it('never re-spawns an intent whose outcome nobody witnessed', async () => {
    vi.useFakeTimers()
    const renderer = fakeRenderer()
    const first = createSessionOnce({ requestId: 'intent-1', brief: 'do the thing' }, renderer)
    // Asserted before the clock moves: attaching the handler afterwards leaves
    // the rejection unhandled for a turn, which vitest reports as an error.
    const firstSettled = expect(first).rejects.toThrow(/did not confirm/)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))

    // The renderer never answered. The request WAS delivered, so a session may
    // well exist — retrying into a second one is the loss this guards against.
    await vi.advanceTimersByTimeAsync(CREATE_ANSWER_TIMEOUT_MS + 10)
    await firstSettled

    await expect(
      createSessionOnce({ requestId: 'intent-1', brief: 'do the thing' }, renderer),
    ).rejects.toThrow(/did not confirm/)
    expect(renderer.asks).toHaveLength(1)
  })

  it('refuses an empty brief without troubling the renderer', async () => {
    const renderer = fakeRenderer()
    await expect(
      createSessionOnce({ requestId: 'intent-1', brief: '   ' }, renderer),
    ).rejects.toThrow(/needs a brief/)
    expect(renderer.asks).toHaveLength(0)
  })

  it('bounds a brief arriving from a socket', async () => {
    const renderer = fakeRenderer()
    await expect(
      createSessionOnce({ requestId: 'intent-1', brief: 'x'.repeat(9000) }, renderer),
    ).rejects.toThrow(/the limit is/)
    expect(renderer.asks).toHaveLength(0)
  })

  it('refuses when the window has gone', async () => {
    const renderer = fakeRenderer()
    renderer.destroyed = true
    await expect(
      createSessionOnce({ requestId: 'intent-1', brief: 'do the thing' }, renderer),
    ).rejects.toThrow(/window is gone/)
  })

  it('requires a requestId, because without one nothing can be de-duplicated', async () => {
    const renderer = fakeRenderer()
    await expect(
      createSessionOnce({ requestId: '  ', brief: 'do the thing' }, renderer),
    ).rejects.toThrow(/requestId/)
    expect(renderer.asks).toHaveLength(0)
  })

  it('ignores an answer that arrives after the waiter gave up', async () => {
    vi.useFakeTimers()
    const renderer = fakeRenderer()
    const call = createSessionOnce({ requestId: 'intent-1', brief: 'do the thing' }, renderer)
    const settled = expect(call).rejects.toThrow(/did not confirm/)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(CREATE_ANSWER_TIMEOUT_MS + 10)
    await settled

    // A late answer must not resurrect a settled call or throw.
    expect(() => renderer.created(0, 'agent-claude-1')).not.toThrow()
  })
})
