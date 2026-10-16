import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import SessionList from '../SessionList.svelte'
import { sessionsStore } from '../../../stores/sessions.svelte'
import { _receiveForTests, _resetWorkflowsForTests } from '../../../stores/workflows.svelte'
import type { WorkflowSnapshot } from '../../../../shared/workflow'

function snapshot(leadKey: string, id: string): WorkflowSnapshot {
  return {
    workflow: {
      id,
      project: '/repo/p.git',
      leadKey,
      leadLabel: 'Lead',
      title: 'Flow',
      goal: 'Goal',
      version: 1,
      status: 'running',
      tasks: [{ id: 'a', title: 'A', kind: 'agent', after: [], brief: 'b', onFailure: 'escalate', state: 'running', attempt: 1, steered: false }],
      patches: [],
      judgments: [],
      createdAt: '2026-10-16T00:00:00.000Z',
    },
    paused: null,
    workers: {},
  }
}

beforeEach(() => {
  vi.stubGlobal('api', { invoke: vi.fn(async () => undefined), on: () => () => {}, once: vi.fn() })
  sessionsStore.reset()
  _resetWorkflowsForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SessionList: a lead row\'s workflow progress', () => {
  it('is a Tab stop only in the active row, and leaves arrow keys to the list', async () => {
    const active = sessionsStore.createAgent({ provider: 'claude' }, '/repo', '/repo/main')
    const other = sessionsStore.createAgent({ provider: 'claude' }, '/repo', '/repo/main')
    sessionsStore.update(active, { providerSessionId: 'sid-active' })
    sessionsStore.update(other, { providerSessionId: 'sid-other' })
    sessionsStore.select(active)
    _receiveForTests(snapshot('sid-active', 'wf_activeaaa'))
    _receiveForTests(snapshot('sid-other', 'wf_otherbbbb'))
    render(SessionList)

    const buttons = screen.getAllByTestId('session-workflow-progress')
    const inSelectedRow = (b: HTMLElement) => b.closest('[role="option"]')?.getAttribute('aria-selected') === 'true'
    const activeButton = buttons.find(inSelectedRow)!
    const otherButton = buttons.find((b) => !inSelectedRow(b))!
    expect(activeButton).toHaveAttribute('tabindex', '0')
    expect(otherButton).toHaveAttribute('tabindex', '-1')

    // Svelte delegates events, so whether a key escaped the row shows past the root, on window.
    const seen: string[] = []
    const listen = (e: KeyboardEvent) => seen.push(e.key)
    window.addEventListener('keydown', listen)
    try {
      await fireEvent.keyDown(activeButton, { key: 'ArrowDown' })
      await fireEvent.keyDown(otherButton, { key: 'Enter' })
    } finally {
      window.removeEventListener('keydown', listen)
    }
    expect(seen).toEqual(['ArrowDown'])
    // The button's own Enter doesn't also activate its row.
    expect(sessionsStore.activeSessionId()).toBe(active)
  })
})
