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
import { WorkflowValidationError, parseNewWorkflow, type Workflow, type WorkflowLoopRound, type WorkflowTaskState } from '../../shared/workflow'

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
      expect(() => applyOps(wf.id, 1, [{ op: 'update', id: 'c', patch: { provider: 'claude' } }])).toThrow('ops[0].effort: only for provider "codex"')
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

  describe('loops and maps', () => {
    function makeKinds(): Workflow {
      return createWorkflow(
        P,
        LEAD,
        parseNewWorkflow({
          title: 'Kinds',
          goal: 'g',
          tasks: [
            { id: 'src', title: 'Source', brief: 'list' },
            { id: 'impl', title: 'Impl', kind: 'loop', brief: 'build', worktree: { branch: 'feat-impl' }, reviewer: { brief: 'review it', provider: 'codex', effort: 'high' } },
            { id: 'fix', title: 'Fix', kind: 'map', after: ['src'], over: 'src.result.items', brief: 'fix {{item}}', worktree: { branch: 'fix-{{index}}' } },
          ],
        }),
      )
    }

    /** The loop waiting after its last round's review found problems. */
    function notConverged(id: string, findings = ['x.ts:1 wrong']): Workflow {
      const wf = getWorkflow(id)!
      Object.assign(wf.tasks[1], {
        state: 'waiting',
        attempt: 1,
        reviewers: 3,
        rounds: [
          { round: 1, review: 'done', verdict: 'findings', findings: ['old'], reviewer: 1 },
          { round: 2, review: 'done', verdict: 'findings', findings, reviewer: 3, work: { summary: 'tried again', branch: 'feat-impl', changedFiles: ['x.ts'], steered: false, at: 'w' } },
        ],
      })
      wf.status = 'running'
      saveWorkflow(wf)
      return getWorkflow(id)!
    }

    function expand(id: string, n: number): Workflow {
      const wf = getWorkflow(id)!
      wf.status = 'running'
      wf.tasks[0].state = 'done'
      wf.tasks[2].state = 'running'
      for (let i = 1; i <= n; i++) {
        wf.tasks.push({ id: `fix.${i}`, title: `Item ${i}`, kind: 'agent', after: [], brief: `fix ${i}`, onFailure: 'escalate', state: 'queued', attempt: 0, steered: false, parent: 'fix', index: i, item: `item ${i}` })
      }
      saveWorkflow(wf)
      return getWorkflow(id)!
    }

    it('round-trips kind fields, loop rounds and map children', () => {
      const wf = makeKinds()
      expect(getWorkflow(wf.id)!.tasks[1]).toMatchObject({ reviewer: { brief: 'review it', provider: 'codex', effort: 'high' }, maxRounds: 3 })
      expect(getWorkflow(wf.id)!.tasks[2]).toMatchObject({ over: 'src.result.items', maxItems: 20 })
      const loaded = notConverged(wf.id)
      expect(loaded.tasks[1].reviewers).toBe(3)
      expect(loaded.tasks[1].rounds![1]).toEqual({
        round: 2,
        review: 'done',
        verdict: 'findings',
        findings: ['x.ts:1 wrong'],
        reviewer: 3,
        work: { summary: 'tried again', branch: 'feat-impl', changedFiles: ['x.ts'], steered: false, at: 'w' },
      })
      const expanded = expand(wf.id, 2)
      expect(expanded.tasks.map((t) => t.id)).toEqual(['src', 'impl', 'fix', 'fix.1', 'fix.2'])
      expect(expanded.tasks[4]).toMatchObject({ parent: 'fix', index: 2, item: 'item 2' })
      expect(getWorkflow(wf.id)).toEqual(expanded)
    })

    it('counts only top-level tasks against the cap', () => {
      const wf = makeKinds()
      expand(wf.id, 20)
      const adds = Array.from({ length: 37 }, (_, i) => ({ op: 'add' as const, task: { id: `x${i}`, title: 'X', kind: 'agent' as const, after: [], brief: 'x', onFailure: 'escalate' as const } }))
      expect(applyOps(wf.id, 1, adds).ok).toBe(true)
      expect(() => applyOps(wf.id, 2, [{ op: 'add', task: { id: 'one-too-many', title: 'X', kind: 'agent', after: [], brief: 'x', onFailure: 'escalate' } }])).toThrow(/at most 40 tasks/)
    })

    it('a map that failed before expanding can be updated and is queued again', () => {
      const wf = makeKinds()
      const failed = getWorkflow(wf.id)!
      Object.assign(failed.tasks[2], { state: 'failed', note: 'src reported no items', finishedAt: 'f' })
      failed.status = 'failed'
      saveWorkflow(failed)
      expect(applyOps(wf.id, 1, [{ op: 'update', id: 'fix', patch: { maxItems: 5 } }]).ok).toBe(true)
      const fix = getWorkflow(wf.id)!.tasks[2]
      expect(fix).toMatchObject({ state: 'queued', maxItems: 5 })
      expect(fix.note).toBeUndefined()
      expect(fix.finishedAt).toBeUndefined()
      expand(wf.id, 1)
      const v = getWorkflow(wf.id)!.version
      expect(() => applyOps(wf.id, v, [{ op: 'update', id: 'fix', patch: { maxItems: 4 } }])).toThrow(/only a queued task can be updated/)
    })

    it('re-checks the kind rules after an update', () => {
      const wf = makeKinds()
      expect(() => applyOps(wf.id, 1, [{ op: 'update', id: 'impl', patch: { worktree: null } }])).toThrow(/a review loop needs its own branch/)
      expect(() => applyOps(wf.id, 1, [{ op: 'update', id: 'src', patch: { maxRounds: 2 } }])).toThrow(/maxRounds: only for kind "loop"/)
      expect(() => applyOps(wf.id, 1, [{ op: 'update', id: 'fix', patch: { worktree: { branch: 'one-branch' } } }])).toThrow(/each child needs its own branch/)
      expect(applyOps(wf.id, 1, [{ op: 'update', id: 'impl', patch: { maxRounds: 5, reviewer: { brief: 'stricter' } } }]).ok).toBe(true)
      expect(getWorkflow(wf.id)!.tasks[1]).toMatchObject({ maxRounds: 5, reviewer: { brief: 'stricter' } })
    })

    it('a child can be updated while queued, but not moved in the graph or given map fields', () => {
      const wf = makeKinds()
      expand(wf.id, 2)
      expect(() => applyOps(wf.id, 1, [{ op: 'update', id: 'fix.1', patch: { after: ['src'] } }])).toThrow(/child of map "fix"/)
      expect(() => applyOps(wf.id, 1, [{ op: 'update', id: 'fix.1', patch: { maxItems: 3 } }])).toThrow(/maxItems: only for kind "map"/)
      expect(applyOps(wf.id, 1, [{ op: 'update', id: 'fix.1', patch: { brief: 'fix it better', model: 'opus' } }]).ok).toBe(true)
      expect(getWorkflow(wf.id)!.tasks[3]).toMatchObject({ brief: 'fix it better', model: 'opus', parent: 'fix' })
    })

    it('cancelling a map cascades to its unfinished children; cancelling a child leaves the rest', () => {
      const wf = expand(makeKinds().id, 3)
      wf.tasks[3].state = 'running'
      wf.tasks[4].state = 'done'
      wf.judgments = [{ taskId: 'fix.1', question: 'q', at: 't', delivered: false }]
      saveWorkflow(wf)
      applyOps(wf.id, 1, [{ op: 'cancel', id: 'fix.3' }])
      expect(getWorkflow(wf.id)!.tasks.map((t) => t.state)).toEqual(['done', 'queued', 'running', 'running', 'done', 'cancelled'])
      applyOps(wf.id, 2, [{ op: 'cancel', id: 'fix' }])
      const tasks = getWorkflow(wf.id)!.tasks
      expect(tasks.map((t) => [t.id, t.state, t.detached ?? false])).toEqual([
        ['src', 'done', false],
        ['impl', 'queued', false],
        ['fix', 'cancelled', false],
        ['fix.1', 'cancelled', true],
        ['fix.2', 'done', false],
        ['fix.3', 'cancelled', false],
      ])
      expect(getWorkflow(wf.id)!.judgments).toEqual([])
    })

    it('extend raises a running or waiting loop\'s cap up to 10', () => {
      const wf = makeKinds()
      expect(() => applyOps(wf.id, 1, [{ op: 'extend', id: 'impl', rounds: 2 }])).toThrow(/only a running or waiting loop can be extended/)
      expect(() => applyOps(wf.id, 1, [{ op: 'extend', id: 'src', rounds: 2 }])).toThrow(/not a review loop/)
      notConverged(wf.id)
      expect(applyOps(wf.id, 1, [{ op: 'extend', id: 'impl', rounds: 5 }]).ok).toBe(true)
      expect(getWorkflow(wf.id)!.tasks[1].maxRounds).toBe(8)
      expect(() => applyOps(wf.id, 2, [{ op: 'extend', id: 'impl', rounds: 3 }])).toThrow(/would have 11 rounds; at most 10/)
    })

    it('accept takes a loop that did not converge as done, with its findings', () => {
      const wf = makeKinds()
      expect(() => applyOps(wf.id, 1, [{ op: 'accept', id: 'impl' }])).toThrow(/only a review loop waiting because it didn't converge/)
      notConverged(wf.id, ['a', 'b'])
      applyOps(wf.id, 1, [{ op: 'accept', id: 'impl' }], new Date('2026-10-17T00:00:00Z'))
      const impl = getWorkflow(wf.id)!.tasks[1]
      expect(impl.state).toBe('done')
      expect(impl.result).toEqual({
        status: 'done',
        summary: 'Accepted by the lead with 2 open findings: tried again',
        branch: 'feat-impl',
        changedFiles: ['x.ts'],
        verdict: 'findings',
        findings: ['a', 'b'],
        steered: false,
        at: '2026-10-17T00:00:00.000Z',
        rounds: 2,
      })
      const other = makeKinds()
      notConverged(other.id)
      applyOps(other.id, 1, [{ op: 'accept', id: 'impl', summary: 'Good enough for now' }])
      expect(getWorkflow(other.id)!.tasks[1].result!.summary).toBe('Good enough for now')
    })

    it('retrying a loop whose reviewer failed keeps the worker and re-queues the reviewer', () => {
      const wf = makeKinds()
      const failed = getWorkflow(wf.id)!
      Object.assign(failed.tasks[1], {
        state: 'failed',
        attempt: 1,
        reviewers: 1,
        note: 'The reviewer failed: x',
        finishedAt: 'f',
        rounds: [{ round: 1, review: 'failed', reviewer: 1, note: 'x', finishedAt: 'f', work: { summary: 's', steered: false, at: 'a' } }],
      })
      failed.status = 'failed'
      saveWorkflow(failed)
      expect(() => applyOps(wf.id, 1, [{ op: 'retry', id: 'impl', brief: 'new' }])).toThrow(/retry a reviewer with no brief/)
      applyOps(wf.id, 1, [{ op: 'retry', id: 'impl' }])
      const impl = getWorkflow(wf.id)!.tasks[1]
      expect(impl).toMatchObject({ state: 'running', attempt: 1, reviewers: 1 })
      expect(impl.rounds![0]).toMatchObject({ review: 'queued', reviewer: 1 })
      expect(impl.history).toBeUndefined()
    })

    it('refuses a second lifecycle op on one task in a patch', () => {
      const wf = makeKinds()
      notConverged(wf.id)
      for (const second of [{ op: 'cancel' as const, id: 'impl' }, { op: 'accept' as const, id: 'impl' }, { op: 'extend' as const, id: 'impl', rounds: 1 }]) {
        expect(() => applyOps(wf.id, 1, [{ op: 'extend', id: 'impl', rounds: 1 }, second])).toThrow(
          `ops[1]: ops[0] (extend) already changes task "impl"; a patch takes one of extend, accept, cancel or retry per task`,
        )
      }
      expect(getWorkflow(wf.id)!.tasks[1]).toMatchObject({ state: 'waiting', maxRounds: 3 })
      expect(applyOps(wf.id, 1, [{ op: 'extend', id: 'impl', rounds: 1 }, { op: 'cancel', id: 'src' }]).ok).toBe(true)
    })

    it("accept keeps the items of the latest round that reported any", () => {
      const wf = makeKinds()
      const loaded = notConverged(wf.id)
      loaded.tasks[1].rounds![0].work = { summary: 'first', items: ['a', 'b'], steered: false, at: 'w0' }
      saveWorkflow(loaded)
      applyOps(wf.id, 1, [{ op: 'accept', id: 'impl' }])
      expect(getWorkflow(wf.id)!.tasks[1].result!.items).toEqual(['a', 'b'])
    })

    it('retrying a loop whose worker was lost during review is a fresh attempt, and may take a brief', () => {
      const wf = makeKinds()
      const failed = getWorkflow(wf.id)!
      Object.assign(failed.tasks[1], {
        state: 'failed',
        attempt: 1,
        reviewers: 1,
        note: 'The worker session ended without reporting a result.',
        rounds: [{ round: 1, review: 'failed', reviewer: 1, workerLost: true, note: 'lost', work: { summary: 's', steered: false, at: 'a' } }],
      })
      failed.status = 'failed'
      saveWorkflow(failed)
      applyOps(wf.id, 1, [{ op: 'retry', id: 'impl', brief: 'start over' }])
      const impl = getWorkflow(wf.id)!.tasks[1]
      expect(impl).toMatchObject({ state: 'queued', brief: 'start over', history: [expect.objectContaining({ attempt: 1, rounds: 1 })] })
      expect(impl.rounds).toBeUndefined()
    })

    it('warns about malformed stored rounds instead of dropping them silently', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const wf = makeKinds()
      const loaded = getWorkflow(wf.id)!
      loaded.tasks[1].rounds = [{ round: 1, review: 'pending' }, { round: 2, review: 'bogus' } as unknown as WorkflowLoopRound]
      saveWorkflow(loaded)
      expect(getWorkflow(wf.id)!.tasks[1].rounds).toEqual([{ round: 1, review: 'pending' }])
      expect(warn).toHaveBeenCalledWith(`[Workflows] ${wf.id}/impl: dropped 1 malformed loop round(s) from the database`)
      warn.mockRestore()
    })
  })
})
