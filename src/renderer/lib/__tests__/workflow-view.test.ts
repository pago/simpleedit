import { describe, it, expect } from 'vitest'
import type { AgentStatus } from '../../../shared/ipc-types'
import type { Workflow, WorkflowLoopRound, WorkflowSnapshot, WorkflowTask } from '../../../shared/workflow'
import { canCancel, canDismiss, canStart, cardIdOf, defaultSlot, leadProgress, needsYou, popupSlots, progressText, statusLine, taskCard, taskCards } from '../workflow-view'

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
      { taskId: 'a', title: 'Task a', text: 'The worker is asking for permission or input.', canOpen: true, kind: 'worker', slot: 'a' },
      { taskId: 'b', title: 'Task b', text: 'Stopped', canOpen: true, kind: 'worker', slot: 'b' },
      { taskId: 'c', title: 'Task c', text: 'The worker stopped without a result.', canOpen: false, kind: 'worker', slot: 'c' },
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
      { taskId: 'a', title: 'Task a', text: 'The lead was asked: which API?', canOpen: false, kind: 'lead', slot: 'a' },
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

const AT = '2026-10-16T00:00:00.000Z'
const work = (summary: string) => ({ summary, steered: false, at: AT })

function loop(extra: Partial<WorkflowTask> = {}, rounds: WorkflowLoopRound[] = []): WorkflowTask {
  return task('impl', {
    kind: 'loop',
    title: 'Implement',
    state: 'running',
    attempt: 1,
    worktree: { branch: 'feat/impl' },
    reviewer: { brief: 'Check it' },
    maxRounds: 3,
    rounds,
    reviewers: rounds.filter((r) => r.reviewer !== undefined).length,
    ...extra,
  })
}

function child(map: string, index: number, extra: Partial<WorkflowTask> = {}): WorkflowTask {
  return task(`${map}.${index}`, { parent: map, index, item: `item ${index}`, title: `item ${index}`, ...extra })
}

describe('loop cards', () => {
  it('shows the round while the worker works, then while it is reviewed', () => {
    const working = snapshot([loop({}, [{ round: 1, review: 'pending' }])], {}, { impl: 't-w' })
    expect(taskCards(working, statuses({ 't-w': 'running' }))[0]).toMatchObject({
      kind: 'loop',
      tone: 'running',
      status: '▶ Round 1 of 3 · working',
      round: { current: 1, max: 3, phase: 'working' },
    })
    const reviewing = snapshot(
      [loop({}, [{ round: 1, review: 'done', reviewer: 1, verdict: 'findings', findings: ['x'], work: work('w1') }, { round: 2, review: 'running', reviewer: 2, work: work('w2') }])],
      {},
      { impl: 't-w' },
    )
    reviewing.reviewers = { impl: 't-r' }
    expect(taskCards(reviewing, statuses({ 't-w': 'idle', 't-r': 'running' }))[0]).toMatchObject({
      tone: 'running',
      status: '◇ Round 2 of 3 · in review',
      round: { current: 2, max: 3, phase: 'reviewing' },
    })
    expect(taskCards(reviewing, statuses({ 't-r': 'waiting' }))[0]).toMatchObject({ tone: 'waiting', detail: 'The reviewer is asking something' })
  })

  it('reads a loop that did not converge as the lead\'s, and a clean one as done', () => {
    const rounds: WorkflowLoopRound[] = [{ round: 3, review: 'done', reviewer: 3, verdict: 'findings', findings: ['x'] }]
    const stuck = snapshot([loop({ state: 'waiting' }, rounds)], { judgments: [{ taskId: 'impl', question: 'q', at: AT, delivered: true }] })
    expect(taskCards(stuck, statuses({}))[0]).toMatchObject({ tone: 'running', status: "◆ Didn't converge · needs the lead", round: { phase: 'not-converged' } })
    const clean = loop({ state: 'done', result: { ...result('ok'), verdict: 'clean', rounds: 2 } }, [{ round: 2, review: 'done', reviewer: 2, verdict: 'clean' }])
    expect(taskCards(snapshot([clean]), statuses({}))[0]).toMatchObject({ tone: 'done', status: '✓ Clean after 2 rounds' })
    const failed = loop({ state: 'failed', note: 'The reviewer failed: x' }, [{ round: 1, review: 'failed', reviewer: 1 }])
    expect(taskCards(snapshot([failed]), statuses({}))[0]).toMatchObject({ tone: 'failed', status: '✕ Reviewer failed' })
  })

  it('a queued loop is a plain queued card', () => {
    const card = taskCards(snapshot([loop({ state: 'queued', attempt: 0 })]), statuses({}))[0]
    expect(card).toMatchObject({ kind: 'loop', status: '○ Queued' })
    expect(card.round).toBeUndefined()
  })
})

describe('map cards', () => {
  const map = (extra: Partial<WorkflowTask> = {}) =>
    task('fix', { kind: 'map', title: 'Fix each', after: ['triage'], over: 'triage.result.items', ...extra })

  it('says what an unexpanded map fans out over', () => {
    const snap = snapshot([task('triage', { state: 'running', attempt: 1 }), map()])
    const card = taskCards(snap, statuses({}))[1]
    expect(card).toMatchObject({ kind: 'map', tone: 'queued', detail: 'fans out over triage items' })
    expect(card.stack).toBeUndefined()
  })

  it('folds its children into one card, toned by the most urgent', () => {
    const snap = snapshot(
      [
        task('triage', { state: 'done' }),
        map({ state: 'running', attempt: 0 }),
        child('fix', 1, { state: 'done' }),
        child('fix', 2, { state: 'failed' }),
        child('fix', 3, { state: 'running', attempt: 1 }),
        child('fix', 4, { state: 'queued', attempt: 0 }),
        task('after', { after: ['fix'] }),
      ],
      {},
      { 'fix.3': 't-3' },
    )
    const cards = taskCards(snap, statuses({ 't-3': 'running' }))
    expect(cards.map((c) => [c.id, c.depth])).toEqual([
      ['triage', 0],
      ['fix', 1],
      ['after', 2],
    ])
    expect(cards[1]).toMatchObject({
      tone: 'failed',
      status: '▤ 1 of 4 done · 1 failed',
      detail: '1 running · 1 queued',
      stack: { total: 4, done: 1, running: 1, waiting: 0, failed: 1, cancelled: 0 },
    })
    expect(taskCards(snap, statuses({ 't-3': 'waiting' }))[1].tone).toBe('waiting')
    expect(progressText(cards[1].stack!)).toBe('1 of 4 done')
    expect(progressText({ total: 3, done: 1, running: 0, waiting: 0, failed: 0, cancelled: 1 })).toBe('1 of 2 done')
  })
})

describe('highlight', () => {
  it('marks the tasks a patch touched, and a map when one of its children was', () => {
    const snap = snapshot([task('a'), task('b'), task('fix', { kind: 'map', over: 'a.result.items' }), child('fix', 1)])
    expect(taskCards(snap, statuses({})).map((c) => c.highlight)).toEqual([null, null, null])
    expect(taskCards(snap, statuses({}), { patch: 2, taskIds: new Set(['b', 'fix.1']) }).map((c) => c.highlight)).toEqual([null, 2, 2])
  })
})

describe('popupSlots', () => {
  it('gives an agent task one worker slot', () => {
    const snap = snapshot([task('a', { state: 'running', attempt: 1 })], {}, { a: 't-a' })
    expect(popupSlots(snap, 'a', statuses({}))).toMatchObject([{ key: 'a', label: 'Worker', role: 'worker', terminalId: 't-a', placeholderId: null }])
    expect(popupSlots(snap, 'missing', statuses({}))).toEqual([])
  })

  it('gives a loop its worker and its latest reviewer', () => {
    const snap = snapshot(
      [loop({}, [{ round: 1, review: 'done', reviewer: 1, verdict: 'findings', findings: ['a', 'b'] }, { round: 2, review: 'running', reviewer: 2 }])],
      {},
      { impl: 't-w' },
    )
    snap.reviewers = { impl: 't-r' }
    const slots = popupSlots(snap, 'impl', statuses({ 't-r': 'running' }), new Map([['impl~r', 'p-r']]))
    expect(slots.map((s) => [s.key, s.label, s.role, s.tone, s.status, s.terminalId])).toEqual([
      ['impl', 'Worker', 'worker', 'queued', '◇ Waiting for the review', 't-w'],
      ['impl~r', 'Reviewer · round 2', 'reviewer', 'running', '▶ Reviewing', 't-r'],
    ])
    expect(slots[1].round?.round).toBe(2)
    expect(slots[1].placeholderId).toBe('p-r')
  })

  it('shows a finished reviewer by its verdict, and none before the first review', () => {
    const done = snapshot([loop({ state: 'waiting' }, [{ round: 3, review: 'done', reviewer: 1, verdict: 'findings', findings: ['a'] }])])
    expect(popupSlots(done, 'impl', statuses({}))[1]).toMatchObject({ tone: 'done', status: '◇ 1 finding', terminalId: null })
    expect(popupSlots(snapshot([loop({}, [{ round: 1, review: 'pending' }])]), 'impl', statuses({}))).toHaveLength(1)
  })

  it('labels each slot with its own agent: the reviewer by its spec, inheriting as the worker does', () => {
    const rounds: WorkflowLoopRound[] = [{ round: 1, review: 'running', reviewer: 1 }]
    const codex = snapshot([loop({ provider: 'codex', model: 'gpt-5', reviewer: { brief: 'b', provider: 'claude', model: 'opus' } }, rounds)])
    expect(popupSlots(codex, 'impl', statuses({})).map((s) => s.agent)).toEqual(['Codex · gpt-5', 'Claude · opus'])
    const plain = snapshot([loop({ provider: 'codex', model: 'gpt-5' }, rounds)])
    expect(popupSlots(plain, 'impl', statuses({}))[1].agent).toBe('Claude')
  })

  it('never lends the worker a status that is the reviewer\'s', () => {
    const asking = snapshot([loop({ state: 'waiting' }, [{ round: 1, review: 'waiting', reviewer: 1 }])])
    expect(popupSlots(asking, 'impl', statuses({}))[0]).toMatchObject({ tone: 'queued', status: '◇ Waiting for the review' })
    const onLead = snapshot([loop({ state: 'waiting' }, [{ round: 1, review: 'waiting', reviewer: 1 }])], { judgments: [{ taskId: 'impl', question: 'q', at: AT, delivered: true }] })
    expect(popupSlots(onLead, 'impl', statuses({}))[0]).toMatchObject({ tone: 'queued', status: '◇ Waiting for the review' })
    const failed = snapshot([loop({ state: 'failed', note: 'The reviewer failed' }, [{ round: 1, review: 'failed', reviewer: 1 }])])
    expect(popupSlots(failed, 'impl', statuses({})).map((s) => [s.role, s.tone, s.status])).toEqual([
      ['worker', 'queued', '◇ Its reviewer failed'],
      ['reviewer', 'failed', '✕ Failed'],
    ])
    const working = snapshot([loop({}, [{ round: 1, review: 'pending' }])], {}, { impl: 't-w' })
    expect(popupSlots(working, 'impl', statuses({ 't-w': 'waiting' }))[0]).toMatchObject({ tone: 'waiting', status: '● Waiting on you' })
  })

  it('opens a card on its reviewer while the reviewer is at work, asking or failed', () => {
    const at = (t: WorkflowTask) => defaultSlot(snapshot([t]).workflow, 'impl')
    expect(at(loop({}, [{ round: 1, review: 'running', reviewer: 1 }]))).toBe('impl~r')
    expect(at(loop({ state: 'waiting' }, [{ round: 1, review: 'waiting', reviewer: 1 }]))).toBe('impl~r')
    expect(at(loop({ state: 'failed' }, [{ round: 1, review: 'failed', reviewer: 1 }]))).toBe('impl~r')
    expect(at(loop({}, [{ round: 1, review: 'done', reviewer: 1, verdict: 'findings', findings: ['x'] }, { round: 2, review: 'queued' }]))).toBe('impl')
    expect(at(loop({}, [{ round: 1, review: 'pending' }]))).toBe('impl')
    expect(at(loop({ state: 'cancelled' }, [{ round: 1, review: 'running', reviewer: 1 }]))).toBe('impl')
    expect(defaultSlot(snapshot([task('a')]).workflow, 'a')).toBe('a')
  })

  it('gives a map one slot per child, in order', () => {
    const snap = snapshot([task('fix', { kind: 'map', state: 'running' }), child('fix', 2, { state: 'running', attempt: 1 }), child('fix', 1, { state: 'done' })], {}, { 'fix.2': 't-2' })
    expect(popupSlots(snap, 'fix', statuses({})).map((s) => [s.key, s.label, s.tone, s.terminalId])).toEqual([
      ['fix.1', '1 · item 1', 'done', null],
      ['fix.2', '2 · item 2', 'running', 't-2'],
    ])
  })
})

describe('needsYou with loops and maps', () => {
  it('names a child by its map and opens its slot', () => {
    const snap = snapshot([task('fix', { kind: 'map', title: 'Fix each', state: 'running' }), child('fix', 1, { state: 'waiting', attempt: 1 })], {}, { 'fix.1': 't-1' })
    expect(needsYou(snap, statuses({}))).toEqual([
      { taskId: 'fix.1', title: 'Fix each · item 1', text: 'The worker stopped without a result.', canOpen: true, kind: 'worker', slot: 'fix.1' },
    ])
    expect(cardIdOf(snap.workflow, 'fix.1')).toBe('fix')
  })

  it('sends a waiting reviewer to the reviewer slot', () => {
    const snap = snapshot([loop({ state: 'waiting' }, [{ round: 1, review: 'waiting', reviewer: 1 }])], {}, { impl: 't-w' })
    expect(needsYou(snap, statuses({}))).toEqual([
      { taskId: 'impl', title: 'Implement', text: 'The reviewer stopped without a verdict.', canOpen: false, kind: 'worker', slot: 'impl~r' },
    ])
    expect(needsYou(snap, statuses({}), new Set(['impl~r']))[0].canOpen).toBe(true)
    expect(cardIdOf(snap.workflow, 'impl~r')).toBe('impl')
  })

  it('sends the lead\'s judgment to the reviewer when the reviewer asked or failed', () => {
    const judgments = [{ taskId: 'impl', question: 'Is this in scope?', at: AT, delivered: true }]
    const asked = snapshot([loop({ state: 'waiting' }, [{ round: 1, review: 'waiting', reviewer: 1 }])], { judgments }, { impl: 't-w' })
    expect(needsYou(asked, statuses({}))).toEqual([
      { taskId: 'impl', title: 'Implement', text: 'The lead was asked: Is this in scope?', canOpen: false, kind: 'lead', slot: 'impl~r' },
    ])
    asked.reviewers = { impl: 't-r' }
    expect(needsYou(asked, statuses({}))[0].canOpen).toBe(true)
    const failed = snapshot([loop({ state: 'failed' }, [{ round: 1, review: 'failed', reviewer: 1 }])], { judgments }, { impl: 't-w' })
    expect(needsYou(failed, statuses({}), new Set(['impl~r']))[0]).toMatchObject({ slot: 'impl~r', canOpen: true })
    const stuck = snapshot([loop({ state: 'waiting' }, [{ round: 3, review: 'done', reviewer: 3, verdict: 'findings', findings: ['x'] }])], { judgments }, { impl: 't-w' })
    expect(needsYou(stuck, statuses({}))[0]).toMatchObject({ slot: 'impl', canOpen: true })
  })

  it('lists a reviewer asking for input while it reviews', () => {
    const snap = snapshot([loop({}, [{ round: 1, review: 'running', reviewer: 1 }])], {}, { impl: 't-w' })
    snap.reviewers = { impl: 't-r' }
    expect(needsYou(snap, statuses({ 't-w': 'waiting', 't-r': 'waiting' }))).toEqual([
      { taskId: 'impl', title: 'Implement', text: 'The reviewer is asking for permission or input.', canOpen: true, kind: 'worker', slot: 'impl~r' },
    ])
  })

  it('never reads a round waiting for its reviewer through the previous reviewer', () => {
    const between = snapshot(
      [loop({}, [{ round: 1, review: 'done', reviewer: 1, verdict: 'findings', findings: ['x'] }, { round: 2, review: 'queued' }])],
      {},
      { impl: 't-w' },
    )
    // A reviewer retry: the round's failed reviewer is still the latest.
    const retrying = snapshot([loop({}, [{ round: 1, review: 'queued', reviewer: 1, note: 'A reviewer failed: x' }])], {}, { impl: 't-w' })
    for (const snap of [between, retrying]) {
      snap.reviewers = { impl: 't-r' }
      for (const live of ['waiting', 'exited'] as const) {
        expect(needsYou(snap, statuses({ 't-r': live }))).toEqual([])
        expect(taskCards(snap, statuses({ 't-r': live }))[0]).toMatchObject({ tone: 'running', detail: 'Waiting for a reviewer slot' })
      }
    }
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
