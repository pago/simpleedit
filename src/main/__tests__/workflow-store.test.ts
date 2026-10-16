import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import {
  applyOps,
  applyOpsTo,
  archiveWorkflow,
  createWorkflow,
  getWorkflow,
  listLiveWorkflows,
  listWorkflows,
  rekeyLead,
  saveWorkflow,
} from '../workflow-store'
import { WorkflowValidationError, parseNewWorkflow, type Workflow, type WorkflowTaskState } from '../../shared/workflow'

const P = '/repo/project.git'
const LEAD = { key: 'lead-session', label: 'Lead' }

function make(project = P): Workflow {
  return createWorkflow(
    project,
    LEAD,
    parseNewWorkflow({
      title: 'Ship it',
      goal: 'Ship the feature',
      tasks: [
        { id: 'a', title: 'A', brief: 'do a', worktree: { branch: 'feat-a' } },
        { id: 'b', title: 'B', brief: 'do b after {{task.a.result.summary}}', after: ['a'], onFailure: 'retry' },
        { id: 'c', title: 'C', brief: 'do c', provider: 'codex', effort: 'high' },
      ],
    }),
    new Date('2026-10-16T10:00:00Z'),
  )
}

function setState(id: string, taskId: string, state: WorkflowTaskState, extra: Partial<Workflow> = {}): Workflow {
  const wf = getWorkflow(id)!
  wf.tasks.find((t) => t.id === taskId)!.state = state
  Object.assign(wf, extra)
  saveWorkflow(wf)
  return getWorkflow(id)!
}

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
})

describe('workflow store', () => {
  it('round-trips a created workflow', () => {
    const created = make()
    expect(created.id).toMatch(/^wf_/)
    expect(created.status).toBe('draft')
    expect(created.version).toBe(1)
    const loaded = getWorkflow(created.id)
    expect(loaded).toEqual(created)
    expect(loaded!.tasks.map((t) => [t.id, t.state, t.attempt, t.steered])).toEqual([
      ['a', 'queued', 0, false],
      ['b', 'queued', 0, false],
      ['c', 'queued', 0, false],
    ])
    expect(loaded!.tasks[0].worktree).toEqual({ branch: 'feat-a' })
    expect(loaded!.tasks[2]).toMatchObject({ provider: 'codex', effort: 'high' })
    expect(listWorkflows(P).map((w) => w.id)).toEqual([created.id])
    expect(listWorkflows('/other.git')).toEqual([])
  })

  it('round-trips engine-written task fields', () => {
    const wf = make()
    const a = wf.tasks[0]
    Object.assign(a, {
      state: 'done',
      attempt: 2,
      steered: true,
      note: 'n',
      worktreePath: '/wt/feat-a',
      startedAt: 's',
      finishedAt: 'f',
      result: { status: 'done', summary: 'did', steered: true, at: 'f' },
      history: [{ attempt: 1, note: 'first try broke', result: { status: 'failed', summary: 'broke', steered: false, at: 'e' }, finishedAt: 'e' }],
    })
    wf.status = 'running'
    wf.judgments = [{ taskId: 'b', question: 'q', at: 't', delivered: true }]
    saveWorkflow(wf)
    expect(getWorkflow(wf.id)).toEqual(wf)
  })

  it('lists only running and failed workflows as live', () => {
    const draft = make()
    const running = make()
    setState(running.id, 'a', 'queued', { status: 'running' })
    const failed = make()
    setState(failed.id, 'a', 'failed', { status: 'failed' })
    const ids = listLiveWorkflows().map((w) => w.id)
    expect(ids).toEqual(expect.arrayContaining([running.id, failed.id]))
    expect(ids).not.toContain(draft.id)
  })

  it('archive hides a workflow from every list', () => {
    const wf = make()
    setState(wf.id, 'a', 'queued', { status: 'running' })
    expect(archiveWorkflow(wf.id)).toBe(true)
    expect(archiveWorkflow(wf.id)).toBe(false)
    expect(getWorkflow(wf.id)).toBeNull()
    expect(listWorkflows(P)).toEqual([])
    expect(listLiveWorkflows()).toEqual([])
  })

  describe('applyOps', () => {
    it('records the patch and bumps the version', () => {
      const wf = make()
      const result = applyOps(wf.id, 1, [{ op: 'add', task: { id: 'd', title: 'D', kind: 'agent', after: ['c'], brief: 'd', onFailure: 'escalate' } }], new Date('2026-10-16T11:00:00Z'))
      expect(result.ok).toBe(true)
      const loaded = getWorkflow(wf.id)!
      expect(loaded.version).toBe(2)
      expect(loaded.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
      expect(loaded.tasks[3]).toMatchObject({ state: 'queued', attempt: 0, addedBy: 2 })
      expect(loaded.patches).toEqual([{ version: 2, at: '2026-10-16T11:00:00.000Z', ops: [expect.objectContaining({ op: 'add' })] }])
      if (result.ok) expect(result.workflow).toEqual(loaded)
    })

    it('answers a stale baseVersion with a conflict and writes nothing', () => {
      const wf = make()
      applyOps(wf.id, 1, [{ op: 'cancel', id: 'c' }])
      const result = applyOps(wf.id, 1, [{ op: 'cancel', id: 'a' }])
      expect(result).toEqual({ ok: false, conflict: { version: 2 } })
      expect(getWorkflow(wf.id)!.tasks[0].state).toBe('queued')
    })

    it('throws for an unknown workflow', () => {
      expect(() => applyOps('wf_missing123', 1, [{ op: 'cancel', id: 'a' }])).toThrow(WorkflowValidationError)
    })

    it('updates only a queued task, and null clears a field', () => {
      const wf = make()
      setState(wf.id, 'a', 'running', { status: 'running' })
      expect(() => applyOps(wf.id, 1, [{ op: 'update', id: 'a', patch: { title: 'X' } }])).toThrow(/only a queued task can be updated/)
      const ok = applyOps(wf.id, 1, [{ op: 'update', id: 'c', patch: { title: 'C2', effort: null, provider: 'claude' } }])
      expect(ok.ok).toBe(true)
      const c = getWorkflow(wf.id)!.tasks[2]
      expect(c.title).toBe('C2')
      expect(c.effort).toBeUndefined()
      expect(c.provider).toBe('claude')
    })

    it('refuses an update that leaves effort on a claude task', () => {
      const wf = make()
      expect(() => applyOps(wf.id, 1, [{ op: 'update', id: 'c', patch: { provider: 'claude' } }])).toThrow(/effort is only for provider "codex"/)
    })

    it('cancelling a running task detaches it', () => {
      const wf = make()
      setState(wf.id, 'a', 'running', { status: 'running' })
      applyOps(wf.id, 1, [{ op: 'cancel', id: 'a' }, { op: 'cancel', id: 'c' }], new Date('2026-10-16T12:00:00Z'))
      const [a, , c] = getWorkflow(wf.id)!.tasks
      expect(a).toMatchObject({ state: 'cancelled', detached: true, cancelledBy: 2, finishedAt: '2026-10-16T12:00:00.000Z' })
      expect(c.state).toBe('cancelled')
      expect(c.detached).toBeUndefined()
    })

    it('refuses cancelling a done task', () => {
      const wf = make()
      setState(wf.id, 'a', 'done', { status: 'running' })
      expect(() => applyOps(wf.id, 1, [{ op: 'cancel', id: 'a' }])).toThrow(/already done/)
    })

    it('retries only a failed task, optionally with a new brief', () => {
      const wf = make()
      expect(() => applyOps(wf.id, 1, [{ op: 'retry', id: 'a' }])).toThrow(/only a failed task can be retried/)
      const failed = getWorkflow(wf.id)!
      Object.assign(failed.tasks[0], { state: 'failed', attempt: 1, note: 'boom', finishedAt: 'x', result: { status: 'failed', summary: 'boom', steered: false, at: 'x' } })
      failed.status = 'running'
      saveWorkflow(failed)
      applyOps(wf.id, 1, [{ op: 'retry', id: 'a', brief: 'try harder' }])
      const a = getWorkflow(wf.id)!.tasks[0]
      expect(a.state).toBe('queued')
      expect(a.brief).toBe('try harder')
      expect(a.result).toBeUndefined()
      expect(a.note).toBeUndefined()
      expect(a.finishedAt).toBeUndefined()
      expect(a.history).toEqual([{ attempt: 1, note: 'boom', finishedAt: 'x', result: { status: 'failed', summary: 'boom', steered: false, at: 'x' } }])
    })

    it('moves a lead\'s workflows to a new key, leaving others and dismissed ones alone', () => {
      const mine = make()
      const dismissed = make()
      archiveWorkflow(dismissed.id)
      expect(rekeyLead(mine.leadKey, 'successor')).toEqual([mine.id])
      expect(getWorkflow(mine.id)!.leadKey).toBe('successor')
      expect(rekeyLead('nobody', 'x')).toEqual([])
    })

    it('a refused op writes nothing, even with valid ops beside it', () => {
      const wf = make()
      const before = getWorkflow(wf.id)
      let error: unknown
      try {
        applyOps(wf.id, 1, [
          { op: 'add', task: { id: 'd', title: 'D', kind: 'agent', after: [], brief: 'd', onFailure: 'escalate' } },
          { op: 'cancel', id: 'c' },
          { op: 'retry', id: 'a' },
          { op: 'update', id: 'zzz', patch: {} },
        ])
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(WorkflowValidationError)
      expect((error as WorkflowValidationError).problems).toEqual([
        'ops[2]: task "a" is queued; only a failed task can be retried',
        'ops[3]: no task "zzz"',
      ])
      expect(getWorkflow(wf.id)).toEqual(before)
    })

    it('refuses an add that breaks the graph', () => {
      const wf = make()
      expect(() =>
        applyOps(wf.id, 1, [
          { op: 'add', task: { id: 'a', title: 'dup', kind: 'agent', after: [], brief: 'x', onFailure: 'escalate' } },
          { op: 'add', task: { id: 'e', title: 'E', kind: 'agent', after: ['ghost'], brief: 'x', onFailure: 'escalate' } },
        ]),
      ).toThrow(WorkflowValidationError)
      expect(() => applyOps(wf.id, 1, [{ op: 'update', id: 'a', patch: { after: ['b'] } }])).toThrow(/cycle/)
      expect(getWorkflow(wf.id)!.version).toBe(1)
    })

    it('a failed workflow becomes running again on a patch', () => {
      const wf = make()
      setState(wf.id, 'a', 'failed', { status: 'failed', finishedAt: '2026-10-16T13:00:00Z' })
      applyOps(wf.id, 1, [{ op: 'retry', id: 'a' }])
      const loaded = getWorkflow(wf.id)!
      expect(loaded.status).toBe('running')
      expect(loaded.finishedAt).toBeUndefined()
    })

    it('refuses to patch a done or cancelled workflow', () => {
      const wf = make()
      setState(wf.id, 'a', 'queued', { status: 'cancelled' })
      expect(() => applyOps(wf.id, 1, [{ op: 'cancel', id: 'a' }])).toThrow(/can't be patched/)
    })

    it('clears judgments for the tasks a patch touched', () => {
      const wf = make()
      const loaded = setState(wf.id, 'a', 'failed', {
        status: 'running',
        judgments: [
          { taskId: 'a', question: 'qa', at: 't', delivered: true },
          { taskId: 'c', question: 'qc', at: 't', delivered: false },
        ],
      })
      expect(loaded.judgments).toHaveLength(2)
      applyOps(wf.id, 1, [{ op: 'retry', id: 'a' }])
      expect(getWorkflow(wf.id)!.judgments.map((j) => j.taskId)).toEqual(['c'])
    })

    it('applyOpsTo is pure', () => {
      const wf = make()
      const next = applyOpsTo(wf, [{ op: 'cancel', id: 'c' }])
      expect(next.version).toBe(2)
      expect(wf.tasks[2].state).toBe('queued')
      expect(getWorkflow(wf.id)!.version).toBe(1)
    })
  })
})
