import { describe, it, expect } from 'vitest'
import type { AgentStatus } from '../../../shared/ipc-types'
import type { Workflow, WorkflowSnapshot, WorkflowTask } from '../../../shared/workflow'
import { ledBy, pickForLead, slotTerminal, taskTerminal, windowBlocker, workerSessions } from '../workflow-phone'

function task(id: string, extra: Partial<WorkflowTask> = {}): WorkflowTask {
  return { id, title: `Task ${id}`, kind: 'agent', after: [], brief: '', onFailure: 'escalate', state: 'running', attempt: 1, steered: false, ...extra }
}

function snapshot(id: string, tasks: WorkflowTask[], extra: Partial<WorkflowSnapshot> = {}, workflow: Partial<Workflow> = {}): WorkflowSnapshot {
  return {
    workflow: {
      id,
      project: '/repo/p.git',
      leadKey: 'lead',
      leadLabel: 'Lead',
      title: id,
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
    leadTerminalId: 'lead-t',
    leadWindowId: 1,
    ...extra,
  }
}

const idle = (): AgentStatus => 'idle'

describe('the session a worker is shown with', () => {
  it("is named for its task and role, and carries the workflow's owner", () => {
    const loop = task('l', { kind: 'loop', reviewers: 2, worktreePath: '/repo/wt/l', reviewer: { brief: '', provider: 'codex' } })
    const sessions = workerSessions([snapshot('wf_1', [loop], { workers: { l: 'w' }, reviewers: { l: 'r' } })], (id) => (id === 'r' ? 'waiting' : 'running'))
    expect(sessions.w).toMatchObject({ label: 'Task l · Worker', provider: 'claude', status: 'running', worktreePath: '/repo/wt/l' })
    expect(sessions.w.trail).toEqual([{ repoPath: '/repo/p.git', worktrees: ['/repo/wt/l'] }])
    expect(sessions.r).toMatchObject({ label: 'Task l · Reviewer', provider: 'codex', status: 'waiting' })
    expect(sessions.r.owner).toEqual({ kind: 'workflow', workflowId: 'wf_1', taskId: 'l', attempt: 1, review: 2 })
  })

  it('exists only for a live terminal', () => {
    expect(workerSessions([snapshot('wf_1', [task('a')])], idle)).toEqual({})
  })
})

describe('which terminal a row opens', () => {
  it("is a loop's reviewer while it reviews, else its worker", () => {
    const reviewing = task('l', { kind: 'loop', reviewers: 1, rounds: [{ round: 1, review: 'running', reviewer: 1 }] })
    const snap = snapshot('wf_1', [reviewing], { workers: { l: 'w' }, reviewers: { l: 'r' } })
    expect(taskTerminal(snap, 'l')).toBe('r')
    expect(slotTerminal(snap, 'l')).toBe('w')
    expect(taskTerminal(snapshot('wf_1', [task('a')]), 'a')).toBeNull()
  })
})

describe("a lead's workflow", () => {
  it('is matched by the live terminal main names as its lead', () => {
    const mine = snapshot('wf_1', [])
    expect(ledBy([mine, snapshot('wf_2', [], { leadTerminalId: 'other' })], 'lead-t')).toEqual([mine])
  })

  it('opens the one that needs the user, else the newest unfinished one', () => {
    const older = snapshot('wf_old', [task('a', { state: 'waiting' })], { workers: { a: 'wa' } }, { createdAt: '2026-10-01T00:00:00.000Z' })
    const newer = snapshot('wf_new', [task('b')], {}, { createdAt: '2026-10-10T00:00:00.000Z' })
    const done = snapshot('wf_done', [], {}, { status: 'done', createdAt: '2026-10-12T00:00:00.000Z' })
    expect(pickForLead([older, newer, done], idle)?.workflow.id).toBe('wf_old')
    const calm = snapshot('wf_old', [task('a')], {}, { createdAt: '2026-10-01T00:00:00.000Z' })
    expect(pickForLead([calm, newer, done], idle)?.workflow.id).toBe('wf_new')
    expect(pickForLead([done], idle)?.workflow.id).toBe('wf_done')
  })
})

describe('opening terminals from this phone', () => {
  it("needs the phone joined to the lead's window", () => {
    expect(windowBlocker({ leadWindowId: 1 }, 1)).toBeNull()
    expect(windowBlocker({ leadWindowId: 2 }, 1, { lead: 'api', here: 'web' })).toBe(
      'This workflow runs in api, and this phone is showing web. Switch project to open its terminals.',
    )
    expect(windowBlocker({ leadWindowId: null }, 1)).toMatch(/isn’t open/)
  })
})
