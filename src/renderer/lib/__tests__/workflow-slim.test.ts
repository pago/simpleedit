import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_MAX_BRIEF,
  WORKFLOW_MAX_FINDINGS,
  WORKFLOW_MAX_GOAL,
  WORKFLOW_MAX_HISTORY,
  WORKFLOW_MAX_LOOP_ROUNDS,
  WORKFLOW_MAX_MAP_ITEMS,
  WORKFLOW_MAX_OPS,
  WORKFLOW_MAX_SUMMARY,
  WORKFLOW_MAX_TASKS,
  WORKFLOW_MAX_TITLE,
  slimWorkflowSnapshot,
  type WorkflowLoopRound,
  type WorkflowSnapshot,
  type WorkflowTask,
  type WorkflowTaskResult,
  type WorkflowTaskState,
} from '../../../shared/workflow'
import type { AgentStatus } from '../../../shared/ipc-types'
import { defaultSlot, leadProgress, needsYou, popupSlots, statusLine, taskCards } from '../workflow-view'

/** Text of `n` characters whose first line is longer than any one-line view shows. */
function text(n: number, tag: string): string {
  return `${tag} ${'a'.repeat(150)}\n${'b'.repeat(n)}`.slice(0, n)
}

const title = (tag: string): string => `${tag} ${'t'.repeat(WORKFLOW_MAX_TITLE)}`.slice(0, WORKFLOW_MAX_TITLE)
const AT = '2026-10-17T10:00:00.000Z'

function result(tag: string, extra: Partial<WorkflowTaskResult> = {}): WorkflowTaskResult {
  return {
    status: 'done',
    summary: text(WORKFLOW_MAX_SUMMARY, tag),
    branch: `feat/${tag}`,
    changedFiles: Array.from({ length: 200 }, (_, i) => `src/some/deep/path/${tag}/file-${i}.ts`),
    items: Array.from({ length: WORKFLOW_MAX_MAP_ITEMS }, (_, i) => text(500, `item ${i}`)),
    steered: false,
    at: AT,
    ...extra,
  }
}

const findings = (tag: string): string[] => Array.from({ length: WORKFLOW_MAX_FINDINGS }, (_, i) => text(500, `${tag} finding ${i}`))

function base(id: string, state: WorkflowTaskState, extra: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id,
    title: title(id),
    kind: 'agent',
    after: [],
    brief: text(WORKFLOW_MAX_BRIEF, `brief ${id}`),
    acceptance: text(4_000, `acceptance ${id}`),
    onFailure: 'retry',
    state,
    attempt: state === 'queued' ? 0 : 2,
    steered: false,
    worktree: { branch: `feat/${id}` },
    history: Array.from({ length: WORKFLOW_MAX_HISTORY }, (_, i) => ({ attempt: i + 1, result: result(`${id} h${i}`), note: text(4_000, 'old note') })),
    ...extra,
  }
}

const STATES: WorkflowTaskState[] = ['done', 'running', 'waiting', 'failed', 'queued', 'cancelled']

function round(n: number, review: WorkflowLoopRound['review'], tag: string): WorkflowLoopRound {
  return {
    round: n,
    work: { summary: text(WORKFLOW_MAX_SUMMARY, `${tag} work`), branch: `feat/${tag}`, changedFiles: result(tag).changedFiles, items: result(tag).items, steered: false, at: AT },
    review,
    reviewer: n,
    ...(review === 'done' ? { verdict: 'findings' as const, findings: findings(tag), reviewerSummary: text(WORKFLOW_MAX_SUMMARY, `${tag} review`) } : {}),
    note: text(1_000, `${tag} round note`),
    startedAt: AT,
  }
}

/** The largest workflow the engine admits, with every long field at its cap. */
function worstCase(): WorkflowSnapshot {
  const tasks: WorkflowTask[] = []
  const workers: Record<string, string> = {}
  const reviewers: Record<string, string> = {}
  for (let i = 0; i < WORKFLOW_MAX_TASKS; i++) {
    const id = `t${i}`
    const state = STATES[i % STATES.length]!
    const after = i > 0 ? [`t${i - 1}`] : []
    if (i < 2) {
      const map = base(id, 'running', { kind: 'map', over: 't39.result.items', after })
      tasks.push(map)
      for (let c = 1; c <= WORKFLOW_MAX_MAP_ITEMS; c++) {
        const childState = STATES[c % STATES.length]!
        const child = base(`${id}.${c}`, childState, {
          parent: id,
          index: c,
          item: text(500, `item ${c}`),
          ...(childState === 'done' ? { result: result(`${id}.${c}`) } : {}),
          ...(childState === 'waiting' ? { note: 'Turn ended without report_result: the worker may be asking you something.' } : {}),
          ...(childState === 'failed' ? { note: text(4_000, 'failure') } : {}),
        })
        tasks.push(child)
        if (childState === 'running' || childState === 'waiting') workers[child.id] = `term-${child.id}`
      }
      continue
    }
    if (i < 22) {
      const rounds = Array.from({ length: WORKFLOW_MAX_LOOP_ROUNDS }, (_, r) => round(r + 1, 'done', `${id}r${r}`))
      const last = i % 3 === 0 ? 'running' : i % 3 === 1 ? 'pending' : 'waiting'
      rounds[rounds.length - 1] = round(WORKFLOW_MAX_LOOP_ROUNDS, last, `${id}last`)
      const loopState: WorkflowTaskState = last === 'waiting' ? 'waiting' : i % 4 === 0 ? 'done' : 'running'
      tasks.push(
        base(id, loopState, {
          kind: 'loop',
          after,
          maxRounds: WORKFLOW_MAX_LOOP_ROUNDS,
          reviewer: { brief: text(WORKFLOW_MAX_BRIEF, 'reviewer brief') },
          reviewers: WORKFLOW_MAX_LOOP_ROUNDS,
          rounds,
          ...(loopState === 'done' ? { result: result(id, { verdict: 'findings', findings: findings(id), rounds: WORKFLOW_MAX_LOOP_ROUNDS }) } : {}),
          ...(loopState === 'waiting' ? { note: 'The reviewer ended its turn without a verdict: it may be asking you something.' } : {}),
        }),
      )
      workers[id] = `term-${id}`
      reviewers[id] = `term-${id}~r`
      continue
    }
    tasks.push(
      base(id, state, {
        after,
        ...(state === 'done' ? { result: result(id) } : {}),
        ...(state === 'waiting' ? { note: 'Turn ended without report_result: the worker may be asking you something.' } : {}),
        ...(state === 'failed' ? { note: text(4_000, 'failure'), result: result(id, { status: 'failed' }) } : {}),
        ...(state === 'cancelled' ? { cancelledBy: 3, detached: true } : {}),
        ...(i % 5 === 0 ? { addedBy: 2 } : {}),
      }),
    )
    if (state === 'running' || state === 'waiting') workers[id] = `term-${id}`
  }
  const patches = Array.from({ length: 40 }, (_, v) => ({
    version: v + 2,
    at: AT,
    ops: Array.from({ length: WORKFLOW_MAX_OPS }, (_, o) => ({
      op: 'add' as const,
      task: { id: `p${v}x${o}`, title: title('patched'), kind: 'agent' as const, after: [], brief: text(WORKFLOW_MAX_BRIEF, 'patched'), onFailure: 'retry' as const },
    })),
  }))
  return {
    workflow: {
      id: 'wf_worstcase',
      project: '/repo/project.git',
      leadKey: 'lead-session',
      leadLabel: 'Lead',
      title: title('flow'),
      goal: text(WORKFLOW_MAX_GOAL, 'goal'),
      version: 42,
      status: 'running',
      tasks,
      patches,
      judgments: ['t5', 't23', 't1.4'].map((taskId) => ({ taskId, question: text(WORKFLOW_MAX_SUMMARY + 200, `question ${taskId}`), at: AT, delivered: taskId === 't5' })),
      createdAt: AT,
      startedAt: AT,
    },
    paused: null,
    workers,
    reviewers,
  }
}

/** Some live sessions asking, some stopped, the rest running. */
function statusOf(terminalId: string): AgentStatus {
  const n = Number(/\d+/.exec(terminalId)?.[0] ?? 0)
  return n % 7 === 0 ? 'waiting' : n % 11 === 0 ? 'exited' : 'running'
}

describe('slimWorkflowSnapshot', () => {
  it('keeps the worst-case workflow under 64 KB', () => {
    const full = worstCase()
    const slim = slimWorkflowSnapshot(full)
    expect(JSON.stringify(full).length).toBeGreaterThan(5_000_000)
    expect(JSON.stringify(slim).length).toBeLessThan(64 * 1024)
  })

  it('gives every view the same answer as the full snapshot', () => {
    const full = worstCase()
    const slim = slimWorkflowSnapshot(full)
    expect(taskCards(slim, statusOf)).toEqual(taskCards(full, statusOf))
    expect(needsYou(slim, statusOf)).toEqual(needsYou(full, statusOf))
    expect(statusLine(slim)).toEqual(statusLine(full))
    expect(leadProgress([slim], statusOf)).toEqual(leadProgress([full], statusOf))
    for (const task of full.workflow.tasks) {
      expect(defaultSlot(slim.workflow, task.id)).toBe(defaultSlot(full.workflow, task.id))
      const strip = (slots: ReturnType<typeof popupSlots>) => slots.map(({ task: _task, round: _round, ...rest }) => rest)
      expect(strip(popupSlots(slim, task.id, statusOf))).toEqual(strip(popupSlots(full, task.id, statusOf)))
    }
  })

  it('drops what only the desktop shows, and marks the copy', () => {
    const slim = slimWorkflowSnapshot(worstCase())
    expect(slim.slim).toBe(true)
    const loop = slim.workflow.tasks.find((t) => t.kind === 'loop' && t.result)!
    expect(loop.brief).toBe('')
    expect(loop.reviewer?.brief).toBe('')
    expect(loop.acceptance).toBeUndefined()
    expect(loop.history).toBeUndefined()
    expect(loop.result?.changedFiles).toBeUndefined()
    expect(loop.result?.items).toBeUndefined()
    // Counts survive: the cards show "n open findings".
    expect(loop.result?.findings).toHaveLength(WORKFLOW_MAX_FINDINGS)
    expect(loop.rounds!.length).toBeLessThanOrEqual(2)
    expect(slim.workflow.patches).toHaveLength(40)
    expect(slim.workflow.patches.every((p) => p.ops.length === 0)).toBe(true)
  })

  it('leaves short text alone and the full snapshot untouched', () => {
    const full = worstCase()
    const before = JSON.stringify(full)
    const slim = slimWorkflowSnapshot(full)
    expect(JSON.stringify(full)).toBe(before)
    const waiting = slim.workflow.tasks.find((t) => t.state === 'waiting' && t.kind === 'agent')!
    expect(waiting.note).toBe('Turn ended without report_result: the worker may be asking you something.')
    expect(slim.workflow.goal.length).toBeLessThan(400)
  })
})
