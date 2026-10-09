import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { startBridge, getBridgeInfo, stopAllBridges, setBacklogTools } from '../mcp-bridge'
import { openDb, useDbForTests } from '../db'
import { _resetBacklogForTests, applyBacklogOps, loadBacklog, parseBacklogOps } from '../backlog-store'
import { syncPeers } from '../agent-bus'

/**
 * The backlog tools act on the WINDOW's project, wherever the calling agent
 * works — the bridge never looks at the caller's cwd or worktree.
 */

const PROJECT = '/repo/project.git'
let port: number
let token: string
let webContentsId = 1900
let projectFor: number[]

beforeEach(async () => {
  useDbForTests(openDb(':memory:'))
  _resetBacklogForTests()
  projectFor = []
  setBacklogTools({
    load: (id) => {
      projectFor.push(id)
      return loadBacklog(PROJECT)
    },
    edit: async (id, raw, origin) => {
      projectFor.push(id)
      return applyBacklogOps(PROJECT, parseBacklogOps(raw), origin).result
    },
    resolveClaudeModel: async (model) => ({ provider: 'anthropic', model }),
  })
  const wc = { id: ++webContentsId, isDestroyed: vi.fn(() => false), send: vi.fn() }
  port = await startBridge(webContentsId, wc as never)
  token = getBridgeInfo(webContentsId)!.token
  syncPeers([{ terminalId: 's1', label: 'parser rewrite', provider: 'claude', worktreePath: '/other-repo/wt', status: 'idle' }], webContentsId)
})

afterEach(() => {
  stopAllBridges()
})

async function call(tool: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/${token}/tool-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, terminalId: 's1', args }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('backlog tools', () => {
  it("adds to the window's project, recording the calling session", async () => {
    const res = await call('edit_backlog', { ops: [{ op: 'add', prompt: 'Rewrite the parser', label: 'parser' }] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ project: 'project', added: [expect.stringMatching(/^b_/)] })
    expect(new Set(projectFor)).toEqual(new Set([webContentsId]))
    expect(loadBacklog(PROJECT).items[0]).toMatchObject({ prompt: 'Rewrite the parser', createdBy: 'agent', createdBySession: 'parser rewrite' })
  })

  it('lists the items in order', async () => {
    await call('edit_backlog', { ops: [{ op: 'add', prompt: 'a' }, { op: 'add', prompt: 'b', position: 0 }] })
    const res = await call('list_backlog', {})
    expect((res.body['items'] as Array<{ prompt: string; position: number }>).map((i) => [i.position, i.prompt])).toEqual([
      [0, 'b'],
      [1, 'a'],
    ])
  })

  it('refuses a stale update and says to list again', async () => {
    const added = await call('edit_backlog', { ops: [{ op: 'add', prompt: 'a' }] })
    const id = (added.body['added'] as string[])[0]
    await call('edit_backlog', { ops: [{ op: 'update', id, prompt: 'user edit' }] })
    const res = await call('edit_backlog', { ops: [{ op: 'update', id, base_version: 1, prompt: 'agent edit' }] })
    expect(res.status).toBe(409)
    expect(String(res.body['error'])).toMatch(/list_backlog/)
    expect(loadBacklog(PROJECT).items[0].prompt).toBe('user edit')
  })

  it('refuses a malformed op without applying the batch', async () => {
    const res = await call('edit_backlog', { ops: [{ op: 'add', prompt: 'ok' }, { op: 'add', prompt: '' }] })
    expect(res.status).toBe(400)
    expect(loadBacklog(PROJECT).items).toEqual([])
  })
})
