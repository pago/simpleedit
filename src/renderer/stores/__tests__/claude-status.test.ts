import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getClaudeStatus,
  clearClaudeStatusForTerminal,
  initClaudeStatusListeners,
} from '../claude-status.svelte'
import type { EventMap } from '../../../shared/ipc-types'

// Capture the IPC handlers registered by initClaudeStatusListeners so tests
// can drive claude:status / pty:exit events directly.
type Handlers = {
  'claude:status'?: (d: EventMap['claude:status']) => void
  'pty:exit'?: (d: EventMap['pty:exit']) => void
}

let handlers: Handlers
let dispose: () => void

beforeEach(() => {
  handlers = {}
  vi.stubGlobal('api', {
    on: (channel: string, cb: (d: unknown) => void) => {
      ;(handlers as Record<string, unknown>)[channel] = cb
      return () => { delete (handlers as Record<string, unknown>)[channel] }
    },
    once: vi.fn(),
    invoke: vi.fn(),
  })
  dispose = initClaudeStatusListeners()
})

// Track every terminalId a test registers so afterEach can prune them all —
// module state (byTerminal) persists across tests, and hard-coding ids would
// silently rot if a future test adds another.
const registeredIds = new Set<string>()

afterEach(() => {
  for (const id of registeredIds) clearClaudeStatusForTerminal(id)
  registeredIds.clear()
  dispose()
  vi.unstubAllGlobals()
})

function status(worktreePath: string, s: string, terminalId: string): void {
  registeredIds.add(terminalId)
  handlers['claude:status']?.({ worktreePath, status: s as never, terminalId })
}
function exit(id: string): void {
  handlers['pty:exit']?.({ id, exitCode: 0 })
}

const W = '/repo/wt-a'
const W2 = '/repo/wt-b'

describe('claude-status store (#114 per-terminal aggregation)', () => {
  it('defaults to idle for an unknown worktree', () => {
    expect(getClaudeStatus(W)).toBe('idle')
  })

  it('reflects a terminal going running', () => {
    status(W, 'running', 't1')
    expect(getClaudeStatus(W)).toBe('running')
  })

  it('drops back to idle when the only running terminal exits (the #114 fix)', () => {
    status(W, 'running', 't1')
    expect(getClaudeStatus(W)).toBe('running')
    // pty:exit prunes the terminal outright, so the worktree can't stay stuck
    // on a stale 'running' even if it was the last status writer.
    exit('t1')
    expect(getClaudeStatus(W)).toBe('idle')
  })

  it('stays running while a second terminal in the same worktree is still active', () => {
    status(W, 'running', 't1')
    status(W, 'running', 't2')
    // t2 goes idle, but t1 is still running → worktree stays running.
    status(W, 'idle', 't2')
    expect(getClaudeStatus(W)).toBe('running')
    // t1 exits → now idle.
    exit('t1')
    expect(getClaudeStatus(W)).toBe('idle')
  })

  it('does not leak status across worktrees', () => {
    status(W, 'running', 't1')
    expect(getClaudeStatus(W2)).toBe('idle')
    status(W2, 'waiting', 't2')
    expect(getClaudeStatus(W)).toBe('running')
    expect(getClaudeStatus(W2)).toBe('waiting')
  })

  it('surfaces error when a terminal errored and none are active', () => {
    status(W, 'error', 't1')
    expect(getClaudeStatus(W)).toBe('error')
    // An active terminal outranks the error.
    status(W, 'running', 't2')
    expect(getClaudeStatus(W)).toBe('running')
  })

  it('clearClaudeStatusForTerminal removes a terminal directly', () => {
    status(W, 'running', 't1')
    clearClaudeStatusForTerminal('t1')
    expect(getClaudeStatus(W)).toBe('idle')
  })
})
