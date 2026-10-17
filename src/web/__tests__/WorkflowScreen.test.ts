import { render, screen, waitFor, within } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import WorkflowScreen from '../WorkflowScreen.svelte'
import type { AgentStatus } from '../../shared/ipc-types'
import type { Workflow, WorkflowSnapshot, WorkflowTask } from '../../shared/workflow'

function task(id: string, extra: Partial<WorkflowTask> = {}): WorkflowTask {
  return { id, title: `Task ${id}`, kind: 'agent', after: [], brief: '', onFailure: 'escalate', state: 'queued', attempt: 0, steered: false, ...extra }
}

function snapshot(tasks: WorkflowTask[], extra: Partial<WorkflowSnapshot> = {}, workflow: Partial<Workflow> = {}): WorkflowSnapshot {
  return {
    workflow: {
      id: 'wf_abcdefgh',
      project: '/repo/p.git',
      leadKey: 'lead',
      leadLabel: 'Lead',
      title: 'Flow',
      goal: '',
      version: 1,
      status: 'running',
      tasks,
      patches: [],
      judgments: [],
      createdAt: '2026-10-16T00:00:00.000Z',
      ...workflow,
    },
    paused: null,
    workers: {},
    reviewers: {},
    slim: true,
    leadTerminalId: 'lead-t',
    leadWindowId: 1,
    ...extra,
  }
}

const statuses = (map: Record<string, AgentStatus>) => (terminalId: string): AgentStatus => map[terminalId] ?? 'idle'

/**
 * a → b, a → c, then d after both: three stages. b's worker is asking
 * something, so it is the one thing that needs the user.
 */
const GRAPH = snapshot(
  [
    task('a', { state: 'done', attempt: 1 }),
    task('b', { after: ['a'], state: 'running', attempt: 1 }),
    task('c', { after: ['a'], state: 'running', attempt: 1 }),
    task('d', { after: ['b', 'c'] }),
  ],
  { workers: { b: 'wb', c: 'wc' }, statuses: { wb: 'waiting', wc: 'running' } },
)

describe('WorkflowScreen', () => {
  it('lists Needs you first, then one section per stage of the graph', () => {
    render(WorkflowScreen, { snapshot: GRAPH, statusOf: statuses({ wb: 'waiting', wc: 'running' }), blocked: null, onopen: vi.fn() })
    const sections = screen.getByTestId('workflow-screen').querySelectorAll('section')
    expect(sections[0]).toBe(screen.getByTestId('workflow-needs-you'))
    expect(within(screen.getByTestId('workflow-needs-you')).getByTestId('needs-you-item')).toHaveTextContent('Task b')
    const stages = screen.getAllByTestId('workflow-stage')
    expect(stages.map((s) => s.querySelector('h2')?.textContent)).toEqual(['Stage 1', 'Stage 2', 'Stage 3'])
    expect(within(stages[1]).getAllByTestId('workflow-task').map((r) => r.dataset.taskId)).toEqual(['b', 'c'])
    expect(screen.getByTestId('workflow-status')).toHaveTextContent('Running · 1 of 4 done')
  })

  it("opens the task's terminal on a tap, and a task without one can't be tapped", async () => {
    const onopen = vi.fn()
    render(WorkflowScreen, { snapshot: GRAPH, statusOf: statuses({}), blocked: null, onopen })
    const row = (id: string) => screen.getAllByTestId('workflow-task').find((r) => r.dataset.taskId === id)!
    row('c').click()
    expect(onopen).toHaveBeenCalledWith('wc')
    expect(row('d')).toBeDisabled()
  })

  it('opens nothing while the phone is in another window, and says why', () => {
    const onopen = vi.fn()
    const reason = 'This workflow runs in Other, and this phone is showing Here. Switch project to open its terminals.'
    render(WorkflowScreen, { snapshot: GRAPH, statusOf: statuses({ wb: 'waiting' }), blocked: reason, onopen })
    expect(screen.getByTestId('workflow-open-blocked')).toHaveTextContent(reason)
    expect(screen.getByTestId('needs-you-item')).toBeDisabled()
    for (const row of screen.getAllByTestId('workflow-task')) expect(row).toBeDisabled()
  })

  it("nests a map's children under it, and shows a loop's round", () => {
    const loop = task('l', {
      kind: 'loop',
      state: 'running',
      attempt: 1,
      maxRounds: 3,
      reviewers: 1,
      rounds: [{ round: 1, review: 'done', reviewer: 1, verdict: 'findings', findings: ['x'] }, { round: 2, review: 'pending' }],
    })
    const map = task('m', { kind: 'map', state: 'running', attempt: 1, over: 'a.result.items' })
    const children = [
      task('m.1', { parent: 'm', index: 1, state: 'running', attempt: 1, title: 'one' }),
      task('m.2', { parent: 'm', index: 2, state: 'done', attempt: 1, title: 'two' }),
    ]
    render(WorkflowScreen, {
      snapshot: snapshot([loop, map, ...children], { workers: { l: 'wl', 'm.1': 'w1' } }),
      statusOf: statuses({}),
      blocked: null,
      onopen: vi.fn(),
    })
    expect(screen.getByTestId('loop-round')).toHaveTextContent('Round 2/3')
    const nested = within(screen.getByTestId('map-children')).getAllByTestId('workflow-task')
    expect(nested.map((r) => r.dataset.taskId)).toEqual(['m.1', 'm.2'])
    expect(nested[0]).toBeEnabled()
    expect(nested[1]).toBeDisabled()
  })

  it('follows the highlight of each ask, and drops it when opened without a task', async () => {
    const props = { snapshot: GRAPH, statusOf: statuses({}), blocked: null, onopen: vi.fn() }
    const { rerender } = render(WorkflowScreen, { ...props, focusTask: { taskId: 'c' } })
    const focusedIds = () => screen.getAllByTestId('workflow-task').filter((r) => r.dataset.focused === 'true').map((r) => r.dataset.taskId)
    expect(focusedIds()).toEqual(['c'])
    await rerender({ ...props, focusTask: undefined })
    expect(focusedIds()).toEqual([])
  })

  it('scrolls once per ask, not again when the screen is shown again', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      const ask = { taskId: 'c' }
      const props = { snapshot: GRAPH, statusOf: statuses({}), blocked: null, onopen: vi.fn(), focusTask: ask }
      const { rerender } = render(WorkflowScreen, { ...props, visible: false })
      await Promise.resolve()
      expect(scroll).not.toHaveBeenCalled()
      await rerender({ ...props, visible: true })
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1))
      await rerender({ ...props, visible: false })
      await rerender({ ...props, visible: true })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(scroll).toHaveBeenCalledTimes(1)
      await rerender({ ...props, visible: true, focusTask: { taskId: 'c' } })
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2))
    } finally {
      scroll.mockRestore()
    }
  })

  it('highlights the task a push was about', () => {
    render(WorkflowScreen, { snapshot: GRAPH, statusOf: statuses({}), blocked: null, focusTask: { taskId: 'c' }, onopen: vi.fn() })
    const focused = screen.getAllByTestId('workflow-task').filter((r) => r.dataset.focused === 'true')
    expect(focused.map((r) => r.dataset.taskId)).toEqual(['c'])
  })
})
