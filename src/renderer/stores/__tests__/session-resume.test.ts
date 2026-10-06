import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InteractiveTarget } from '../../../shared/ipc-types'
import { sessionsStore } from '../sessions.svelte'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let spawnBehaviour: (payload: unknown) => Promise<unknown>
let spawned: unknown[]

beforeEach(() => {
  spawned = []
  // Structured clone is what Electron IPC does to every argument; a $state
  // proxy makes it throw, exactly as the real `invoke` does.
  spawnBehaviour = (payload) => {
    spawned.push(structuredClone(payload))
    return Promise.resolve(undefined)
  }
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    invoke: vi.fn((channel: string, arg?: unknown) => {
      if (channel === 'agent:spawn') return spawnBehaviour(arg)
      return Promise.resolve(undefined)
    }),
    on: vi.fn(() => () => {}),
  }
  sessionsStore.reset()
})

function restore(target: InteractiveTarget): string {
  const id = sessionsStore.addRestoredSession({
    kind: 'agent',
    provider: target.provider,
    target,
    label: 'Restored',
    launchDir: '/repo',
    worktreePath: '/repo/main',
    sessionId: 'abc-123',
  })
  if (!id) throw new Error('restore returned no id')
  return id
}

describe('resumePlaceholder', () => {
  it('sends a cloneable payload that keeps a Claude session on its model', async () => {
    const model = { provider: 'ollama' as const, model: 'qwen3:32b', endpoint: 'http://box:11434' }
    const id = restore({ provider: 'claude', model })

    sessionsStore.resumePlaceholder(id)
    await flush()

    expect(spawned).toEqual([
      {
        id,
        worktreePath: '/repo',
        target: { provider: 'claude', model },
        resumeSessionId: 'abc-123',
        model,
      },
    ])
    const session = sessionsStore.get(id)!
    expect(session.pendingResume).toBeUndefined()
    expect(session.resumeError).toBeUndefined()
    expect(session.model).toEqual(model)
  })

  it.each([
    { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' },
    { provider: 'opencode', model: 'anthropic/claude-sonnet-5' },
  ] as InteractiveTarget[])('keeps a $provider session on its model through the target', async (target) => {
    const id = restore(target)

    sessionsStore.resumePlaceholder(id)
    await flush()

    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ target, resumeSessionId: 'abc-123' })
    expect(spawned[0]).not.toHaveProperty('model')
  })

  it('brings the Resume placeholder back with the error when the spawn throws', async () => {
    const id = restore({ provider: 'claude' })
    spawnBehaviour = () => {
      throw new Error('An object could not be cloned.')
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sessionsStore.resumePlaceholder(id)
    await flush()

    const session = sessionsStore.get(id)!
    expect(session.pendingResume).toEqual({ sessionId: 'abc-123' })
    expect(session.resumeError).toBe('An object could not be cloned.')
  })

  it('brings the Resume placeholder back when the spawn rejects, and a retry clears the error', async () => {
    const id = restore({ provider: 'claude' })
    spawnBehaviour = () => Promise.reject(new Error('main refused'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sessionsStore.resumePlaceholder(id)
    await flush()
    expect(sessionsStore.get(id)!.pendingResume).toEqual({ sessionId: 'abc-123' })
    expect(sessionsStore.get(id)!.resumeError).toBe('main refused')

    spawnBehaviour = () => Promise.resolve(undefined)
    sessionsStore.resumePlaceholder(id)
    await flush()
    expect(sessionsStore.get(id)!.pendingResume).toBeUndefined()
    expect(sessionsStore.get(id)!.resumeError).toBeUndefined()
  })
})
