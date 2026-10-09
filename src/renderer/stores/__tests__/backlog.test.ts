import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { backlogStore, initBacklogListeners, _resetBacklogForTests } from '../backlog.svelte'
import type { BacklogItem, BacklogSnapshot } from '../../../shared/backlog'
import { SESSION_CREATE_UNWITNESSED } from '../../../shared/ipc-types'

const P = '/repo/project.git'
let changed: ((s: BacklogSnapshot) => void) | undefined
let loadResult: BacklogSnapshot
let invoke: ReturnType<typeof vi.fn>
let dispose: () => void

function item(id: string, over: Partial<BacklogItem> = {}): BacklogItem {
  return { id, prompt: `do ${id}`, version: 1, createdAt: 'a', updatedAt: 'a', createdBy: 'desktop', ...over }
}

beforeEach(async () => {
  _resetBacklogForTests()
  changed = undefined
  loadResult = { project: P, items: [item('b_aaaaaaaa')], rev: 10 }
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'backlog:load') return loadResult
    return undefined
  })
  vi.stubGlobal('api', {
    on: (channel: string, cb: (s: BacklogSnapshot) => void) => {
      if (channel === 'backlog:changed') changed = cb
      return () => (changed = undefined)
    },
    once: vi.fn(),
    invoke,
  })
  dispose = initBacklogListeners()
  void backlogStore.load()
  await vi.waitFor(() => expect(backlogStore.items).toHaveLength(1))
})

afterEach(() => {
  dispose()
  vi.unstubAllGlobals()
})

describe('backlog mirror', () => {
  it("takes newer snapshots of its own project only", () => {
    changed!({ project: '/repo/other.git', items: [], rev: 50 })
    expect(backlogStore.items).toHaveLength(1)
    changed!({ project: P, items: [], rev: 9 })
    expect(backlogStore.items).toHaveLength(1)
    changed!({ project: P, items: [item('b_aaaaaaaa'), item('b_bbbbbbbb')], rev: 11 })
    expect(backlogStore.items.map((i) => i.id)).toEqual(['b_aaaaaaaa', 'b_bbbbbbbb'])
  })

  it('collects items an agent added, but not those already there or added here', () => {
    changed!({
      project: P,
      items: [item('b_aaaaaaaa', { createdBy: 'agent' }), item('b_bbbbbbbb', { createdBy: 'agent' }), item('b_cccccccc')],
      rev: 11,
    })
    expect(backlogStore.arrivals.map((i) => i.id)).toEqual(['b_bbbbbbbb'])
    backlogStore.dismissArrival('b_bbbbbbbb')
    expect(backlogStore.arrivals).toEqual([])
  })

  it('ignores broadcasts until a load has named its project', () => {
    _resetBacklogForTests()
    changed!({ project: '/repo/other.git', items: [item('b_zzzzzzzz')], rev: 99 })
    expect(backlogStore.items).toEqual([])
  })

  it('switches project on load', async () => {
    loadResult = { project: '/repo/other.git', items: [], rev: 5 }
    await backlogStore.load()
    expect(backlogStore.project).toBe('/repo/other.git')
    expect(backlogStore.items).toEqual([])
  })

  it('sends edits to main and shows its answer, never a local guess', async () => {
    invoke.mockImplementation(async (channel: string, ops: unknown) => {
      if (channel !== 'backlog:op') return undefined
      expect(ops).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 1, patch: { prompt: 'new' } }])
      return { ok: true, snapshot: { project: P, items: [item('b_aaaaaaaa', { prompt: 'new', version: 2 })], rev: 12 } }
    })
    const result = await backlogStore.update('b_aaaaaaaa', 1, { prompt: 'new' })
    expect(result.ok).toBe(true)
    expect(backlogStore.get('b_aaaaaaaa')?.prompt).toBe('new')
  })

  it('rejects when main is unreachable, so the editor keeps the text', async () => {
    invoke.mockRejectedValue(new Error('socket closed'))
    await expect(backlogStore.add({ prompt: 'kept' })).rejects.toThrow('socket closed')
    expect(backlogStore.items).toHaveLength(1)
  })

  it('reuses one requestId per Start intent until it settles', async () => {
    const ids: string[] = []
    invoke.mockImplementation(async (channel: string, req: { requestId: string }) => {
      if (channel !== 'backlog:start') return undefined
      ids.push(req.requestId)
      if (ids.length === 1) throw new Error('socket closed')
      if (ids.length === 2) throw new Error(`Error invoking remote method 'backlog:start': Error: ${SESSION_CREATE_UNWITNESSED}`)
      return { terminalId: 't1', label: 'x' }
    })
    await expect(backlogStore.start('b_aaaaaaaa')).rejects.toThrow('socket closed')
    await expect(backlogStore.start('b_aaaaaaaa')).rejects.toThrow(/did not confirm/)
    await expect(backlogStore.start('b_aaaaaaaa')).resolves.toEqual({ terminalId: 't1', label: 'x' })
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[1])
    expect(invoke).toHaveBeenLastCalledWith('backlog:start', { id: 'b_aaaaaaaa', requestId: ids[2] })
  })

  it('remembers the selected item, even one not added yet', () => {
    backlogStore.select('b_zzzzzzzz')
    expect(backlogStore.selectedId).toBe('b_zzzzzzzz')
    _resetBacklogForTests()
    expect(backlogStore.selectedId).toBeNull()
  })
})
