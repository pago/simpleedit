import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'svelte'
import { memoryViewStore, _resetMemoryViewForTests } from '../memoryView.svelte'
import { sessionsStore } from '../sessions.svelte'
import type { MemoryLocation } from '../../../shared/ipc-types'

vi.mock('../../lib/memory-markers', () => ({
  setMemoryReport: vi.fn(),
  clearMemoryMarkers: vi.fn(),
}))
const markers = await import('../../lib/memory-markers')

const DIR = '/home/u/.claude/projects/-ctl/memory'

type Listener = (data: unknown) => void
let listeners: Map<string, Listener[]>
let invoke: ReturnType<typeof vi.fn>
let locations: Map<string, MemoryLocation>
let healthFails: boolean

function emit(channel: string, data: unknown): void {
  for (const fn of listeners.get(channel) ?? []) fn(data)
}

function calls(channel: string, arg?: string): number {
  return invoke.mock.calls.filter((c) => c[0] === channel && (arg === undefined || c[1] === arg)).length
}

beforeEach(() => {
  listeners = new Map()
  healthFails = false
  locations = new Map([
    ['/ctl', { memoryDir: DIR, exists: true, git: null }],
    ['/ctl/sub', { memoryDir: DIR, exists: true, git: null }],
  ])
  invoke = vi.fn((channel: string, arg: string) => {
    if (channel === 'memory:health') {
      return healthFails
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ memoryDir: DIR, indexPresent: true, fileCount: 1, issues: [] })
    }
    if (channel === 'memory:resolve') return Promise.resolve(locations.get(arg))
    if (channel === 'memory:watch') return Promise.resolve(true)
    return Promise.resolve(undefined)
  })
  vi.stubGlobal('api', {
    invoke,
    on: vi.fn((channel: string, cb: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), cb])
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((fn) => fn !== cb))
    }),
  })
  vi.mocked(markers.clearMemoryMarkers).mockClear()
  sessionsStore.reset()
})

afterEach(() => {
  _resetMemoryViewForTests()
  vi.unstubAllGlobals()
})

describe('memoryViewStore inside an effect', () => {
  it('acquires once — reading its own health state must not re-run the effect', async () => {
    const cleanup = $effect.root(() => {
      $effect(() => memoryViewStore.acquire(DIR, '/ctl'))
    })
    flushSync()
    await vi.waitFor(() => expect(memoryViewStore.health(DIR)?.report).not.toBeNull())
    flushSync()
    expect(calls('memory:watch')).toBe(1)
    expect(calls('memory:unwatch')).toBe(0)
    cleanup()
    expect(calls('memory:unwatch')).toBe(1)
  })
})

describe('memoryViewStore controller', () => {
  it('re-resolves every launch dir holding the memory dir', async () => {
    const a = sessionsStore.createAgent({ provider: 'claude' }, '/ctl', '/ctl')
    const b = sessionsStore.createAgent({ provider: 'claude' }, '/ctl/sub', '/ctl/sub')
    await sessionsStore.openMemoryView(a)
    await sessionsStore.openMemoryView(b)
    const releaseA = memoryViewStore.acquire(DIR, '/ctl')
    const releaseB = memoryViewStore.acquire(DIR, '/ctl/sub')

    locations.set('/ctl', { memoryDir: DIR, exists: false, git: null })
    locations.set('/ctl/sub', { memoryDir: DIR, exists: false, git: null })
    emit('memory:changed', { memoryDir: DIR, dirs: [], structural: true })
    await vi.waitFor(() => {
      expect(sessionsStore.get(a)?.memoryView?.exists).toBe(false)
      expect(sessionsStore.get(b)?.memoryView?.exists).toBe(false)
    })
    releaseA()
    releaseB()
  })

  it('stops re-resolving a launch dir once its last holder released', async () => {
    const releaseA = memoryViewStore.acquire(DIR, '/ctl')
    const releaseB = memoryViewStore.acquire(DIR, '/ctl/sub')
    releaseB()
    emit('memory:changed', { memoryDir: DIR, dirs: [], structural: true })
    await vi.waitFor(() => expect(calls('memory:resolve', '/ctl')).toBe(1))
    expect(calls('memory:resolve', '/ctl/sub')).toBe(0)
    releaseA()
  })

  it('re-watches a dir that was removed and is back by the time it re-resolves', async () => {
    const release = memoryViewStore.acquire(DIR, '/ctl')
    expect(calls('memory:watch')).toBe(1)

    emit('memory:changed', { memoryDir: DIR, dirs: [], structural: true })
    await vi.waitFor(() => expect(calls('memory:resolve')).toBe(1))
    await Promise.resolve()
    expect(calls('memory:watch')).toBe(1)

    emit('memory:changed', { memoryDir: DIR, dirs: [], structural: true, watchEnded: true })
    await vi.waitFor(() => expect(calls('memory:watch')).toBe(2))
    release()
    expect(calls('memory:unwatch')).toBe(1)
  })

  it('does not re-watch a removed dir that is still gone', async () => {
    const release = memoryViewStore.acquire(DIR, '/ctl')
    locations.set('/ctl', { memoryDir: DIR, exists: false, git: null })
    emit('memory:changed', { memoryDir: DIR, dirs: [], structural: true, watchEnded: true })
    await vi.waitFor(() => expect(calls('memory:resolve')).toBe(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(calls('memory:watch')).toBe(1)
    release()
  })

  it('clears markers when a health fetch fails', async () => {
    const release = memoryViewStore.acquire(DIR, '/ctl')
    await vi.waitFor(() => expect(memoryViewStore.health(DIR)?.report).not.toBeNull())
    healthFails = true
    await memoryViewStore.refresh(DIR)
    expect(memoryViewStore.health(DIR)).toMatchObject({ report: null, error: 'boom' })
    expect(markers.clearMemoryMarkers).toHaveBeenCalledWith(DIR)
    release()
  })
})
