import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushSync } from 'svelte'
import { clearAgentStatusForTerminal, initAgentStatusListeners } from '../agent-status.svelte'
import { _resetSessionAttentionForTests, initSessionAttention, isUnseen } from '../sessionAttention.svelte'
import type { AgentStatus, EventMap } from '../../../shared/ipc-types'

type Handlers = {
  'agent:status'?: (d: EventMap['agent:status']) => void
  'pty:exit'?: (d: EventMap['pty:exit']) => void
}

let handlers: Handlers
let shown = $state<string | null>(null)
let hasFocus = true
let disposeStatus: () => void
let disposeAttention: () => void
const ids = new Set<string>()

beforeEach(() => {
  handlers = {}
  shown = null
  hasFocus = true
  vi.stubGlobal('api', {
    on: (channel: string, cb: (d: unknown) => void) => {
      ;(handlers as Record<string, unknown>)[channel] = cb
      return () => { delete (handlers as Record<string, unknown>)[channel] }
    },
    once: vi.fn(),
    invoke: vi.fn(),
  })
  vi.spyOn(document, 'hasFocus').mockImplementation(() => hasFocus)
  disposeStatus = initAgentStatusListeners()
  disposeAttention = initSessionAttention(() => shown)
  flushSync()
})

afterEach(() => {
  for (const id of ids) clearAgentStatusForTerminal(id)
  ids.clear()
  disposeAttention()
  disposeStatus()
  _resetSessionAttentionForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function status(terminalId: string, s: AgentStatus, precise = true): void {
  ids.add(terminalId)
  handlers['agent:status']?.({ worktreePath: '/repo/wt', status: s, terminalId, precise })
  flushSync()
}

function show(id: string | null): void {
  shown = id
  flushSync()
}

function focus(on: boolean): void {
  hasFocus = on
  window.dispatchEvent(new Event(on ? 'focus' : 'blur'))
  flushSync()
}

describe('sessionAttention', () => {
  it('marks a turn that ends while the session is not shown', () => {
    show('other')
    status('t1', 'running')
    status('t1', 'idle')
    expect(isUnseen('t1')).toBe(true)
  })

  it('marks after initializing → idle too', () => {
    status('t1', 'initializing')
    status('t1', 'idle')
    expect(isUnseen('t1')).toBe(true)
  })

  it('does not mark a turn that ends on screen', () => {
    show('t1')
    status('t1', 'running')
    status('t1', 'idle')
    expect(isUnseen('t1')).toBe(false)
  })

  it('marks when the session is shown but the window is unfocused', () => {
    show('t1')
    focus(false)
    status('t1', 'running')
    status('t1', 'idle')
    expect(isUnseen('t1')).toBe(true)
  })

  it('does not mark idle reached from waiting, an unknown status or a repeat', () => {
    status('t1', 'waiting')
    status('t1', 'idle')
    status('t2', 'idle')
    status('t2', 'idle')
    expect(isUnseen('t1')).toBe(false)
    expect(isUnseen('t2')).toBe(false)
  })

  it('ignores a degraded event the precise guard drops', () => {
    status('t1', 'running')
    status('t1', 'idle', false)
    expect(isUnseen('t1')).toBe(false)
  })

  it('clears when the session comes on screen', () => {
    status('t1', 'running')
    status('t1', 'idle')
    show('t1')
    expect(isUnseen('t1')).toBe(false)
  })

  it('clears on window refocus while the session is shown', () => {
    show('t1')
    focus(false)
    status('t1', 'running')
    status('t1', 'idle')
    expect(isUnseen('t1')).toBe(true)
    focus(true)
    expect(isUnseen('t1')).toBe(false)
  })

  it('drops on pty:exit and on clear', () => {
    status('t1', 'running')
    status('t1', 'idle')
    status('t2', 'running')
    status('t2', 'idle')
    handlers['pty:exit']?.({ id: 't1', exitCode: 0 })
    clearAgentStatusForTerminal('t2')
    expect(isUnseen('t1')).toBe(false)
    expect(isUnseen('t2')).toBe(false)
  })
})
