import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import { createWorkflowEngine, type EngineHost, type EnginePeer, type SpawnRequest, type WorkflowEngine } from '../workflow-engine'
import { getWorkflow, saveWorkflow } from '../workflow-store'
import { WorkflowValidationError, parseNewWorkflow, type WorkflowSettings, type WorkflowSnapshot } from '../../shared/workflow'

const P = '/repo/project.git'
const LEAD = 'lead'
const WIN = 1

interface FakeHost {
  host: EngineHost
  peers: EnginePeer[]
  spawns: Array<{ windowId: number; request: SpawnRequest; terminalId: string }>
  mail: Array<{ to: string; text: string; id: string }>
  /** Mail state by id; unset is still in the mailbox. */
  mailStates: Map<string, 'pending' | 'read' | 'lost'>
  /** sendMail refuses while set. */
  refuseMail?: boolean
  detached: string[]
  disposed: string[]
  killed: string[]
  broadcasts: WorkflowSnapshot[]
  settings: WorkflowSettings
  /** Runs inside spawnWorker after the peer appears, before it resolves (the real bus's order). */
  onSpawned?: (terminalId: string) => void
  /** Spawns resolve with a terminal id but list no peer until `appear` adds it. */
  unlisted?: boolean
  /** Spawns stay in flight until the test resolves them. */
  hold?: boolean
  held: Array<(terminalId: string | null) => void>
}

function fakeHost(opts: { leadPeer?: boolean } = {}): FakeHost {
  let n = 0
  const fake: FakeHost = {
    peers: opts.leadPeer === false ? [] : [{ terminalId: LEAD, windowId: WIN, worktreePath: '/wt/lead', status: 'idle' }],
    spawns: [],
    mail: [],
    mailStates: new Map(),
    detached: [],
    disposed: [],
    killed: [],
    broadcasts: [],
    settings: { leadMayStart: false },
    held: [],
    host: undefined as unknown as EngineHost,
  }
  fake.host = {
    peers: () => [...fake.peers],
    leadTerminal: (k) => (fake.peers.some((p) => p.terminalId === k) ? k : null),
    async spawnWorker(windowId, request) {
      const terminalId = `w${++n}`
      if (fake.unlisted || fake.hold) {
        fake.spawns.push({ windowId, request, terminalId })
        if (fake.hold) return new Promise((resolve) => fake.held.push(resolve))
        return null
      }
      fake.peers.push({ terminalId, windowId, worktreePath: request.worktreePath, status: 'running', owner: request.owner })
      fake.spawns.push({ windowId, request, terminalId })
      fake.onSpawned?.(terminalId)
      return terminalId
    },
    ensureWorktree: async (_project, branch) => `/wt/${branch}`,
    mainWorktree: async () => '/wt/main',
    sendMail(to, text) {
      if (fake.refuseMail) return null
      const id = `m${fake.mail.length + 1}`
      fake.mail.push({ to, text, id })
      return id
    },
    mailState: (id) => fake.mailStates.get(id) ?? 'pending',
    killWorker: (t) => void fake.killed.push(t),
    detachWorker: (_w, t) => void fake.detached.push(t),
    disposeWorker: (_w, t) => void fake.disposed.push(t),
    isLocalModel: async () => false,
    settings: () => fake.settings,
    broadcast: (s) => void fake.broadcasts.push(s),
    log: () => {},
  }
  return fake
}

let fake: FakeHost
let engine: WorkflowEngine

function create(tasks: Array<Record<string, unknown>>): string {
  const snap = engine.create(P, { terminalId: LEAD, key: LEAD, label: 'Lead' }, parseNewWorkflow({ title: 'Flow', goal: 'Goal', tasks }))
  return snap.workflow.id
}

const t = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Task ${id}`, brief: `Do ${id}`, ...extra })

function stateOf(id: string, taskId: string) {
  return getWorkflow(id)!.tasks.find((x) => x.id === taskId)!
}

/** The lead reads (or loses) every mail sent so far. */
function markMail(state: 'read' | 'lost'): void {
  for (const m of fake.mail) fake.mailStates.set(m.id, state)
}

function removePeer(terminalId: string): void {
  fake.peers = fake.peers.filter((p) => p.terminalId !== terminalId)
}

/** A spawned worker's peer shows up in the bus (late). */
function appear(index: number, terminalId = fake.spawns[index].terminalId): string {
  const { windowId, request } = fake.spawns[index]
  fake.peers.push({ terminalId, windowId, worktreePath: request.worktreePath, status: 'running', owner: request.owner })
  return terminalId
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  useDbForTests(openDb(':memory:'))
  fake = fakeHost()
  engine = createWorkflowEngine(fake.host)
  engine.onHosts(WIN, [LEAD])
})

describe('workflow engine', () => {
  it('refuses a lead start unless settings allow it', async () => {
    const id = create([t('a')])
    expect(() => engine.start(id, 'lead')).toThrow(WorkflowValidationError)
    expect(getWorkflow(id)!.status).toBe('draft')
    fake.settings = { leadMayStart: true }
    expect(engine.start(id, 'lead').workflow.status).toBe('running')
    await engine.idle()
    expect(fake.spawns).toHaveLength(1)
    expect(() => engine.start(id, 'user')).toThrow(/not a draft/)
  })

  it('a user start spawns only the root tasks with the right owner, worktree and brief', async () => {
    const id = create([t('a'), t('b', { worktree: { branch: 'feat-b' }, acceptance: 'tests pass' }), t('c', { after: ['a', 'b'] })])
    engine.start(id, 'user')
    await engine.idle()
    expect(fake.spawns.map((s) => s.request.owner)).toEqual([
      { kind: 'workflow', workflowId: id, taskId: 'a', attempt: 1 },
      { kind: 'workflow', workflowId: id, taskId: 'b', attempt: 1 },
    ])
    const [a, b] = fake.spawns
    expect(a.windowId).toBe(WIN)
    expect(a.request.worktreePath).toBe('/wt/lead')
    expect(b.request.worktreePath).toBe('/wt/feat-b')
    expect(a.request.leadTerminalId).toBe(LEAD)
    expect(a.request.label).toBe('Task a')
    expect(a.request.brief).toMatch(/^Do a\n\n---\n/)
    expect(a.request.brief).toContain('report_result')
    expect(b.request.brief).toContain('on branch feat-b')
    expect(b.request.brief).toContain('Done means: tests pass')
    expect(stateOf(id, 'a')).toMatchObject({ state: 'running', attempt: 1, worktreePath: '/wt/lead' })
    expect(stateOf(id, 'c').state).toBe('queued')
    expect(engine.snapshot(id)!.workers).toEqual({ a: 'w1', b: 'w2' })
  })

  it('starts dependents once their after tasks report done, and finishes', async () => {
    const id = create([t('a'), t('b', { after: ['a'], brief: 'Use {{task.a.result.summary}} on {{task.a.result.changedFiles}}' })])
    engine.start(id, 'user')
    await engine.idle()
    expect(engine.workerOf('w1')).toEqual({ workflowId: id, taskId: 'a' })
    expect(engine.reportResult('w1', { status: 'done', summary: 'did a', changedFiles: ['x.ts', 'y.ts'] })).toEqual({ workflowId: id, taskId: 'a', state: 'done' })
    await engine.idle()
    expect(fake.spawns.map((s) => s.request.owner.taskId)).toEqual(['a', 'b'])
    expect(fake.spawns[1].request.brief).toMatch(/^Use did a on x\.ts, y\.ts/)
    engine.reportResult('w2', { status: 'done', summary: 'did b' })
    await engine.idle()
    expect(getWorkflow(id)!.status).toBe('done')
    expect(() => engine.reportResult('w2', { status: 'done', summary: 'again' })).toThrow(/can't change now/)
  })

  it('validates report_result input', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    expect(() => engine.reportResult('lead', { status: 'done', summary: 'x' })).toThrow(/not one/)
    expect(() => engine.reportResult('w1', { status: 'great', summary: 'x' })).toThrow(/status/)
    expect(() => engine.reportResult('w1', { status: 'done', summary: '  ' })).toThrow(/summary/)
    expect(() => engine.reportResult('w1', { status: 'done', summary: 'x', changedFiles: [1] })).toThrow(/list of strings/)
    expect(stateOf(id, 'a').state).toBe('running')
  })

  it('caps cloud workers at 4 until one reports', async () => {
    const id = create(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => t(x)))
    engine.start(id, 'user')
    await engine.idle()
    expect(fake.spawns).toHaveLength(4)
    engine.reportResult('w2', { status: 'done', summary: 'ok' })
    await engine.idle()
    expect(fake.spawns).toHaveLength(5)
    expect(fake.spawns[4].request.owner.taskId).toBe('e')
  })

  it('caps local workers at 1', async () => {
    fake.host.isLocalModel = async () => true
    const id = create([t('a'), t('b')])
    engine.start(id, 'user')
    await engine.idle()
    expect(fake.spawns).toHaveLength(1)
  })

  it('retries a failure once with onFailure retry, then fails and mails the lead', async () => {
    const id = create([t('a', { onFailure: 'retry' })])
    engine.start(id, 'user')
    await engine.idle()
    expect(engine.reportResult('w1', { status: 'failed', summary: 'tests broke' }).state).toBe('queued')
    await engine.idle()
    expect(fake.spawns).toHaveLength(2)
    expect(fake.spawns[1].request.owner.attempt).toBe(2)
    expect(fake.spawns[1].request.brief).toContain('attempt 2')
    expect(fake.spawns[1].request.brief).toContain('An earlier attempt failed: tests broke')
    expect(fake.mail).toEqual([])
    // The replaced worker no longer counts as the task's worker, and is closed.
    expect(engine.workerOf('w1')).toBeNull()
    expect(fake.disposed).toEqual(['w1'])
    expect(stateOf(id, 'a').history).toEqual([
      expect.objectContaining({ attempt: 1, note: 'tests broke', result: expect.objectContaining({ status: 'failed', summary: 'tests broke' }) }),
    ])

    expect(engine.reportResult('w2', { status: 'failed', summary: 'still broken' }).state).toBe('failed')
    await engine.idle()
    expect(fake.spawns).toHaveLength(2)
    expect(fake.mail).toHaveLength(1)
    expect(fake.mail[0].to).toBe(LEAD)
    expect(fake.mail[0].text).toContain('task a: failed after 2 attempts: still broken')
    const wf = getWorkflow(id)!
    expect(wf.status).toBe('failed')
    expect(wf.judgments).toEqual([expect.objectContaining({ taskId: 'a', delivered: false })])
    markMail('read')
    engine.onPeersChanged()
    expect(getWorkflow(id)!.judgments).toEqual([expect.objectContaining({ taskId: 'a', delivered: true })])
    expect(fake.mail).toHaveLength(1)
  })

  it('escalates a first failure without retry', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    engine.reportResult('w1', { status: 'failed', summary: 'nope' })
    await engine.idle()
    expect(fake.spawns).toHaveLength(1)
    expect(fake.mail[0].text).toContain('task a: failed: nope')
  })

  it('needs_lead puts the task in waiting and mails the lead', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    expect(engine.reportResult('w1', { status: 'needs_lead', summary: 'which API?' }).state).toBe('waiting')
    expect(stateOf(id, 'a').note).toBe('Asks the lead: which API?')
    expect(fake.mail).toHaveLength(1)
    expect(fake.mail[0]).toMatchObject({ to: LEAD })
    expect(fake.mail[0].text).toContain('task a: asks (worker session w1): which API?')
    expect(getWorkflow(id)!.status).toBe('running')
    // The lead's answer arrives as a new turn.
    engine.onTurnStarted('w1')
    expect(stateOf(id, 'a').state).toBe('running')
    expect(getWorkflow(id)!.judgments).toEqual([])
  })

  it('a turn ending without report_result is waiting; a new turn is running', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    engine.onTurnEnded('w1')
    expect(stateOf(id, 'a')).toMatchObject({ state: 'waiting', note: expect.stringContaining('without report_result') })
    engine.onTurnStarted('w1')
    const a = stateOf(id, 'a')
    expect(a.state).toBe('running')
    expect(a.note).toBeUndefined()
  })

  it('a worker vanishing from a hosted, live window is a failure', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    engine.onPeersChanged()
    expect(fake.mail).toEqual([])
    removePeer('w1')
    engine.onPeersChanged()
    await engine.idle()
    const a = stateOf(id, 'a')
    expect(a.state).toBe('failed')
    expect(a.note).toBe('The worker session ended without reporting a result.')
    expect(fake.mail).toHaveLength(1)
    expect(fake.mail[0].to).toBe(LEAD)
  })

  it('a worker gone with its window closed is not a failure', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    engine.onPeersChanged()
    engine.onWindowClosed(WIN)
    fake.peers = []
    engine.onPeersChanged()
    expect(stateOf(id, 'a').state).toBe('running')
  })

  it('nudges a worker re-attached after a restart once', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    // Restart: a new engine, and the restored worker has a new terminal id.
    const owner = fake.spawns[0].request.owner
    fake = fakeHost()
    fake.peers.push({ terminalId: 'restored', windowId: WIN, worktreePath: '/wt/lead', status: 'running', owner })
    engine = createWorkflowEngine(fake.host)
    engine.onHosts(WIN, [LEAD])
    engine.onPeersChanged()
    engine.onPeersChanged()
    await engine.idle()
    expect(fake.spawns).toEqual([])
    expect(fake.mail).toHaveLength(1)
    expect(fake.mail[0].to).toBe('restored')
    expect(fake.mail[0].text).toContain('SimpleEdit restarted')
    expect(engine.workerOf('restored')).toEqual({ workflowId: id, taskId: 'a' })
  })

  it('does not nudge a worker it just spawned when peers sync before spawnWorker resolves', async () => {
    fake.onSpawned = () => engine.onPeersChanged()
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    expect(stateOf(id, 'a').state).toBe('running')
    expect(fake.mail).toEqual([])
  })

  it('pauses and spawns nothing while the lead window is not hosted', async () => {
    fake = fakeHost({ leadPeer: false })
    engine = createWorkflowEngine(fake.host)
    const id = create([t('a')])
    const snap = engine.start(id, 'user')
    await engine.idle()
    expect(snap.paused).toBe('window-closed')
    expect(fake.spawns).toEqual([])
    engine.onHosts(WIN, [LEAD])
    await engine.idle()
    expect(engine.snapshot(id)!.paused).toBeNull()
    expect(fake.spawns).toHaveLength(1)
    // No lead peer: the task runs in the main worktree.
    expect(fake.spawns[0].request.worktreePath).toBe('/wt/main')
  })

  it('cancel detaches running workers and cancels the rest', async () => {
    const id = create([t('a'), t('b'), t('c', { after: ['a'] })])
    engine.start(id, 'user')
    await engine.idle()
    const snap = engine.cancel(id)
    expect(snap.workflow.status).toBe('cancelled')
    expect(fake.detached.sort()).toEqual(['w1', 'w2'])
    const wf = getWorkflow(id)!
    expect(wf.tasks.map((x) => [x.id, x.state, x.detached ?? false])).toEqual([
      ['a', 'cancelled', true],
      ['b', 'cancelled', true],
      ['c', 'cancelled', false],
    ])
  })

  it('a cancel op in a patch detaches that worker', async () => {
    const id = create([t('a'), t('b')])
    engine.start(id, 'user')
    await engine.idle()
    const result = engine.patch(id, getWorkflow(id)!.version, [{ op: 'cancel', id: 'a' }])
    expect(result.ok).toBe(true)
    expect(fake.detached).toEqual(['w1'])
    expect(stateOf(id, 'b').state).toBe('running')
  })

  it('dismiss refuses a running workflow, then disposes every worker of that workflow only', async () => {
    const id = create([t('a'), t('b')])
    const other = create([t('x')])
    engine.start(id, 'user')
    engine.start(other, 'user')
    await engine.idle()
    expect(fake.spawns).toHaveLength(3)
    expect(() => engine.dismiss(id)).toThrow(/cancel the workflow/)
    for (const s of fake.spawns.filter((x) => x.request.owner.workflowId === id)) engine.reportResult(s.terminalId, { status: 'done', summary: 'ok' })
    expect(getWorkflow(id)!.status).toBe('done')
    engine.dismiss(id)
    const otherWorker = fake.spawns.find((s) => s.request.owner.workflowId === other)!.terminalId
    expect(fake.disposed.sort()).toEqual(fake.spawns.filter((s) => s.request.owner.workflowId === id).map((s) => s.terminalId).sort())
    expect(fake.disposed).not.toContain(otherWorker)
    expect(getWorkflow(id)).toBeNull()
    expect(fake.broadcasts.at(-1)).toMatchObject({ dismissed: true, workflow: { id } })
    expect(engine.list(P).map((s) => s.workflow.id)).toEqual([other])
  })

  it('an integrate brief lists the branches of its after tasks', async () => {
    const id = create([
      t('a', { worktree: { branch: 'feat-a' } }),
      t('b', { worktree: { branch: 'feat-b' } }),
      t('i', { kind: 'integrate', after: ['a', 'b'], shape: 'stack' }),
    ])
    engine.start(id, 'user')
    await engine.idle()
    engine.reportResult('w1', { status: 'done', summary: 'did a', branch: 'feat-a-final' })
    engine.reportResult('w2', { status: 'done', summary: 'did b' })
    await engine.idle()
    const brief = fake.spawns[2].request.brief
    expect(fake.spawns[2].request.owner.taskId).toBe('i')
    expect(brief).toContain('Combine the work of these tasks:')
    expect(brief).toContain('- a (Task a): branch feat-a-final — did a')
    expect(brief).toContain('- b (Task b): branch feat-b — did b')
    expect(brief).toContain('a stack of dependent PRs')
  })

  it('user input marks the worker steered and the result carries it', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    engine.onUserInput('w1')
    expect(stateOf(id, 'a').steered).toBe(true)
    engine.reportResult('w1', { status: 'done', summary: 'done' })
    expect(stateOf(id, 'a').result).toMatchObject({ status: 'done', steered: true })
  })

  it('a spawn failure puts the task back in the queue without counting the attempt', async () => {
    let calls = 0
    const spawn = fake.host.spawnWorker
    fake.host.spawnWorker = async (windowId, request) => {
      calls++
      if (calls === 1) throw new Error('window gone')
      return spawn(windowId, request)
    }
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    expect(calls).toBe(1)
    expect(stateOf(id, 'a')).toMatchObject({ state: 'queued', attempt: 0, note: "Couldn't start a worker: window gone" })
  })

  it('retries a task whose spawn failed after a pause, without an outside tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let calls = 0
    const spawn = fake.host.spawnWorker
    fake.host.spawnWorker = async (windowId, request) => {
      calls++
      if (calls === 1) throw new Error('window gone')
      return spawn(windowId, request)
    }
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    expect(calls).toBe(1)
    expect(getWorkflow(id)!.tasks[0].note).toMatch(/window gone/)
    engine.onPeersChanged()
    await engine.idle()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    await engine.idle()
    expect(calls).toBe(2)
    expect(fake.spawns[0].request.owner.attempt).toBe(1)
    vi.useRealTimers()
  })

  describe('workers that never bind', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    })

    it('a spawn whose worker never appears fails after 20s and escalates; a late worker is closed', async () => {
      fake.unlisted = true
      const id = create([t('a')])
      engine.start(id, 'user')
      await engine.idle()
      expect(fake.spawns).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(19_000)
      expect(stateOf(id, 'a').state).toBe('running')
      await vi.advanceTimersByTimeAsync(1_000)
      await engine.idle()
      expect(stateOf(id, 'a')).toMatchObject({ state: 'failed', note: 'The worker session never started or was lost.' })
      expect(fake.mail).toHaveLength(1)
      expect(fake.mail[0].to).toBe(LEAD)
      expect(fake.mail[0].text).toContain('never started or was lost')
      const late = appear(0)
      engine.onPeersChanged()
      expect(fake.disposed).toEqual([late])
      expect(() => engine.reportResult(late, { status: 'done', summary: 'late' })).toThrow(/failed/)
    })

    it('under onFailure retry an unbound spawn starts attempt 2', async () => {
      fake.unlisted = true
      const id = create([t('a', { onFailure: 'retry' })])
      engine.start(id, 'user')
      await engine.idle()
      await vi.advanceTimersByTimeAsync(20_000)
      await engine.idle()
      expect(fake.spawns.map((s) => s.request.owner.attempt)).toEqual([1, 2])
      expect(stateOf(id, 'a')).toMatchObject({ state: 'running', attempt: 2 })
      expect(fake.mail).toEqual([])
      // Attempt 1's worker turning up now is closed, attempt 2's is kept.
      const stale = appear(0)
      const current = appear(1)
      engine.onPeersChanged()
      expect(fake.disposed).toEqual([stale])
      expect(engine.workerOf(current)).toEqual({ workflowId: id, taskId: 'a' })
    })

    it('a worker that shows up within the grace is adopted', async () => {
      fake.unlisted = true
      const id = create([t('a')])
      engine.start(id, 'user')
      await engine.idle()
      await vi.advanceTimersByTimeAsync(10_000)
      appear(0)
      engine.onPeersChanged()
      await vi.advanceTimersByTimeAsync(30_000)
      await engine.idle()
      expect(stateOf(id, 'a').state).toBe('running')
      expect(fake.disposed).toEqual([])
    })
  })

  it('engine.cancel during an in-flight spawn detaches the worker once it appears', async () => {
    fake.hold = true
    const id = create([t('a')])
    engine.start(id, 'user')
    await vi.waitFor(() => expect(fake.held).toHaveLength(1))
    engine.cancel(id)
    expect(fake.detached).toEqual([])
    expect(stateOf(id, 'a')).toMatchObject({ state: 'cancelled', detached: true })
    const worker = appear(0)
    engine.onPeersChanged()
    expect(fake.detached).toEqual([worker])
    fake.held[0](worker)
    await engine.idle()
    expect(fake.disposed).toEqual([])
  })

  it('a patch cancel during an in-flight spawn detaches the worker once it appears', async () => {
    fake.hold = true
    const id = create([t('a'), t('b')])
    engine.start(id, 'user')
    await vi.waitFor(() => expect(fake.held).toHaveLength(2))
    expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'cancel', id: 'a' }]).ok).toBe(true)
    const a = appear(0)
    const b = appear(1)
    engine.onPeersChanged()
    expect(fake.detached).toEqual([a])
    expect(engine.workerOf(b)).toEqual({ workflowId: id, taskId: 'b' })
    fake.held.forEach((resolve, i) => resolve(fake.spawns[i].terminalId))
    await engine.idle()
  })

  it('a worker of a dismissed workflow that appears later is closed', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    engine.reportResult('w1', { status: 'done', summary: 'ok' })
    engine.dismiss(id)
    expect(fake.disposed).toEqual(['w1'])
    fake.peers.push({ terminalId: 'late', windowId: WIN, worktreePath: '/wt/lead', status: 'running', owner: fake.spawns[0].request.owner })
    engine.onPeersChanged()
    expect(fake.disposed).toContain('late')
  })

  it('workers leaving with their closed window do not fail, even while the lead is still listed', async () => {
    const id = create([t('a'), t('b')])
    engine.start(id, 'user')
    await engine.idle()
    engine.onPeersChanged()
    engine.onWindowClosed(WIN)
    removePeer('w1')
    removePeer('w2')
    engine.onPeersChanged()
    await engine.idle()
    expect(stateOf(id, 'a').state).toBe('running')
    expect(stateOf(id, 'b').state).toBe('running')
    expect(fake.mail).toEqual([])
  })

  describe('after a restart', () => {
    async function restartWithRunningTask(): Promise<{ id: string; owner: SpawnRequest['owner'] }> {
      const id = create([t('a')])
      engine.start(id, 'user')
      await engine.idle()
      const owner = fake.spawns[0].request.owner
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      fake = fakeHost()
      engine = createWorkflowEngine(fake.host)
      engine.onHosts(WIN, [LEAD])
      await engine.idle()
      return { id, owner }
    }

    it('a running task whose worker never comes back fails after 90s', async () => {
      const { id } = await restartWithRunningTask()
      await vi.advanceTimersByTimeAsync(89_000)
      expect(stateOf(id, 'a').state).toBe('running')
      await vi.advanceTimersByTimeAsync(1_000)
      await engine.idle()
      expect(stateOf(id, 'a').state).toBe('failed')
      expect(stateOf(id, 'a').note).toContain('never started or was lost')
      expect(fake.spawns).toEqual([])
      expect(fake.mail.map((m) => m.to)).toEqual([LEAD])
    })

    it('a restored worker that appears within 90s keeps the task running', async () => {
      const { id, owner } = await restartWithRunningTask()
      await vi.advanceTimersByTimeAsync(30_000)
      fake.peers.push({ terminalId: 'restored', windowId: WIN, worktreePath: '/wt/lead', status: 'running', owner })
      engine.onPeersChanged()
      await vi.advanceTimersByTimeAsync(90_000)
      await engine.idle()
      expect(stateOf(id, 'a').state).toBe('running')
      expect(fake.mail).toHaveLength(1)
      expect(fake.mail[0].to).toBe('restored')
      expect(fake.disposed).toEqual([])
    })

    it('a window closed and reopened during the grace gets a fresh one, and its resumed worker is kept', async () => {
      const { id, owner } = await restartWithRunningTask()
      await vi.advanceTimersByTimeAsync(80_000)
      engine.onWindowClosed(WIN)
      fake.peers = []
      engine.onPeersChanged()
      await vi.advanceTimersByTimeAsync(5_000)
      fake.peers = [{ terminalId: LEAD, windowId: 3, worktreePath: '/wt/lead', status: 'idle' }]
      engine.onHosts(3, [LEAD])
      fake.peers.push({ terminalId: 'resumed', windowId: 3, worktreePath: '/wt/lead', status: 'running', owner })
      engine.onPeersChanged()
      await vi.advanceTimersByTimeAsync(20_000)
      await engine.idle()
      expect(stateOf(id, 'a').state).toBe('running')
      expect(fake.disposed).toEqual([])
    })

    it('a second onHosts does not arm a second check', async () => {
      const { id } = await restartWithRunningTask()
      await vi.advanceTimersByTimeAsync(60_000)
      engine.onHosts(WIN, [LEAD])
      await vi.advanceTimersByTimeAsync(30_000)
      await engine.idle()
      expect(stateOf(id, 'a').state).toBe('failed')
      expect(fake.mail).toHaveLength(1)
    })
  })

  it('a failure that also leaves the graph stuck sends the lead one mail covering both', async () => {
    const id = create([t('a'), t('b', { after: ['a'] })])
    engine.start(id, 'user')
    await engine.idle()
    engine.reportResult('w1', { status: 'failed', summary: 'broke' })
    await engine.idle()
    expect(fake.mail).toHaveLength(1)
    expect(fake.mail[0].to).toBe(LEAD)
    expect(fake.mail[0].text).toContain('task a: failed: broke')
    expect(fake.mail[0].text).toContain("task b: can't start: it runs after a (failed)")
    markMail('read')
    engine.onPeersChanged()
    const wf = getWorkflow(id)!
    expect(wf.status).toBe('failed')
    expect(wf.judgments.map((j) => [j.taskId, j.delivered])).toEqual([
      ['a', true],
      ['b', true],
    ])
  })

  describe('judgment mail', () => {
    async function escalated(): Promise<string> {
      const id = create([t('a')])
      engine.start(id, 'user')
      await engine.idle()
      engine.reportResult('w1', { status: 'failed', summary: 'nope' })
      await engine.idle()
      expect(fake.mail).toHaveLength(1)
      return id
    }

    it('is not sent twice while it sits unread in the lead\'s mailbox', async () => {
      await escalated()
      engine.onPeersChanged()
      engine.onPeersChanged()
      expect(fake.mail).toHaveLength(1)
    })

    it('is sent again when the bus dropped it with the lead', async () => {
      const id = await escalated()
      markMail('lost')
      engine.onPeersChanged()
      expect(fake.mail).toHaveLength(2)
      expect(fake.mail[1].text).toContain('task a: failed: nope')
      expect(getWorkflow(id)!.judgments[0].delivered).toBe(false)
    })

    it('unread before a restart is sent again after it; read is not', async () => {
      const id = await escalated()
      fake = fakeHost()
      engine = createWorkflowEngine(fake.host)
      engine.onHosts(WIN, [LEAD])
      expect(fake.mail).toHaveLength(1)
      markMail('read')
      engine.onPeersChanged()
      expect(getWorkflow(id)!.judgments[0].delivered).toBe(true)
      fake = fakeHost()
      engine = createWorkflowEngine(fake.host)
      engine.onHosts(WIN, [LEAD])
      expect(fake.mail).toEqual([])
    })

    it('splits many long questions over messages the bus accepts, covering every task', async () => {
      const id = create(Array.from({ length: 12 }, (_, i) => t(`t${i}`)))
      const wf = getWorkflow(id)!
      wf.status = 'failed'
      wf.judgments = wf.tasks.map((x) => ({ taskId: x.id, question: `failed: ${'x'.repeat(4_000)}`, at: '2026-10-16T00:00:00.000Z', delivered: false }))
      saveWorkflow(wf)
      engine.onPeersChanged()
      expect(fake.mail.length).toBeGreaterThan(1)
      for (const m of fake.mail) expect(m.text.length).toBeLessThanOrEqual(8_000)
      const all = fake.mail.map((m) => m.text).join('\n')
      for (const x of wf.tasks) expect(all).toContain(`- task ${x.id}: failed: x`)
      expect(all).toContain('get_workflow has the rest')
    })
  })

  it('a refused restart nudge is tried again on the next peer change', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    const owner = fake.spawns[0].request.owner
    fake = fakeHost()
    fake.refuseMail = true
    fake.peers.push({ terminalId: 'restored', windowId: WIN, worktreePath: '/wt/lead', status: 'running', owner })
    engine = createWorkflowEngine(fake.host)
    engine.onHosts(WIN, [LEAD])
    expect(fake.mail).toEqual([])
    fake.refuseMail = false
    engine.onPeersChanged()
    engine.onPeersChanged()
    expect(fake.mail.map((m) => m.to)).toEqual(['restored'])
    expect(stateOf(id, 'a').state).toBe('running')
  })

  it('a lead retry closes the failed worker and keeps its result in the history', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    engine.reportResult('w1', { status: 'failed', summary: 'flaky test' })
    await engine.idle()
    expect(fake.disposed).toEqual([])
    const result = engine.patch(id, getWorkflow(id)!.version, [{ op: 'retry', id: 'a', brief: 'Try again, skip the flaky test' }])
    expect(result.ok).toBe(true)
    await engine.idle()
    expect(fake.spawns).toHaveLength(2)
    expect(fake.spawns[1].request.brief).toContain('An earlier attempt failed: flaky test')
    expect(fake.disposed).toEqual(['w1'])
    const a = stateOf(id, 'a')
    expect(a.result).toBeUndefined()
    expect(a.history).toEqual([expect.objectContaining({ attempt: 1, result: expect.objectContaining({ summary: 'flaky test' }) })])
  })

  it('a spawn whose window closed before its worker appeared waits for the reopened window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fake.unlisted = true
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    const owner = fake.spawns[0].request.owner
    engine.onWindowClosed(WIN)
    fake.peers = []
    engine.onPeersChanged()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(stateOf(id, 'a').state).toBe('running')
    fake.peers = [
      { terminalId: LEAD, windowId: 3, worktreePath: '/wt/lead', status: 'idle' },
      { terminalId: 'resumed', windowId: 3, worktreePath: '/wt/lead', status: 'running', owner },
    ]
    engine.onHosts(3, [LEAD])
    engine.onPeersChanged()
    await vi.advanceTimersByTimeAsync(90_000)
    await engine.idle()
    expect(stateOf(id, 'a').state).toBe('running')
    expect(fake.disposed).toEqual([])
  })

  it('a retry brief cites only the attempt just before it', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    engine.reportResult('w1', { status: 'failed', summary: 'first' })
    await engine.idle()
    const wf = getWorkflow(id)!
    const a = wf.tasks[0]
    Object.assign(a, { attempt: 2, history: [{ attempt: 1, note: 'two attempts back' }] })
    delete a.note
    delete a.result
    saveWorkflow(wf)
    expect(engine.patch(id, wf.version, [{ op: 'retry', id: 'a' }]).ok).toBe(true)
    await engine.idle()
    expect(fake.spawns.at(-1)!.request.owner.attempt).toBe(3)
    expect(fake.spawns.at(-1)!.request.brief).not.toContain('two attempts back')
  })

  it('cancelling every task by patch cancels the workflow instead of finishing it', async () => {
    const id = create([t('a'), t('b')])
    engine.start(id, 'user')
    await engine.idle()
    const result = engine.patch(id, getWorkflow(id)!.version, [
      { op: 'cancel', id: 'a' },
      { op: 'cancel', id: 'b' },
    ])
    expect(result.ok && result.snapshot.workflow.status).toBe('cancelled')
    expect(getWorkflow(id)!.status).toBe('cancelled')
  })

  it('dismiss leaves a detached worker alone even while it is still listed with its owner', async () => {
    const id = create([t('a'), t('b')])
    engine.start(id, 'user')
    await engine.idle()
    engine.reportResult('w2', { status: 'done', summary: 'b done' })
    engine.cancel(id)
    expect(fake.detached).toEqual(['w1'])
    engine.dismiss(id)
    expect(fake.disposed).toEqual(['w2'])
    removePeer('w2')
    engine.onPeersChanged()
    expect(fake.disposed).toEqual(['w2'])
    expect(fake.detached.filter((x) => x === 'w1').length).toBeGreaterThan(1)
  })

  describe('the lead window closing and reopening', () => {
    async function closeWithRunningTask(): Promise<{ id: string; owner: SpawnRequest['owner'] }> {
      const id = create([t('a')])
      engine.start(id, 'user')
      await engine.idle()
      engine.onPeersChanged()
      const owner = fake.spawns[0].request.owner
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      engine.onWindowClosed(WIN)
      fake.peers = []
      engine.onPeersChanged()
      return { id, owner }
    }

    it('ends the window\'s workers, then resumes and nudges them like after a restart', async () => {
      const { id, owner } = await closeWithRunningTask()
      expect(fake.killed).toEqual(['w1'])
      expect(stateOf(id, 'a').state).toBe('running')
      expect(engine.snapshot(id)!.paused).toBe('window-closed')
      fake.peers = [
        { terminalId: LEAD, windowId: 3, worktreePath: '/wt/lead', status: 'idle' },
        { terminalId: 'resumed', windowId: 3, worktreePath: '/wt/lead', status: 'running', owner },
      ]
      engine.onHosts(3, [LEAD])
      engine.onPeersChanged()
      expect(fake.mail.map((m) => m.to)).toEqual(['resumed'])
      expect(fake.mail[0].text).toContain('finish with report_result')
      await vi.advanceTimersByTimeAsync(90_000)
      await engine.idle()
      expect(stateOf(id, 'a').state).toBe('running')
      expect(fake.spawns).toHaveLength(1)
    })

    it('fails a running task whose worker the reopened window never brings back', async () => {
      const { id } = await closeWithRunningTask()
      fake.peers = [{ terminalId: LEAD, windowId: 3, worktreePath: '/wt/lead', status: 'idle' }]
      engine.onHosts(3, [LEAD])
      await vi.advanceTimersByTimeAsync(90_000)
      await engine.idle()
      expect(stateOf(id, 'a').state).toBe('failed')
      expect(stateOf(id, 'a').note).toContain('never started or was lost')
    })
  })

  it('moves a workflow to its lead\'s new key', async () => {
    const id = create([t('a')])
    fake.peers.push({ terminalId: 'successor', windowId: WIN, worktreePath: '/wt/lead', status: 'idle' })
    engine.rekeyLead(LEAD, 'successor')
    const wf = getWorkflow(id)!
    expect(wf.leadKey).toBe('successor')
    expect(engine.isLead('successor', wf)).toBe(true)
    expect(fake.broadcasts.at(-1)!.workflow.leadKey).toBe('successor')
  })
})
