import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createSessionOnce,
  resolveSessionCreate,
  resetSessionCreate,
  CREATE_ANSWER_TIMEOUT_MS,
  parseCreateTarget,
  parseCreateLabel,
  unknownModelReason,
  type ModelCatalog,
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
  const asks: { correlationId: string; brief: string; label?: string; labelFixed?: boolean; target?: unknown }[] = []
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
      createSessionOnce({ requestId: 'intent-1', brief: 'x'.repeat(33_000) }, renderer),
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

describe('a picked agent and name', () => {
  it('passes a validated target and a fixed label to the renderer', async () => {
    const renderer = fakeRenderer()
    const call = createSessionOnce(
      {
        requestId: 'intent-discuss',
        brief: 'You are helping me review a GitHub pull request.',
        target: { provider: 'claude', model: { provider: 'anthropic', model: 'sonnet' } },
        label: 'review acme/app#7',
      },
      renderer,
    )
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    expect(renderer.asks[0]).toMatchObject({
      label: 'review acme/app#7',
      labelFixed: true,
      target: { provider: 'claude', model: { provider: 'anthropic', model: 'sonnet' } },
    })
    renderer.created(0, 'agent-claude-1')
    await call
  })

  it('still creates once per intent with a target', async () => {
    const renderer = fakeRenderer()
    const request = { requestId: 'intent-t', brief: 'review it', target: { provider: 'codex' as const, model: 'gpt-5.5' } }
    const first = createSessionOnce(request, renderer)
    const second = createSessionOnce(request, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    renderer.created(0, 'agent-codex-1')
    expect(await first).toEqual(await second)
    expect(renderer.asks).toHaveLength(1)
  })

  it('refuses a bad target before asking, and lets the intent be retried', async () => {
    const renderer = fakeRenderer()
    await expect(
      createSessionOnce({ requestId: 'intent-bad', brief: 'review it', target: { provider: 'bash' } as never }, renderer),
    ).rejects.toThrow(/can't start that agent/)
    expect(renderer.asks).toHaveLength(0)
    const retry = createSessionOnce({ requestId: 'intent-bad', brief: 'review it' }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    renderer.created(0, 'agent-claude-1')
    await expect(retry).resolves.toMatchObject({ terminalId: 'agent-claude-1' })
  })
})

describe('parseCreateTarget', () => {
  it('rebuilds a Claude target from known fields, dropping an endpoint', () => {
    expect(
      parseCreateTarget({ provider: 'claude', model: { provider: 'ollama', model: 'qwen3:8b', endpoint: 'http://evil' }, extra: 1 }),
    ).toEqual({ provider: 'claude', model: { provider: 'ollama', model: 'qwen3:8b' } })
    expect(parseCreateTarget({ provider: 'claude' })).toEqual({ provider: 'claude' })
  })

  it('keeps a native target and its effort', () => {
    expect(parseCreateTarget({ provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' })).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    })
    expect(parseCreateTarget({ provider: 'opencode', model: 'opencode/deepseek-v4-flash-free' })).toEqual({
      provider: 'opencode',
      model: 'opencode/deepseek-v4-flash-free',
    })
  })

  it.each([
    [{ provider: 'claude', model: { provider: 'openai', model: 'gpt-5.5' } }, /can't run that model/],
    [{ provider: 'claude', model: { provider: 'anthropic' } }, /has no id/],
    [{ provider: 'codex', model: '--dangerously-bypass' }, /isn't a model id/],
    [{ provider: 'codex', model: 'gpt 5' }, /isn't a model id/],
    [{ provider: 'codex', reasoningEffort: 'extreme' }, /reasoning effort/],
    [null, /must be an object/],
  ])('refuses %j', (raw, reason) => {
    expect(() => parseCreateTarget(raw)).toThrow(reason)
  })
})

describe('parseCreateLabel', () => {
  it('keeps one line, bounded', () => {
    expect(parseCreateLabel('  review\n acme#7 ')).toBe('review acme#7')
    expect(parseCreateLabel(undefined)).toBeUndefined()
    expect(parseCreateLabel('   ')).toBeUndefined()
    expect(() => parseCreateLabel('x'.repeat(121))).toThrow(/limit/)
    expect(() => parseCreateLabel(7)).toThrow()
  })
})

describe('a reused requestId', () => {
  const sonnet = { provider: 'claude' as const, model: { provider: 'anthropic' as const, model: 'sonnet' } }
  const codex = { provider: 'codex' as const, model: 'gpt-5.5' }

  it('is refused with a different target while the first is in flight', async () => {
    const renderer = fakeRenderer()
    const first = createSessionOnce({ requestId: 'intent-r', brief: 'review it', target: sonnet }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    await expect(
      createSessionOnce({ requestId: 'intent-r', brief: 'review it', target: codex }, renderer),
    ).rejects.toThrow(/already used to start a different session/)
    renderer.created(0, 'agent-claude-1')
    await expect(first).resolves.toMatchObject({ terminalId: 'agent-claude-1' })
    expect(renderer.asks).toHaveLength(1)
  })

  it('is refused with a different target after the first succeeded', async () => {
    const renderer = fakeRenderer()
    const first = createSessionOnce({ requestId: 'intent-s', brief: 'review it', target: sonnet }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    renderer.created(0, 'agent-claude-1')
    await first
    await expect(
      createSessionOnce({ requestId: 'intent-s', brief: 'review it', target: codex }, renderer),
    ).rejects.toThrow(/different session/)
    await expect(
      createSessionOnce({ requestId: 'intent-s', brief: 'review it', label: 'another name', target: sonnet }, renderer),
    ).rejects.toThrow(/different session/)
    expect(renderer.asks).toHaveLength(1)
  })

  it('still answers the same request, whatever its key order or surrounding whitespace', async () => {
    const renderer = fakeRenderer()
    const first = createSessionOnce({ requestId: 'intent-k', brief: 'review it', target: sonnet }, renderer)
    await vi.waitFor(() => expect(renderer.asks).toHaveLength(1))
    renderer.created(0, 'agent-claude-1')
    await first
    const reordered = { model: { model: 'sonnet', provider: 'anthropic' as const }, provider: 'claude' as const }
    await expect(
      createSessionOnce({ target: reordered, brief: ' review it ', requestId: 'intent-k' }, renderer),
    ).resolves.toMatchObject({ terminalId: 'agent-claude-1' })
  })
})

describe('models a remote client names', () => {
  const catalog: ModelCatalog = {
    claude: async () => ['opus', 'sonnet'],
    codex: async () => ['gpt-5.5'],
    opencode: async () => ['opencode/big-pickle'],
    ollama: async () => ['qwen3:8b'],
  }

  it('accepts what the picker offers, including each agent\'s own default', async () => {
    expect(await unknownModelReason({ provider: 'claude', model: { provider: 'anthropic', model: 'sonnet' } }, catalog)).toBeNull()
    expect(await unknownModelReason({ provider: 'claude', model: { provider: 'ollama', model: 'qwen3:8b' } }, catalog)).toBeNull()
    expect(await unknownModelReason({ provider: 'claude' }, catalog)).toBeNull()
    expect(await unknownModelReason({ provider: 'codex', model: 'gpt-5.5' }, catalog)).toBeNull()
    expect(await unknownModelReason({ provider: 'codex' }, catalog)).toBeNull()
    expect(await unknownModelReason({ provider: 'opencode', model: 'opencode/big-pickle' }, catalog)).toBeNull()
    expect(await unknownModelReason({ provider: 'opencode' }, catalog)).toBeNull()
  })

  it('refuses a model that is not there, saying which', async () => {
    expect(await unknownModelReason({ provider: 'claude', model: { provider: 'anthropic', model: 'claude-9' } }, catalog)).toMatch(/doesn't offer the model “claude-9”/)
    expect(await unknownModelReason({ provider: 'claude', model: { provider: 'ollama', model: 'llama9' } }, catalog)).toMatch(/isn't an installed local model/)
    expect(await unknownModelReason({ provider: 'codex', model: 'gpt-0' }, catalog)).toMatch(/Codex doesn't offer/)
    expect(await unknownModelReason({ provider: 'opencode', model: 'opencode/x' }, catalog)).toMatch(/OpenCode doesn't offer the model “opencode\/x”/)
  })

  it('refuses before asking the renderer, and the reason reaches the caller', async () => {
    const renderer = fakeRenderer()
    await expect(
      createSessionOnce(
        { requestId: 'intent-m', brief: 'review it', target: { provider: 'codex', model: 'gpt-0' } },
        renderer,
        catalog,
      ),
    ).rejects.toThrow(/Codex doesn't offer the model “gpt-0”/)
    expect(renderer.asks).toHaveLength(0)
  })
})
