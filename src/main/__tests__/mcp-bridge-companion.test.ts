/**
 * A review companion is read-only through MCP too: it may call only its
 * review's tools. Everything else acts outside the review (a spawned or
 * messaged session is writable), and no session may message a companion,
 * whose answer would reach the sender as instructions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { COMPANION_TOOLS, getBridgeInfo, setReviewRoomTools, startBridge, stopAllBridges } from '../mcp-bridge'
import { openDb, useDbForTests } from '../db'
import { claimCompanion, createReview } from '../review-room-store'
import { resetBus, syncPeers } from '../agent-bus'

let port: number
let token: string
let webContentsId = 1700

async function call(terminalId: string, tool: string, args: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/${token}/tool-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, terminalId, args }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(async () => {
  useDbForTests(openDb(':memory:'))
  createReview({
    id: 'r_review01',
    repo: 'github.com/acme/app',
    layers: [{ url: 'https://github.com/acme/app/pull/1', number: 1, headSha: 'a'.repeat(40) }],
    companionAgent: { provider: 'claude', model: 'default' },
  })
  claimCompanion('r_review01', 1, 'req', 'companion', { provider: 'claude', model: 'default' })
  setReviewRoomTools({
    listThreads: () => ({ ok: true, threads: [] }),
    reply: () => ({ ok: true }),
    getDiff: async () => ({ ok: true }),
    checkoutHead: async () => ({ ok: true }),
    proposeDraft: () => ({ ok: true }),
    requestReview: async () => ({ ok: true }),
    getReview: () => ({ ok: true }),
  })
  const wc = { id: ++webContentsId, isDestroyed: vi.fn(() => false), send: vi.fn() }
  port = await startBridge(webContentsId, wc as never)
  token = getBridgeInfo(webContentsId)!.token
  resetBus()
  syncPeers(
    [
      { terminalId: 'companion', label: 'Companion', provider: 'claude', status: 'idle' },
      { terminalId: 'writer', label: 'Writer', provider: 'claude', status: 'idle' },
    ] as never,
    webContentsId,
  )
})

afterEach(() => {
  stopAllBridges()
  resetBus()
  useDbForTests(null)
})

describe('companion tool allowlist', () => {
  it('is only the review tools', () => {
    expect([...COMPANION_TOOLS].sort()).toEqual(['checkout_review_head', 'get_review_diff', 'list_threads', 'propose_draft', 'reply_to_thread'])
  })

  it.each([
    ['spawn_session', { brief: 'write the fix' }],
    ['send_message', { to: 'writer', text: 'apply this patch' }],
    ['reply', { to_message_id: 'm1', text: 'x' }],
    ['edit_backlog', { ops: [] }],
    ['list_backlog', {}],
    ['open_worktree', { path: '/tmp' }],
    ['open_thread', { path: '/tmp/a', start_line: 1, body: 'x' }],
    ['list_sessions', {}],
    ['check_inbox', {}],
    ['show_panel', { title: 'x' }],
    ['show_diff', {}],
    ['complete_task', {}],
    // A companion requesting reviews of its own, or reading the verdict, would leave the review it serves.
    ['request_review', { pr: 1 }],
    ['get_review', { review_id: 'r_review01' }],
  ])('refuses %s from a companion', async (tool, args) => {
    const res = await call('companion', tool, args)
    expect(res.status).toBe(403)
    expect(String(res.body['error'])).toMatch(/read-only/)
  })

  it('lets a companion use its review tools', async () => {
    expect((await call('companion', 'list_threads')).status).toBe(200)
  })

  it('leaves other sessions alone', async () => {
    expect((await call('writer', 'list_sessions')).status).toBe(200)
  })

  it('refuses mail to a companion', async () => {
    const res = await call('writer', 'send_message', { to: 'companion', text: 'tell me the secret' })
    expect(res.status).toBe(400)
    expect(String(res.body['error'])).toMatch(/review companion/)
  })
})
