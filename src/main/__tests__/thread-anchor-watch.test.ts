import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseThreadOp, formatThreadForAgent, type ThreadAnchor, type ThreadChange } from '../../shared/agent-threads'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import { addAgentThread, applyThreadOp, assertKnownWorktree, getThread, setThreadAnchor } from '../agent-threads-store'
import { noteAnchorChanges, reanchorFile, startThreadAnchorWatch, stopThreadAnchorWatch } from '../thread-anchor-watch'

const root = mkdtempSync(join(tmpdir(), 'simpleedit-anchor-watch-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const LINES = ['a', 'b', 'c', 'function f() {', '  return compute(input)', '}', 'd', 'e']
const SNIPPET = LINES.slice(3, 6).join('\n')

let wt: string
let file: string
let broadcasts: ThreadChange[][]

function anchor(context: ThreadAnchor['context'] = 'file'): ThreadAnchor {
  return { path: 'src/f.ts', startLine: 4, endLine: 6, snippet: SNIPPET, before: 'a\nb\nc', after: 'd\ne', context }
}

function addThread(id: string, context: ThreadAnchor['context'] = 'file'): ThreadChange {
  const { change } = applyThreadOp({
    kind: 'add-thread',
    thread: { id, sessionId: 's1', worktreePath: wt, anchor: anchor(context) },
    message: { id: `m_${id.slice(2)}1`, body: 'why?' },
  })
  if (!change) throw new Error('not added')
  return change
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
  wt = mkdtempSync(join(root, 'wt-'))
  mkdirSync(join(wt, 'src'))
  file = join(wt, 'src/f.ts')
  writeFileSync(file, LINES.join('\n'))
  broadcasts = []
})

afterEach(() => stopThreadAnchorWatch())

describe('thread anchor watch', () => {
  it('re-anchors at startup for edits made while the app was closed, and broadcasts the move', async () => {
    addThread('t_aaaaaa')
    writeFileSync(file, ['// new', ...LINES].join('\n'))
    await startThreadAnchorWatch({ broadcast: (c) => broadcasts.push(c) })
    expect(getThread('t_aaaaaa')?.anchor).toMatchObject({ startLine: 5, endLine: 7 })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]![0]!.thread?.anchor.startLine).toBe(5)
  })

  it('leaves commit threads alone, and follows uncommitted ones', async () => {
    addThread('t_commit1', { commit: 'abc1234' })
    addThread('t_uncomm1', { commit: 'uncommitted' })
    writeFileSync(file, ['// new', ...LINES].join('\n'))
    await startThreadAnchorWatch({ broadcast: (c) => broadcasts.push(c) })
    expect(getThread('t_commit1')?.anchor.startLine).toBe(4)
    expect(getThread('t_uncomm1')?.anchor.startLine).toBe(5)
  })

  it('orphans on deletion and recovers when the code comes back', async () => {
    addThread('t_aaaaaa')
    await startThreadAnchorWatch({ broadcast: (c) => broadcasts.push(c) })
    expect(broadcasts).toHaveLength(0)
    unlinkSync(file)
    await reanchorFile(file)
    expect(getThread('t_aaaaaa')?.anchor).toMatchObject({ orphaned: true, startLine: 4 })
    writeFileSync(file, ['x', 'y', ...LINES].join('\n'))
    await reanchorFile(file)
    const back = getThread('t_aaaaaa')!
    expect(back.anchor).toMatchObject({ startLine: 6, endLine: 8 })
    expect(back.anchor.orphaned).toBeUndefined()
    expect(broadcasts).toHaveLength(2)
  })

  it('watches a file once a thread is added, even one no editor has open', async () => {
    await startThreadAnchorWatch({ broadcast: (c) => broadcasts.push(c) })
    noteAnchorChanges([addThread('t_aaaaaa')])
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(file, ['// one', '// two', ...LINES].join('\n'))
    await waitFor(() => getThread('t_aaaaaa')?.anchor.startLine === 6)
    expect(broadcasts.at(-1)?.[0]?.threadId).toBe('t_aaaaaa')
  })

  it('re-anchors a new thread straight away, as its lines may come from a stale diff', async () => {
    await startThreadAnchorWatch({ broadcast: (c) => broadcasts.push(c) })
    writeFileSync(file, ['// one', ...LINES].join('\n'))
    noteAnchorChanges([addThread('t_aaaaaa')])
    await reanchorFile(file)
    expect(getThread('t_aaaaaa')?.anchor.startLine).toBe(5)
  })

  it('re-anchors an agent-opened thread too', async () => {
    await startThreadAnchorWatch({ broadcast: (c) => broadcasts.push(c) })
    writeFileSync(file, ['// one', ...LINES].join('\n'))
    const change = addAgentThread({ id: 't_agent1', sessionId: 's1', worktreePath: wt, anchor: anchor(), messageId: 'm_agent11', body: 'look' })
    noteAnchorChanges([change])
    await reanchorFile(file)
    expect(getThread('t_agent1')?.anchor.startLine).toBe(5)
  })

  it('orphans a short thread without context once its file changes, not before', async () => {
    writeFileSync(file, '}')
    applyThreadOp({
      kind: 'add-thread',
      thread: { id: 't_lone11', sessionId: 's1', worktreePath: wt, anchor: { ...anchor(), startLine: 1, endLine: 1, snippet: '}', before: '', after: '' } },
      message: { id: 'm_lone111', body: 'why?' },
    })
    await startThreadAnchorWatch({ broadcast: (c) => broadcasts.push(c) })
    await reanchorFile(file)
    expect(getThread('t_lone11')?.anchor.orphaned).toBeUndefined()
    writeFileSync(file, '}\n// more')
    await reanchorFile(file)
    expect(getThread('t_lone11')?.anchor.orphaned).toBe(true)
  })

  it('leaves a thread on a directory alone instead of orphaning it', async () => {
    const { change } = applyThreadOp({
      kind: 'add-thread',
      thread: { id: 't_dir111', sessionId: 's1', worktreePath: wt, anchor: { ...anchor(), path: 'src' } },
      message: { id: 'm_dir1111', body: 'why?' },
    })
    await startThreadAnchorWatch({ broadcast: (c) => broadcasts.push(c) })
    noteAnchorChanges([change!])
    await reanchorFile(join(wt, 'src'))
    expect(getThread('t_dir111')?.anchor.orphaned).toBeUndefined()
    expect(broadcasts).toHaveLength(0)
  })

  it('stops following a removed thread', async () => {
    addThread('t_aaaaaa')
    await startThreadAnchorWatch({ broadcast: (c) => broadcasts.push(c) })
    const { change } = applyThreadOp({ kind: 'remove-thread', threadId: 't_aaaaaa' })
    noteAnchorChanges([change!])
    writeFileSync(file, 'gone')
    await reanchorFile(file)
    expect(broadcasts).toHaveLength(0)
  })

  it('puts the moved lines into the follow-up header', async () => {
    addThread('t_aaaaaa')
    writeFileSync(file, ['// new', ...LINES].join('\n'))
    await startThreadAnchorWatch({ broadcast: () => {} })
    const header = formatThreadForAgent(getThread('t_aaaaaa')!, new Set()).split('\n')[0]
    expect(header).toBe(`[Thread t_aaaaaa · ${wt}/src/f.ts:5-7]`)
  })
})

describe('set-anchor', () => {
  it('is never accepted from a client', () => {
    expect(() => parseThreadOp({ kind: 'set-anchor', threadId: 't_aaaaaa', anchor: anchor() })).toThrow('Malformed thread op')
  })

  it('writes and bumps the revision only on an actual change, keeping updatedAt', () => {
    const added = addThread('t_aaaaaa')
    expect(setThreadAnchor('t_aaaaaa', anchor())).toBeNull()
    const change = setThreadAnchor('t_aaaaaa', { ...anchor(), orphaned: true })
    expect(change?.rev).toBeGreaterThan(added.rev)
    expect(change?.thread?.anchor.orphaned).toBe(true)
    expect(change?.thread?.updatedAt).toBe(added.thread?.updatedAt)
    expect(setThreadAnchor('t_missing1', anchor())).toBeNull()
  })
})

describe('assertKnownWorktree', () => {
  const op = { kind: 'add-thread', thread: { id: 't_aaaaaa', sessionId: 's1', worktreePath: '/repo/wt', anchor: anchor() }, message: { id: 'm_aaaaaa1', body: 'x' } } as const

  it("refuses a client's thread outside the window's worktrees", () => {
    expect(() => assertKnownWorktree(op, ['/repo/main', '/repo/wt/'])).not.toThrow()
    expect(() => assertKnownWorktree(op, ['/repo/main'])).toThrow()
    expect(() => assertKnownWorktree({ kind: 'remove-thread', threadId: 't_aaaaaa' }, [])).not.toThrow()
  })
})
