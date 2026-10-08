import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { memoryViewStore, _resetMemoryViewForTests } from '../memoryView.svelte'
import { sessionsStore } from '../sessions.svelte'
import { fsNonceFor } from '../fsRefresh.svelte'
import type { MemoryLocation } from '../../../shared/ipc-types'

const DIR = '/home/u/.claude/projects/-ctl/memory'

type Listener = (data: unknown) => void
let listeners: Map<string, Listener[]>
let invoke: ReturnType<typeof vi.fn>
let location: MemoryLocation

function emit(channel: string, data: unknown): void {
  for (const fn of listeners.get(channel) ?? []) fn(data)
}

beforeEach(() => {
  listeners = new Map()
  location = { memoryDir: DIR, exists: true, git: null }
  invoke = vi.fn((channel: string) => {
    if (channel === 'memory:health') {
      return Promise.resolve({ memoryDir: DIR, indexPresent: true, fileCount: 1, issues: [] })
    }
    if (channel === 'memory:resolve') return Promise.resolve(location)
    return Promise.resolve(undefined)
  })
  vi.stubGlobal('api', {
    invoke,
    on: vi.fn((channel: string, cb: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), cb])
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((fn) => fn !== cb))
    }),
  })
  sessionsStore.reset()
})

afterEach(() => {
  _resetMemoryViewForTests()
  vi.unstubAllGlobals()
})

function calls(channel: string): number {
  return invoke.mock.calls.filter((c) => c[0] === channel).length
}

describe('memoryViewStore', () => {
  it('watches once per dir and unwatches with the last holder', () => {
    const a = memoryViewStore.acquire(DIR, '/ctl')
    const b = memoryViewStore.acquire(DIR, '/ctl')
    expect(calls('memory:watch')).toBe(1)
    a()
    expect(calls('memory:unwatch')).toBe(0)
    b()
    expect(calls('memory:unwatch')).toBe(1)
  })

  it('refreshes tree and health on a change, and re-resolves on a structural one', async () => {
    const id = sessionsStore.createAgent({ provider: 'claude' }, '/ctl', '/ctl/main')
    await sessionsStore.openMemoryView(id)
    const release = memoryViewStore.acquire(DIR, '/ctl')
    await vi.waitFor(() => expect(memoryViewStore.health(DIR)?.report).not.toBeNull())
    const before = fsNonceFor(`${DIR}/sub`)
    const healthCalls = calls('memory:health')

    emit('memory:changed', { memoryDir: DIR, dirs: [`${DIR}/sub`], structural: false })
    expect(fsNonceFor(`${DIR}/sub`)).toBe(before + 1)
    await vi.waitFor(() => expect(calls('memory:health')).toBe(healthCalls + 1))
    expect(calls('memory:resolve')).toBe(1)

    location = { memoryDir: DIR, exists: false, git: null }
    emit('memory:changed', { memoryDir: DIR, dirs: [], structural: true })
    await vi.waitFor(() => expect(sessionsStore.get(id)?.memoryView?.exists).toBe(false))
    release()
  })

  it('ignores changes for dirs nobody holds', () => {
    const release = memoryViewStore.acquire(DIR, '/ctl')
    const healthCalls = calls('memory:health')
    emit('memory:changed', { memoryDir: '/other', dirs: [], structural: true })
    expect(calls('memory:health')).toBe(healthCalls)
    expect(calls('memory:resolve')).toBe(0)
    release()
  })
})
