import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initWorkflowListeners, phoneWorkflows } from '../workflows.svelte'
import type { AgentStatusEvent } from '../../../shared/ipc-types'
import type { WorkflowList, WorkflowSnapshot } from '../../../shared/workflow'

function snapshot(id: string, extra: Partial<WorkflowSnapshot> = {}, project = '/repo/p.git'): WorkflowSnapshot {
  return {
    workflow: {
      id,
      project,
      leadKey: 'lead',
      leadLabel: 'Lead',
      title: id,
      goal: '',
      version: 1,
      status: 'running',
      tasks: [],
      patches: [],
      judgments: [],
      createdAt: '2026-10-16T00:00:00.000Z',
    },
    paused: null,
    workers: {},
    reviewers: {},
    ...extra,
  }
}

type Handler = (payload: never) => void
let handlers: Record<string, Handler>
let list: WorkflowList

function emit(channel: 'workflow:changed', payload: WorkflowSnapshot): void
function emit(channel: 'agent:status', payload: AgentStatusEvent): void
function emit(channel: string, payload: unknown): void {
  handlers[channel](payload as never)
}

beforeEach(() => {
  phoneWorkflows._reset()
  handlers = {}
  list = { project: '/repo/p.git', workflows: [snapshot('wf_1', { workers: { a: 'w' }, statuses: { w: 'running' } })] }
  vi.stubGlobal('api', {
    invoke: vi.fn(async (channel: string) => (channel === 'workflow:list' ? list : undefined)),
    on: (channel: string, handler: Handler) => {
      handlers[channel] = handler
      return () => {}
    },
  })
  initWorkflowListeners()
})

describe('the phone workflow mirror', () => {
  it("ignores broadcasts until the list has said which project it is", async () => {
    emit('workflow:changed', snapshot('wf_early'))
    expect(phoneWorkflows.all()).toEqual([])
    await phoneWorkflows.load()
    expect(phoneWorkflows.loaded()).toBe(true)
    expect(phoneWorkflows.all().map((w) => w.workflow.id)).toEqual(['wf_1'])
  })

  it("keeps its own project's workflows and drops a dismissed one", async () => {
    await phoneWorkflows.load()
    emit('workflow:changed', snapshot('wf_other', {}, '/repo/other.git'))
    emit('workflow:changed', snapshot('wf_2'))
    expect(phoneWorkflows.all().map((w) => w.workflow.id)).toEqual(['wf_1', 'wf_2'])
    emit('workflow:changed', snapshot('wf_1', { dismissed: true }))
    expect(phoneWorkflows.all().map((w) => w.workflow.id)).toEqual(['wf_2'])
  })

  it('reads statuses from the snapshot, and a live agent:status over it until the next load', async () => {
    await phoneWorkflows.load()
    expect(phoneWorkflows.statusOf('w')).toBe('running')
    expect(phoneWorkflows.statusOf('unknown')).toBe('idle')
    emit('agent:status', { terminalId: 'w', status: 'waiting', worktreePath: '', precise: true })
    expect(phoneWorkflows.statusOf('w')).toBe('waiting')
    await phoneWorkflows.load()
    expect(phoneWorkflows.statusOf('w')).toBe('running')
  })

  it('replaces everything on a load, as a switch of project does', async () => {
    await phoneWorkflows.load()
    list = { project: '/repo/other.git', workflows: [snapshot('wf_x', {}, '/repo/other.git')] }
    await phoneWorkflows.load()
    expect(phoneWorkflows.all().map((w) => w.workflow.id)).toEqual(['wf_x'])
    emit('workflow:changed', snapshot('wf_2'))
    expect(phoneWorkflows.get('wf_2')).toBeUndefined()
  })

  it('is not loaded while a load is out, and drops another window\'s list at once', async () => {
    await phoneWorkflows.load(1)
    let answer: (value: WorkflowList) => void = () => {}
    vi.mocked(window.api.invoke).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve as never }))
    const sameWindow = phoneWorkflows.load(1)
    expect(phoneWorkflows.loaded()).toBe(false)
    expect(phoneWorkflows.all().map((w) => w.workflow.id)).toEqual(['wf_1'])
    answer(list)
    await sameWindow
    vi.mocked(window.api.invoke).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve as never }))
    const otherWindow = phoneWorkflows.load(2)
    expect(phoneWorkflows.loaded()).toBe(false)
    expect(phoneWorkflows.all()).toEqual([])
    answer({ project: '/repo/other.git', workflows: [] })
    await otherWindow
    expect(phoneWorkflows.loaded()).toBe(true)
  })

  it('keeps live statuses only for terminals a workflow names, and forgets an exited one', async () => {
    await phoneWorkflows.load()
    emit('agent:status', { terminalId: 'stranger', status: 'waiting', worktreePath: '', precise: true })
    expect(phoneWorkflows.statusOf('stranger')).toBe('idle')
    emit('agent:status', { terminalId: 'w', status: 'waiting', worktreePath: '', precise: true })
    expect(phoneWorkflows.statusOf('w')).toBe('waiting')
    emit('agent:status', { terminalId: 'w', status: 'exited', worktreePath: '', precise: true })
    expect(phoneWorkflows.statusOf('w')).toBe('running')
  })

  it('reports a failed load, so a waiting push tap is answered, and clears it on the next', async () => {
    vi.mocked(window.api.invoke).mockRejectedValueOnce(new Error('Not connected'))
    await phoneWorkflows.load(1)
    expect(phoneWorkflows.loaded()).toBe(false)
    expect(phoneWorkflows.failed()).toBe(true)
    await phoneWorkflows.load(1)
    expect(phoneWorkflows.failed()).toBe(false)
    expect(phoneWorkflows.loaded()).toBe(true)
  })

  it('is unloaded the moment the phone leaves the window, until the next list', async () => {
    await phoneWorkflows.load(1)
    phoneWorkflows.unload()
    expect(phoneWorkflows.loaded()).toBe(false)
    await phoneWorkflows.load(2)
    expect(phoneWorkflows.loaded()).toBe(true)
  })

  it("forgets a dismissed workflow's live statuses, since a detached worker never exits", async () => {
    await phoneWorkflows.load()
    emit('workflow:changed', snapshot('wf_2', { workers: { b: 'w2' } }))
    emit('agent:status', { terminalId: 'w', status: 'waiting', worktreePath: '', precise: true })
    emit('agent:status', { terminalId: 'w2', status: 'waiting', worktreePath: '', precise: true })
    emit('workflow:changed', snapshot('wf_1', { dismissed: true }))
    expect(phoneWorkflows.statusOf('w')).toBe('idle')
    expect(phoneWorkflows.statusOf('w2')).toBe('waiting')
  })
})
