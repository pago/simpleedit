import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { startBridge, getBridgeInfo, stopAllBridges, setWorktreeResolver } from '../mcp-bridge'
import { openDb, useDbForTests } from '../db'
import { getThread } from '../agent-threads-store'
import { MAX_UNANSWERED_AGENT_THREADS, initThreadDelivery, resetThreadDelivery } from '../thread-delivery'
import { hasUnread, type AgentThread } from '../../shared/agent-threads'

let port: number
let token: string
let root: string
let file: string
let replies: AgentThread[]
let live: boolean
let webContentsId = 900

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'threads-')))
  mkdirSync(join(root, 'src'))
  file = join(root, 'src', 'a.ts')
  writeFileSync(file, ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n'))
  useDbForTests(openDb(':memory:'))
  replies = []
  live = true
  initThreadDelivery({
    provider: () => (live ? 'claude' : null),
    write: () => {},
    push: () => null,
    broadcast: () => {},
    onAgentReply: (t) => replies.push(t),
  })
  const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() }
  port = await startBridge(++webContentsId, wc as never)
  token = getBridgeInfo(webContentsId)!.token
  setWorktreeResolver(async () => [{ path: root, branch: 'main', isMain: true, isCurrent: true }])
})

afterEach(() => {
  stopAllBridges()
  setWorktreeResolver(async () => [])
  resetThreadDelivery()
  rmSync(root, { recursive: true, force: true })
})

async function openThread(args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/${token}/tool-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'open_thread', terminalId: 's1', args }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('open_thread', () => {
  it('anchors an unread agent thread on the lines, relative to the worktree', async () => {
    const res = await openThread({ path: file, start_line: 4, end_line: 5, body: 'Is **this** intended?' })
    expect(res.status).toBe(200)
    const t = getThread(String(res.body['thread_id']))!
    expect(t).toMatchObject({ sessionId: 's1', worktreePath: root, status: 'open' })
    expect(t.anchor).toMatchObject({ path: 'src/a.ts', startLine: 4, endLine: 5, snippet: 'four\nfive', before: 'one\ntwo\nthree', after: 'six\nseven\neight', context: 'file' })
    expect(t.messages).toEqual([expect.objectContaining({ author: 'agent', body: 'Is **this** intended?' })])
    expect(hasUnread(t)).toBe(true)
    expect(replies.map((r) => r.id)).toEqual([t.id])
  })

  it.each([
    ['a relative path', { path: 'src/a.ts', start_line: 1, body: 'x' }, /absolute/],
    ['a file outside every worktree', { path: join(tmpdir(), 'elsewhere.ts'), start_line: 1, body: 'x' }, /not in a git worktree/],
    ['lines past the end', { path: '', start_line: 7, end_line: 9, body: 'x' }, /outside/],
    ['a reversed range', { path: '', start_line: 3, end_line: 2, body: 'x' }, /outside/],
    ['an empty body', { path: '', start_line: 1, body: '  ' }, /non-empty/],
  ])('refuses %s', async (_name, args, error) => {
    const res = await openThread({ ...args, path: args.path || file })
    expect(res.status).toBe(400)
    expect(String(res.body['error'])).toMatch(error)
  })

  it('refuses a session that is not a running agent', async () => {
    live = false
    const res = await openThread({ path: file, start_line: 1, body: 'x' })
    expect(res.status).toBe(400)
    expect(String(res.body['error'])).toMatch(/running agent session/)
  })

  it('accepts a file whose name starts with two dots, and refuses lines too long to anchor', async () => {
    writeFileSync(join(root, '..env.example'), 'A=1\n')
    expect((await openThread({ path: join(root, '..env.example'), start_line: 1, body: 'x' })).status).toBe(200)

    const huge = join(root, 'src', 'bundle.js')
    writeFileSync(huge, ['short', 'x'.repeat(20_000), 'tail'].join('\n'))
    const tooLong = await openThread({ path: huge, start_line: 2, body: 'x' })
    expect(tooLong.status).toBe(400)
    expect(String(tooLong.body['error'])).toMatch(/too long/)

    const res = await openThread({ path: huge, start_line: 3, body: 'x' })
    expect(getThread(String(res.body['thread_id']))!.anchor).toMatchObject({ snippet: 'tail', before: '' })
  })

  it('caps the threads an agent leaves unanswered', async () => {
    for (let i = 0; i < MAX_UNANSWERED_AGENT_THREADS; i++) {
      expect((await openThread({ path: file, start_line: i + 1, body: `q${i}` })).status).toBe(200)
    }
    const res = await openThread({ path: file, start_line: 8, body: 'one more' })
    expect(res.status).toBe(400)
    expect(String(res.body['error'])).toMatch(/haven't answered|hasn't answered/)
  })
})
