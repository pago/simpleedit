import { describe, it, expect } from 'vitest'
import type { AgentStatus } from '../../../shared/ipc-types'
import type { Workflow, WorkflowSnapshot, WorkflowTask } from '../../../shared/workflow'
import { canCancel, canDismiss, canStart, leadProgress, needsYou, statusLine, taskCard, taskCards } from '../workflow-view'

function task(id: string, extra: Partial<WorkflowTask> = {}): WorkflowTask {
  return { id, title: `Task ${id}`, kind: 'agent', after: [], brief: `Do ${id}`, onFailure: 'escalate', state: 'queued', attempt: 0, steered: false, ...extra }
}

function snapshot(tasks: WorkflowTask[], extra: Partial<Workflow> = {}, workers: Record<string, string> = {}, paused: WorkflowSnapshot['paused'] = null): WorkflowSnapshot {
  return {
    workflow: {
      id: 'wf_abcdefgh',
      project: '/repo/p.git',
      leadKey: 'lead',
      leadLabel: 'Lead',
      title: 'Flow',
      goal: 'Goal',
      version: 1,
      status: 'running',
      tasks,
      patches: [],
      judgments: [],
      createdAt: '2026-10-16T00:00:00.000Z',
      ...extra,
    },
    paused,
    workers,
    reviewers: {},
  }
}

const result = (summary: string) => ({ status: 'done' as const, summary, steered: false, at: '2026-10-16T00:00:00.000Z' })
const statuses = (map: Record<string, AgentStatus>) => (terminalId: string): AgentStatus => map[terminalId] ?? 'idle'

describe('taskCard', () => {
  it('labels the agent and model', () => {
    expect(taskCard(task('a', { provider: 'codex', model: 'gpt-5' }), 0, null).agent).toBe('Codex · gpt-5')
    expect(taskCard(task('a'), 0, null).agent).toBe('Claude')
  })

  it('shows a done task with the first non-blank line of its summary, truncated', () => {
    const long = 'x'.repeat(120)
    const card = taskCard(task('a', { state: 'done', result: result(`\n\n${long}\nsecond`) }), 2, null)
    expect(card).toMatchObject({ tone: 'done', status: '✓ Done', depth: 2, hasWorker: false })
    expect(card.detail).toHaveLength(90)
    expect(card.detail.endsWith('…')).toBe(true)
  })

  it('shows a failed task with its note before its summary', () => {
    expect(taskCard(task('a', { state: 'failed', note: 'Worker closed', result: result('half') }), 0, null)).toMatchObject({
      tone: 'failed',
      status: '✕ Failed',
      detail: 'Worker closed',
    })
  })

  it('names the patch that cancelled a task, and a detached worker', () => {
    const card = taskCard(task('a', { state: 'cancelled', cancelledBy: 3, detached: true }), 0, null)
    expect(card.status).toBe('✕ Cancelled by patch 2')
    expect(card.detail).toBe('Its worker moved to the sidebar')
    expect(taskCard(task('a', { state: 'cancelled' }), 0, null)).toMatchObject({ status: '✕ Cancelled', detail: '' })
  })

  it('tells a task waiting on the lead from one waiting on the user', () => {
    const waiting = task('a', { state: 'waiting', attempt: 1, note: 'Asks the lead: which schema?' })
    const onLead = snapshot([waiting], { judgments: [{ taskId: 'a', question: 'which schema?', at: '2026-10-16T00:00:00.000Z', delivered: true }] })
    expect(taskCards(onLead, statuses({}))[0]).toMatchObject({ tone: 'running', status: '◆ Waiting on the lead' })
    expect(taskCards(snapshot([waiting]), statuses({}))[0]).toMatchObject({ tone: 'waiting', status: '● Waiting on you' })
  })

  it('reads a running task through its worker status', () => {
    const running = task('a', { state: 'running', attempt: 1, worktree: { branch: 'feat/a' } })
    expect(taskCard(running, 0, 'running')).toMatchObject({ tone: 'running', status: '▶ Running', detail: 'feat/a', hasWorker: true })
    expect(taskCard(running, 0, 'waiting')).toMatchObject({ tone: 'waiting', status: '● Waiting on you' })
    expect(taskCard(running, 0, 'error')).toMatchObject({ tone: 'failed', status: '✕ Worker stopped' })
    expect(taskCard(running, 0, 'exited')).toMatchObject({ tone: 'failed', status: '✕ Worker stopped' })
    expect(taskCard({ ...running, attempt: 2 }, 0, 'running').status).toBe('▶ Running · attempt 2')
  })

  it('shows a waiting task with its note', () => {
    expect(taskCard(task('a', { state: 'waiting', note: 'Stopped without a result' }), 0, 'idle')).toMatchObject({
      tone: 'waiting',
      detail: 'Stopped without a result',
    })
  })

  it('shows a queued task with its dependencies, or the patch that added it', () => {
    expect(taskCard(task('b', { after: ['a', 'c'] }), 1, null)).toMatchObject({ tone: 'queued', status: '○ Queued', detail: 'after: a, c', added: false })
    expect(taskCard(task('b', { addedBy: 2 }), 0, null)).toMatchObject({ status: '＋ Added by patch 1 · queued', added: true })
    expect(taskCard(task('b', { after: ['a'], note: 'Waiting for a worktree' }), 0, null).detail).toBe('Waiting for a worktree')
  })
})

describe('taskCards', () => {
  it('gives each task its depth and its worker status', () => {
    const snap = snapshot([task('a', { state: 'running', attempt: 1 }), task('b', { after: ['a'] }), task('c', { after: ['b', 'a'] })], {}, { a: 't-a' })
    const cards = taskCards(snap, statuses({ 't-a': 'waiting' }))
    expect(cards.map((c) => [c.id, c.depth, c.hasWorker])).toEqual([
      ['a', 0, true],
      ['b', 1, false],
      ['c', 2, false],
    ])
    expect(cards[0].tone).toBe('waiting')
  })
})

describe('needsYou', () => {
  it('lists a running worker that waits, and a waiting task nobody asked the lead about', () => {
    const snap = snapshot(
      [task('a', { state: 'running', attempt: 1 }), task('b', { state: 'waiting', note: 'Stopped' }), task('c', { state: 'waiting' })],
      {},
      { a: 't-a', b: 't-b' },
    )
    expect(needsYou(snap, statuses({ 't-a': 'waiting' }))).toEqual([
      { taskId: 'a', title: 'Task a', text: 'The worker is asking for permission or input.', canOpen: true, kind: 'worker' },
      { taskId: 'b', title: 'Task b', text: 'Stopped', canOpen: true, kind: 'worker' },
      { taskId: 'c', title: 'Task c', text: 'The worker stopped without a result.', canOpen: false, kind: 'worker' },
    ])
  })

  it('opens a restored worker that has no terminal yet', () => {
    const snap = snapshot(
      [task('a', { state: 'waiting', attempt: 1 }), task('b', { state: 'waiting', attempt: 1 })],
      { judgments: [{ taskId: 'b', question: 'q', at: '2026-10-16T00:00:00.000Z', delivered: true }] },
    )
    expect(needsYou(snap, statuses({})).map((i) => i.canOpen)).toEqual([false, false])
    expect(needsYou(snap, statuses({}), new Set(['a', 'b'])).map((i) => [i.taskId, i.canOpen])).toEqual([
      ['a', true],
      ['b', true],
    ])
  })

  it('lists a task waiting on the lead once, as the lead\'s', () => {
    const snap = snapshot([task('a', { state: 'waiting', note: 'Asks the lead: which API?' })], {
      judgments: [{ taskId: 'a', question: 'which API?\nmore', at: '2026-10-16T00:00:00.000Z', delivered: true }],
    })
    expect(needsYou(snap, statuses({}))).toEqual([
      { taskId: 'a', title: 'Task a', text: 'The lead was asked: which API?', canOpen: false, kind: 'lead' },
    ])
  })

  it('says when the question has not reached the lead yet', () => {
    const snap = snapshot([task('a', { state: 'failed' })], {
      judgments: [{ taskId: 'a', question: 'retry?', at: '2026-10-16T00:00:00.000Z', delivered: false }],
    })
    expect(needsYou(snap, statuses({}))[0].text).toBe('Waiting to ask the lead: retry?')
  })

  it('leaves a running worker that works alone', () => {
    const snap = snapshot([task('a', { state: 'running', attempt: 1 })], {}, { a: 't-a' })
    expect(needsYou(snap, statuses({ 't-a': 'running' }))).toEqual([])
  })
})

describe('statusLine', () => {
  it('describes a draft', () => {
    expect(statusLine(snapshot([task('a')], { status: 'draft' }))).toBe('Draft · 1 task · review the graph, then Start')
    expect(statusLine(snapshot([task('a'), task('b')], { status: 'draft' }))).toBe('Draft · 2 tasks · review the graph, then Start')
  })

  it('counts done tasks, leaving cancelled ones out', () => {
    const tasks = [task('a', { state: 'done' }), task('b', { state: 'running' }), task('c', { state: 'cancelled' })]
    expect(statusLine(snapshot(tasks))).toBe('Running · 1 of 2 done')
    expect(statusLine(snapshot(tasks, {}, {}, 'window-closed'))).toBe('Paused: the lead\'s window is closed · 1 of 2 done')
  })

  it('names the end state and how often the lead patched', () => {
    const patch = { version: 2, at: '2026-10-16T00:00:00.000Z', ops: [] }
    expect(statusLine(snapshot([task('a', { state: 'done' })], { status: 'done', patches: [patch] }))).toBe('Done · 1 of 1 tasks · patched once by the lead')
    expect(statusLine(snapshot([task('a')], { status: 'failed', patches: [patch, { ...patch, version: 3 }] }))).toBe(
      'Stuck: the lead or you must decide · 0 of 1 done · patched 2 times by the lead',
    )
    expect(statusLine(snapshot([task('a')], { status: 'cancelled' }))).toBe('Cancelled · 0 of 1 done')
  })
})

describe('leadProgress', () => {
  it('is null when the lead has nothing live', () => {
    expect(leadProgress([], statuses({}))).toBeNull()
    expect(leadProgress([snapshot([task('a', { state: 'done' })], { status: 'done' })], statuses({}))).toBeNull()
  })

  it('reads "workflow draft" while every live workflow is a draft', () => {
    expect(leadProgress([snapshot([task('a')], { status: 'draft' })], statuses({}))).toEqual({ text: 'workflow draft', needsYou: 0 })
  })

  it('sums progress over live workflows and counts only what waits on the user', () => {
    const one = snapshot([task('a', { state: 'done' }), task('b', { state: 'running', attempt: 1 })], {}, { b: 't-b' })
    const two = snapshot(
      [task('c', { state: 'waiting' }), task('d', { state: 'waiting' })],
      { id: 'wf_second01', status: 'failed', judgments: [{ taskId: 'd', question: 'q', at: '', delivered: true }] },
    )
    const finished = snapshot([task('e', { state: 'done' })], { id: 'wf_finished', status: 'done' })
    expect(leadProgress([one, two, finished], statuses({ 't-b': 'waiting' }))).toEqual({ text: '1/4', needsYou: 2 })
  })
})

describe('canStart / canCancel / canDismiss', () => {
  it.each([
    ['draft', true, false, true],
    ['running', false, true, false],
    ['failed', false, true, true],
    ['done', false, false, true],
    ['cancelled', false, false, true],
  ] as const)('%s', (status, start, cancel, dismiss) => {
    expect(canStart({ status })).toBe(start)
    expect(canCancel({ status })).toBe(cancel)
    expect(canDismiss({ status })).toBe(dismiss)
  })
})
