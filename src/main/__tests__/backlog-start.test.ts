import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SESSION_CREATE_UNWITNESSED, type SessionCreateRequest, type SessionCreateResult } from '../../shared/ipc-types'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import { _resetBacklogForTests, applyBacklogOps, loadBacklog } from '../backlog-store'
import { _resetBacklogStartForTests, startBacklogItem, type StartDeps } from '../backlog-start'

/**
 * Starting an item makes exactly one session, and the item leaves the backlog
 * only when that session is confirmed.
 */

const P = '/repo/project.git'
const ID = 'b_aaaaaaaa'

interface Pending {
  request: SessionCreateRequest
  resolve(result: SessionCreateResult): void
  reject(err: Error): void
}

function fakeDeps() {
  const calls: Pending[] = []
  const deps: StartDeps & { calls: Pending[]; changes: number } = {
    calls,
    changes: 0,
    createSession: (request) =>
      new Promise((resolve, reject) => {
        calls.push({ request, resolve, reject })
      }),
    changed() {
      deps.changes++
    },
  }
  return deps
}

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
  _resetBacklogForTests()
  _resetBacklogStartForTests()
  applyBacklogOps(
    P,
    [
      {
        kind: 'add',
        item: { id: ID, prompt: '  Rework @src/a.ts verbatim\n', label: 'rework a', target: { provider: 'codex', model: 'gpt-5.5' } },
      },
    ],
    { createdBy: 'desktop' },
  )
})

describe('startBacklogItem', () => {
  it('refuses an item without a prompt before making any session', async () => {
    applyBacklogOps(P, [{ kind: 'update', id: ID, patch: { prompt: ' \n' } }], { createdBy: 'desktop' })
    const deps = fakeDeps()
    await expect(startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)).rejects.toThrow('Write a prompt before starting this item.')
    expect(deps.calls).toHaveLength(0)
    expect(loadBacklog(P).items[0].starting).toBeUndefined()
    expect(loadBacklog(P).items[0].lastStart).toBeUndefined()

    // The same requestId goes ahead once the prompt is written.
    applyBacklogOps(P, [{ kind: 'update', id: ID, patch: { prompt: 'go' } }], { createdBy: 'desktop' })
    void startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)
    await vi.waitFor(() => expect(deps.calls).toHaveLength(1))
  })

  it('starts a session with the item settings and removes the item', async () => {
    const deps = fakeDeps()
    const start = startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)
    await vi.waitFor(() => expect(deps.calls).toHaveLength(1))
    expect(deps.calls[0].request).toEqual({
      requestId: 'backlog:r1',
      brief: '  Rework @src/a.ts verbatim\n',
      label: 'rework a',
      target: { provider: 'codex', model: 'gpt-5.5' },
    })
    expect(loadBacklog(P).items[0].starting).toBe(true)
    deps.calls[0].resolve({ terminalId: 't1', label: 'rework a' })
    await expect(start).resolves.toEqual({ terminalId: 't1', label: 'rework a' })
    expect(loadBacklog(P).items).toEqual([])
    expect(deps.changes).toBeGreaterThanOrEqual(2)
  })

  it('answers a replayed start with the session it already made', async () => {
    const deps = fakeDeps()
    const first = startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)
    await vi.waitFor(() => expect(deps.calls).toHaveLength(1))
    deps.calls[0].resolve({ terminalId: 't1', label: 'x' })
    await first
    await expect(startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)).resolves.toEqual({ terminalId: 't1', label: 'x' })
    expect(deps.calls).toHaveLength(1)
  })

  it('makes one session when two clients start the same item', async () => {
    const deps = fakeDeps()
    const desk = startBacklogItem(P, { id: ID, requestId: 'desk' }, deps)
    await expect(startBacklogItem(P, { id: ID, requestId: 'phone' }, deps)).rejects.toThrow(/already being started/)
    await vi.waitFor(() => expect(deps.calls).toHaveLength(1))
    deps.calls[0].resolve({ terminalId: 't1', label: 'x' })
    await desk
  })

  it('refuses edits while starting', async () => {
    const deps = fakeDeps()
    const start = startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)
    const { result } = applyBacklogOps(P, [{ kind: 'update', id: ID, patch: { prompt: 'late edit' } }], { createdBy: 'phone' })
    expect(result.ok).toBe(false)
    await vi.waitFor(() => expect(deps.calls).toHaveLength(1))
    deps.calls[0].resolve({ terminalId: 't1', label: 'x' })
    await start
  })

  it('keeps the item and says why when nothing started, and lets it be retried', async () => {
    const deps = fakeDeps()
    const start = startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)
    await vi.waitFor(() => expect(deps.calls).toHaveLength(1))
    deps.calls[0].reject(new Error("Codex doesn't offer the model “gpt-5.5”."))
    await expect(start).rejects.toThrow(/doesn't offer/)
    const [item] = loadBacklog(P).items
    expect(item.lastStart).toMatchObject({ outcome: 'failed', reason: expect.stringContaining("doesn't offer") })
    expect(item.starting).toBeUndefined()

    const retry = startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)
    await vi.waitFor(() => expect(deps.calls).toHaveLength(2))
    deps.calls[1].resolve({ terminalId: 't2', label: 'x' })
    await expect(retry).resolves.toMatchObject({ terminalId: 't2' })
  })

  it('keeps an unconfirmed start flagged, and repeats the uncertainty on replay', async () => {
    const deps = fakeDeps()
    const start = startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)
    await vi.waitFor(() => expect(deps.calls).toHaveLength(1))
    deps.calls[0].reject(new Error(SESSION_CREATE_UNWITNESSED))
    await expect(start).rejects.toThrow(SESSION_CREATE_UNWITNESSED)
    expect(loadBacklog(P).items[0].lastStart?.outcome).toBe('unconfirmed')

    await expect(startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)).rejects.toThrow(SESSION_CREATE_UNWITNESSED)
    expect(deps.calls).toHaveLength(1)
  })

  it('keeps the item flagged, not failed, when it started but could not be removed', async () => {
    const store = await import('../backlog-store')
    const spy = vi.spyOn(store, 'removeStartedItem').mockImplementation(() => {
      throw new Error('disk full')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = fakeDeps()
    const start = startBacklogItem(P, { id: ID, requestId: 'r1' }, deps)
    await vi.waitFor(() => expect(deps.calls).toHaveLength(1))
    deps.calls[0].resolve({ terminalId: 't1', label: 'rework a' })
    await expect(start).resolves.toEqual({ terminalId: 't1', label: 'rework a' })
    const [item] = loadBacklog(P).items
    expect(item.lastStart?.outcome).toBe('unconfirmed')
    expect(item.starting).toBeUndefined()
    spy.mockRestore()
  })

  it("refuses an item that isn't there", async () => {
    const deps = fakeDeps()
    await expect(startBacklogItem(P, { id: 'b_zzzzzzzz', requestId: 'r2' }, deps)).rejects.toThrow(/gone/)
  })
})
