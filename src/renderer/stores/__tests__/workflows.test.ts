import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushSync } from 'svelte'
import type { AgentStatus, EventMap } from '../../../shared/ipc-types'
import type { Workflow, WorkflowSnapshot, WorkflowTask } from '../../../shared/workflow'
import { sessionsStore } from '../sessions.svelte'
import { tabsStore, tabIdFor } from '../tabsStore.svelte'
import { clearAgentStatusForTerminal, initAgentStatusListeners } from '../agent-status.svelte'
import { _receiveForTests, _resetWorkflowsForTests, _setLoadedForTests, initWorkflowListeners, sessionKey, workflowsStore } from '../workflows.svelte'
import { _resetSessionAttentionForTests, currentSessionsAttention, sessionAttentionLevelFor } from '../sessionAttention.svelte'

const PROJECT = '/repo/p.git'
const LAUNCH = '/repo'
const WT = '/repo/main'
const WF = 'wf_abcdefgh'
const LEAD_KEY = 'lead-uuid'

function task(id: string, extra: Partial<WorkflowTask> = {}): WorkflowTask {
  return { id, title: `Task ${id}`, kind: 'agent', after: [], brief: `Do ${id}`, onFailure: 'escalate', state: 'running', attempt: 1, steered: false, ...extra }
}

function snapshot(extra: Partial<Workflow> = {}, rest: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    workflow: {
      id: WF,
      project: PROJECT,
      leadKey: LEAD_KEY,
      leadLabel: 'Lead',
      title: 'Flow',
      goal: 'Goal',
      version: 1,
      status: 'running',
      tasks: [task('a')],
      patches: [],
      judgments: [],
      createdAt: '2026-10-16T00:00:00.000Z',
      ...extra,
    },
    paused: null,
    workers: {},
    ...rest,
  }
}

let statusHandler: ((d: EventMap['agent:status']) => void) | undefined
const handlers = new Map<string, (d: unknown) => void>()
let disposeStatus: () => void
const statusIds = new Set<string>()

function status(terminalId: string, s: AgentStatus): void {
  statusIds.add(terminalId)
  statusHandler?.({ worktreePath: WT, status: s, terminalId, precise: true })
  flushSync()
}

function createLead(key = LEAD_KEY): string {
  const id = sessionsStore.createAgent({ provider: 'claude' }, LAUNCH, WT)
  sessionsStore.update(id, { providerSessionId: key })
  return id
}

function createWorker(taskId = 'a', attempt = 1, workflowId = WF): string {
  return sessionsStore.createAgent({ provider: 'claude' }, LAUNCH, WT, { owner: { kind: 'workflow', workflowId, taskId, attempt } })
}

beforeEach(() => {
  statusHandler = undefined
  handlers.clear()
  vi.stubGlobal('api', {
    on: (channel: string, cb: (d: unknown) => void) => {
      if (channel === 'agent:status') statusHandler = cb as typeof statusHandler
      handlers.set(channel, cb)
      return () => {}
    },
    once: vi.fn(),
    invoke: vi.fn(() => Promise.resolve(undefined)),
  })
  sessionsStore.reset()
  _resetWorkflowsForTests()
  _resetSessionAttentionForTests()
  disposeStatus = initAgentStatusListeners()
})

afterEach(() => {
  for (const id of statusIds) clearAgentStatusForTerminal(id)
  statusIds.clear()
  disposeStatus()
  vi.unstubAllGlobals()
})

describe('sessionKey', () => {
  it('prefers the provider session id, then a pending resume, then the terminal id', () => {
    expect(sessionKey({ id: 't1', providerSessionId: 'p1', pendingResume: { sessionId: 'r1' } })).toBe('p1')
    expect(sessionKey({ id: 't1', pendingResume: { sessionId: 'r1' } })).toBe('r1')
    expect(sessionKey({ id: 't1' })).toBe('t1')
  })
})

describe('workflowsStore: receive', () => {
  it('opens a new workflow\'s tab in its lead\'s session, focused when nothing else is', () => {
    const lead = createLead()
    _setLoadedForTests(PROJECT)
    _receiveForTests(snapshot())
    const tabId = tabIdFor({ kind: 'workflow', workflowId: WF })
    expect(tabsStore.list(lead).map((t) => t.id)).toEqual([tabId])
    expect(tabsStore.activeId(lead)).toBe(tabId)
    expect(tabsStore.list(lead)[0]).toMatchObject({ kind: 'workflow', workflowId: WF, title: 'Flow' })
  })

  it('opens it in the background when the lead already shows a tab', () => {
    const lead = createLead()
    tabsStore.open(lead, { kind: 'file', id: tabIdFor({ kind: 'file', path: `${WT}/a.ts` }), path: `${WT}/a.ts`, modified: false })
    _setLoadedForTests(PROJECT)
    _receiveForTests(snapshot())
    expect(tabsStore.list(lead)).toHaveLength(2)
    expect(tabsStore.activeId(lead)).toBe(tabIdFor({ kind: 'file', path: `${WT}/a.ts` }))
    expect(tabsStore.isUnread(lead, tabIdFor({ kind: 'workflow', workflowId: WF }))).toBe(true)
  })

  it('opens the tab once: an update to a workflow whose tab was closed leaves it closed', () => {
    const lead = createLead()
    _setLoadedForTests(PROJECT)
    _receiveForTests(snapshot())
    tabsStore.close(lead, tabIdFor({ kind: 'workflow', workflowId: WF }))
    _receiveForTests(snapshot({ version: 2 }))
    expect(tabsStore.list(lead)).toHaveLength(0)
    expect(workflowsStore.get(WF)?.workflow.version).toBe(2)
  })

  it('follows a hand-off to the successor, then its session id, with the tab opened once', () => {
    const lead = createLead()
    _setLoadedForTests(PROJECT)
    _receiveForTests(snapshot())
    const successor = sessionsStore.createAgent({ provider: 'claude' }, LAUNCH, WT)
    sessionsStore.close(lead)
    // Main keys the successor by its terminal id until its session id registers.
    _receiveForTests(snapshot({ leadKey: successor, version: 2 }))
    const tabId = tabIdFor({ kind: 'workflow', workflowId: WF })
    const successorSession = sessionsStore.get(successor)!
    expect(workflowsStore.forLead(successorSession).map((w) => w.workflow.id)).toEqual([WF])
    expect(tabsStore.list(successor).map((t) => t.id)).toEqual([tabId])
    tabsStore.close(successor, tabId)

    sessionsStore.update(successor, { providerSessionId: 'sid-successor' })
    _receiveForTests(snapshot({ leadKey: 'sid-successor', version: 3 }))
    expect(workflowsStore.forLead(sessionsStore.get(successor)!).map((w) => w.workflow.id)).toEqual([WF])
    expect(tabsStore.list(successor)).toHaveLength(0)
  })

  it('opens no tab before the list has loaded', () => {
    const lead = createLead()
    _receiveForTests(snapshot())
    expect(tabsStore.list(lead)).toHaveLength(0)
    expect(workflowsStore.all()).toHaveLength(1)
  })

  it('ignores a workflow of another project', () => {
    createLead()
    _setLoadedForTests(PROJECT)
    _receiveForTests(snapshot({ project: '/repo/other.git' }))
    expect(workflowsStore.all()).toEqual([])
  })

  it('drops a dismissed workflow', () => {
    _setLoadedForTests(PROJECT)
    _receiveForTests(snapshot())
    _receiveForTests(snapshot({}, { dismissed: true }))
    expect(workflowsStore.get(WF)).toBeUndefined()
  })

  it('closes every session a dismissed workflow owned, restored placeholders too', () => {
    _setLoadedForTests(PROJECT)
    const live = createWorker('a')
    const restored = createWorker('b')
    sessionsStore.update(restored, { pendingResume: { sessionId: 'old-b' } })
    const other = createWorker('a', 1, 'wf_elsewhere')
    _receiveForTests(snapshot())
    _receiveForTests(snapshot({}, { dismissed: true }))
    expect(sessionsStore.get(live)).toBeUndefined()
    expect(sessionsStore.get(restored)).toBeUndefined()
    expect(sessionsStore.get(other)).toBeDefined()
  })
})

describe('workflowsStore: leads and workers', () => {
  it('forLead finds the workflows a session leads, never for a worker', () => {
    const lead = createLead()
    const other = createLead('other-key')
    const worker = createWorker()
    _receiveForTests(snapshot())
    expect(workflowsStore.forLead(sessionsStore.get(lead)!).map((w) => w.workflow.id)).toEqual([WF])
    expect(workflowsStore.forLead(sessionsStore.get(other)!)).toEqual([])
    expect(workflowsStore.forLead(sessionsStore.get(worker)!)).toEqual([])
  })

  it('taskOf answers only for the task\'s current attempt', () => {
    _receiveForTests(snapshot({ tasks: [task('a', { attempt: 2 })] }))
    expect(workflowsStore.taskOf({ owner: { kind: 'workflow', workflowId: WF, taskId: 'a', attempt: 2 } })?.id).toBe('a')
    expect(workflowsStore.taskOf({ owner: { kind: 'workflow', workflowId: WF, taskId: 'a', attempt: 1 } })).toBeUndefined()
    expect(workflowsStore.taskOf({ owner: { kind: 'workflow', workflowId: WF, taskId: 'zz', attempt: 2 } })).toBeUndefined()
    expect(workflowsStore.taskOf({})).toBeUndefined()
  })

  it('waitsOnUser: a waiting task, unless the lead was asked about it', () => {
    const owner = { kind: 'workflow' as const, workflowId: WF, taskId: 'a', attempt: 1 }
    _receiveForTests(snapshot({ tasks: [task('a', { state: 'waiting' })] }))
    expect(workflowsStore.waitsOnUser({ owner })).toBe(true)
    _receiveForTests(snapshot({ tasks: [task('a', { state: 'waiting' })], judgments: [{ taskId: 'a', question: 'q', at: '', delivered: true }] }))
    expect(workflowsStore.waitsOnUser({ owner })).toBe(false)
    _receiveForTests(snapshot({ tasks: [task('a', { state: 'running' })] }))
    expect(workflowsStore.waitsOnUser({ owner })).toBe(false)
  })

  it('workersOf lists the live workers of the lead\'s workflows only', () => {
    const lead = createLead()
    const mine = createWorker('a')
    createWorker('a', 1, 'wf_elsewhere')
    _receiveForTests(snapshot())
    expect(workflowsStore.workersOf(sessionsStore.get(lead)!).map((s) => s.id)).toEqual([mine])
  })

  it('workersOf leaves out finished tasks and replaced attempts', () => {
    const lead = createLead()
    createWorker('a', 1)
    const current = createWorker('a', 2)
    createWorker('b', 1)
    _receiveForTests(snapshot({ tasks: [task('a', { attempt: 2 }), task('b', { state: 'done' })] }))
    expect(workflowsStore.workersOf(sessionsStore.get(lead)!).map((s) => s.id)).toEqual([current])
  })
})

describe('session attention with workflow workers', () => {
  it('a lead with no workers keeps its own level', () => {
    const lead = createLead()
    status(lead, 'running')
    expect(sessionAttentionLevelFor(sessionsStore.get(lead)!)).toBe('running')
  })

  it('a worker whose agent waits makes its lead waiting', () => {
    const lead = createLead()
    const worker = createWorker()
    _receiveForTests(snapshot())
    status(lead, 'idle')
    status(worker, 'running')
    expect(sessionAttentionLevelFor(sessionsStore.get(lead)!)).toBe('running')
    status(worker, 'waiting')
    expect(sessionAttentionLevelFor(sessionsStore.get(lead)!)).toBe('waiting')
  })

  it('a worker whose task waits with no judgment makes its lead waiting though its agent is idle', () => {
    const lead = createLead()
    const worker = createWorker()
    status(worker, 'idle')
    _receiveForTests(snapshot({ tasks: [task('a', { state: 'waiting' })] }))
    expect(sessionAttentionLevelFor(sessionsStore.get(lead)!)).toBe('waiting')

    _receiveForTests(snapshot({ tasks: [task('a', { state: 'waiting' })], judgments: [{ taskId: 'a', question: 'q', at: '', delivered: true }] }))
    expect(sessionAttentionLevelFor(sessionsStore.get(lead)!)).toBe('none')
  })

  it('the Sessions aggregate counts workers of visible leads', () => {
    createLead()
    const worker = createWorker()
    createWorker('a', 1, 'wf_orphaned1')
    _receiveForTests(snapshot())
    status(worker, 'waiting')
    const attention = currentSessionsAttention()
    expect(attention.level).toBe('waiting')
    expect(attention.counts.waiting).toBe(1)
  })

  it('the aggregate leaves out workers whose workflow has no visible lead', () => {
    createLead()
    const orphan = createWorker('a', 1, 'wf_orphaned1')
    status(orphan, 'waiting')
    expect(currentSessionsAttention().level).toBe('none')
  })
})

describe('workflowsStore: showFor', () => {
  it('reopens a closed Workflow tab', () => {
    const lead = createLead()
    _setLoadedForTests(PROJECT)
    _receiveForTests(snapshot())
    const tabId = tabIdFor({ kind: 'workflow', workflowId: WF })
    tabsStore.close(lead, tabId)
    workflowsStore.showFor(sessionsStore.get(lead)!, () => 'idle')
    expect(tabsStore.activeId(lead)).toBe(tabId)
  })

  it('picks the live workflow that waits on the user over a newer one', () => {
    const lead = createLead()
    _receiveForTests(snapshot({ tasks: [task('a', { state: 'waiting' })] }))
    _receiveForTests(snapshot({ id: 'wf_newerone' }))
    _receiveForTests(snapshot({ id: 'wf_finished', status: 'done' }))
    workflowsStore.showFor(sessionsStore.get(lead)!, () => 'idle')
    expect(tabsStore.activeId(lead)).toBe(tabIdFor({ kind: 'workflow', workflowId: WF }))
  })

  it('opens nothing for a lead whose workflows are all finished', () => {
    const lead = createLead()
    _receiveForTests(snapshot({ status: 'done' }))
    workflowsStore.showFor(sessionsStore.get(lead)!, () => 'idle')
    expect(tabsStore.list(lead)).toHaveLength(0)
  })
})

describe('initWorkflowListeners', () => {
  let stop: (() => void) | undefined

  afterEach(() => {
    stop?.()
    stop = undefined
  })

  function restoredWorker(taskId: string, workflowId = WF): string {
    const id = createWorker(taskId, 1, workflowId)
    sessionsStore.update(id, { pendingResume: { sessionId: `old-${taskId}-${workflowId}` } })
    return id
  }

  function start(): void {
    _setLoadedForTests(PROJECT)
    sessionsStore.markHydrated()
    stop = initWorkflowListeners()
    flushSync()
  }

  it('resumes the restored workers of running and waiting tasks, and only those', () => {
    const running = restoredWorker('a')
    const waiting = restoredWorker('b')
    const done = restoredWorker('c')
    _receiveForTests(snapshot({ tasks: [task('a'), task('b', { state: 'waiting' }), task('c', { state: 'done' })] }))
    start()
    expect(sessionsStore.get(running)?.pendingResume).toBeUndefined()
    expect(sessionsStore.get(waiting)?.pendingResume).toBeUndefined()
    expect(sessionsStore.get(done)?.pendingResume).toBeDefined()
    const resumes = vi
      .mocked(window.api.invoke)
      .mock.calls.filter(([channel, req]) => channel === 'agent:spawn' && (req as { resumeSessionId?: string }).resumeSessionId)
    expect(resumes.map(([, req]) => (req as { id: string }).id).sort()).toEqual([running, waiting].sort())
  })

  it('detaches a cancelled task\'s restored worker into the sidebar', () => {
    const worker = restoredWorker('a')
    _receiveForTests(snapshot({ status: 'cancelled', tasks: [task('a', { state: 'cancelled', detached: true })] }))
    start()
    expect(sessionsStore.get(worker)?.owner).toBeUndefined()
    expect(sessionsStore.visibleSessions().map((s) => s.id)).toContain(worker)
  })

  it('closes a restored worker whose workflow is gone', () => {
    const worker = restoredWorker('a', 'wf_vanished')
    _receiveForTests(snapshot())
    start()
    expect(sessionsStore.get(worker)).toBeUndefined()
  })

  it('leaves a finished workflow\'s restored workers alone', () => {
    const worker = restoredWorker('a')
    _receiveForTests(snapshot({ status: 'done', tasks: [task('a', { state: 'done' })] }))
    start()
    expect(sessionsStore.get(worker)).toMatchObject({ pendingResume: { sessionId: `old-a-${WF}` }, owner: { kind: 'workflow', workflowId: WF } })
  })

  it('a detach from main makes the worker an ordinary visible session; a dispose closes it', () => {
    const kept = createWorker('a')
    const gone = createWorker('b')
    start()
    handlers.get('workflow:worker')!({ terminalId: kept, action: 'detach' })
    handlers.get('workflow:worker')!({ terminalId: gone, action: 'dispose' })
    expect(sessionsStore.get(kept)?.owner).toBeUndefined()
    expect(sessionsStore.visibleSessions().map((s) => s.id)).toContain(kept)
    expect(sessionsStore.get(gone)).toBeUndefined()
  })

  it('reports only unowned agent sessions as hosts: never a worker or a review companion', () => {
    createLead()
    createWorker()
    const companion = sessionsStore.createAgent({ provider: 'claude' }, LAUNCH, WT, { owner: { kind: 'review', reviewId: 'rv_abcdefgh' } })
    sessionsStore.update(companion, { providerSessionId: 'companion-key' })
    start()
    expect(window.api.invoke).toHaveBeenCalledWith('workflow:hosts', [LEAD_KEY])
  })
})
