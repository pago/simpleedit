import { describe, it, expect, beforeEach } from 'vitest'
import {
  syncWindowSessions,
  getWindowSessions,
  forgetWindowSessions,
} from '../session-registry'
import type { WindowSessionInput } from '../../shared/ipc-types'

function session(overrides: Partial<WindowSessionInput> = {}): WindowSessionInput {
  return {
    terminalId: 'agent-claude-1',
    label: 'Fix the parser',
    kind: 'agent',
    provider: 'claude',
    worktreePath: '/repo/feat/parser',
    status: 'running',
    ...overrides,
  }
}

describe('session registry', () => {
  beforeEach(() => {
    forgetWindowSessions(1)
    forgetWindowSessions(2)
  })

  it('reports an empty list for a window that has never synced', () => {
    expect(getWindowSessions(99)).toEqual([])
  })

  it('stamps statusSince when a session first appears', () => {
    syncWindowSessions(1, [session()], 1000)
    expect(getWindowSessions(1)[0].statusSince).toBe(1000)
  })

  it('keeps statusSince while the status is unchanged', () => {
    syncWindowSessions(1, [session({ status: 'waiting' })], 1000)
    syncWindowSessions(1, [session({ status: 'waiting', label: 'Renamed' })], 5000)
    expect(getWindowSessions(1)[0].statusSince).toBe(1000)
    expect(getWindowSessions(1)[0].label).toBe('Renamed')
  })

  it('restamps statusSince when the status changes', () => {
    syncWindowSessions(1, [session({ status: 'running' })], 1000)
    syncWindowSessions(1, [session({ status: 'waiting' })], 5000)
    expect(getWindowSessions(1)[0].statusSince).toBe(5000)
  })

  it('restamps when a status changes back to one it held before', () => {
    syncWindowSessions(1, [session({ status: 'waiting' })], 1000)
    syncWindowSessions(1, [session({ status: 'running' })], 2000)
    syncWindowSessions(1, [session({ status: 'waiting' })], 3000)
    expect(getWindowSessions(1)[0].statusSince).toBe(3000)
  })

  it('reports a change only when the pushed list actually differs', () => {
    expect(syncWindowSessions(1, [session()], 1000)).toBe(true)
    expect(syncWindowSessions(1, [session()], 2000)).toBe(false)
    expect(syncWindowSessions(1, [session({ label: 'Other' })], 3000)).toBe(true)
    expect(syncWindowSessions(1, [], 4000)).toBe(true)
  })

  it('treats an empty first sync as a change, so a client hears the empty list', () => {
    expect(syncWindowSessions(1, [], 1000)).toBe(true)
    expect(syncWindowSessions(1, [], 2000)).toBe(false)
  })

  it('notices a reordering, since the list is the sidebar order', () => {
    const a = session({ terminalId: 'a' })
    const b = session({ terminalId: 'b' })
    syncWindowSessions(1, [a, b], 1000)
    expect(syncWindowSessions(1, [b, a], 2000)).toBe(true)
  })

  it('keeps each window\'s list to itself', () => {
    syncWindowSessions(1, [session({ terminalId: 'a' })], 1000)
    syncWindowSessions(2, [session({ terminalId: 'b' })], 1000)
    expect(getWindowSessions(1).map((s) => s.terminalId)).toEqual(['a'])
    expect(getWindowSessions(2).map((s) => s.terminalId)).toEqual(['b'])
  })

  it('drops a window\'s list when the window goes', () => {
    syncWindowSessions(1, [session()], 1000)
    forgetWindowSessions(1)
    expect(getWindowSessions(1)).toEqual([])
  })
})
