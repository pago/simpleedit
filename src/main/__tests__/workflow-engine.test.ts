import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import { openDb, useDbForTests } from '../db'
import { createWorkflowEngine, type EngineHost, type EnginePeer, type SpawnRequest, type WorkflowEngine } from '../workflow-engine'
import { getWorkflow, saveWorkflow } from '../workflow-store'
import { WorkflowValidationError, loopPhase, parseNewWorkflow, parseWorkflowOps, workflowProgress, type WorkflowSettings, type WorkflowSnapshot } from '../../shared/workflow'

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
    baseBranch: async () => 'main',
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
    expect(engine.reportResult('w1', { status: 'done', summary: 'did a', changedFiles: ['x.ts', 'y.ts'] })).toEqual({ workflowId: id, taskId: 'a', state: 'done', role: 'worker', outcome: 'done' })
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

  it('refuses items and findings it would otherwise have to cut, and blank or repeated items', async () => {
    const id = create([t('a')])
    engine.start(id, 'user')
    await engine.idle()
    const refused = (raw: Record<string, unknown>): string[] => {
      try {
        engine.reportResult('w1', { status: 'done', summary: 'x', ...raw })
      } catch (error) {
        if (error instanceof WorkflowValidationError) return error.problems
        throw error
      }
      throw new Error('expected a refusal')
    }
    expect(refused({ items: Array.from({ length: 201 }, (_, i) => `i${i}`) })).toEqual(['items: at most 200 entries; you gave 201'])
    expect(refused({ items: ['ok', 'y'.repeat(501), ' ', 'ok'] })).toEqual([
      'items[1]: at most 500 characters; it has 501',
      'items[2]: blank',
      'items[3]: the same as items[0]',
    ])
    expect(refused({ findings: ['', 'f'] })).toEqual(['findings[0]: blank'])
    expect(refused({ items: 'a' })).toEqual(['items: expected a list of strings'])
    expect(stateOf(id, 'a').state).toBe('running')
    engine.reportResult('w1', { status: 'done', summary: 'x', items: ['a', 'A'], changedFiles: Array.from({ length: 250 }, (_, i) => `f${i}`) })
    expect(stateOf(id, 'a').result).toMatchObject({ items: ['a', 'A'] })
    expect(stateOf(id, 'a').result!.changedFiles).toHaveLength(200)
  })

  it('a worktree that cannot be prepared is a failure, retried once under onFailure retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fake.host.ensureWorktree = async () => {
      throw new Error('index.lock exists')
    }
    const id = create([t('a', { worktree: { branch: 'feat-a' }, onFailure: 'retry' }), t('b', { worktree: { branch: 'feat-b' } })])
    engine.start(id, 'user')
    await engine.idle()
    expect(stateOf(id, 'a')).toMatchObject({ state: 'queued', attempt: 1, note: "Couldn't prepare worktree feat-a: index.lock exists" })
    expect(stateOf(id, 'b')).toMatchObject({ state: 'failed', attempt: 1, note: "Couldn't prepare worktree feat-b: index.lock exists" })
    expect(getWorkflow(id)!.judgments.map((j) => j.taskId)).toEqual(['b'])
    await vi.advanceTimersByTimeAsync(5_000)
    await engine.idle()
    expect(stateOf(id, 'a')).toMatchObject({ state: 'failed', attempt: 2 })
    expect(stateOf(id, 'a').history).toEqual([expect.objectContaining({ attempt: 1, note: "Couldn't prepare worktree feat-a: index.lock exists" })])
    expect(getWorkflow(id)!.judgments.find((j) => j.taskId === 'a')!.question).toBe("failed after 2 attempts: Couldn't prepare worktree feat-a: index.lock exists")
    expect(fake.spawns).toEqual([])
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

  describe('review loops', () => {
    const loop = (extra: Record<string, unknown> = {}) =>
      t('impl', { kind: 'loop', worktree: { branch: 'feat-impl' }, reviewer: { brief: 'Check the change', model: 'opus' }, maxRounds: 2, ...extra })

    async function inReview(extra: Record<string, unknown> = {}, more: Array<Record<string, unknown>> = []): Promise<string> {
      const id = create([loop(extra), ...more])
      engine.start(id, 'user')
      await engine.idle()
      expect(engine.reportResult('w1', { status: 'done', summary: 'built it', branch: 'feat-impl', changedFiles: ['a.ts'] })).toMatchObject({
        state: 'running',
        role: 'worker',
        outcome: 'in-review',
      })
      await engine.idle()
      return id
    }

    it('a worker report starts a fresh reviewer with its own owner, brief and the worker\'s worktree', async () => {
      const id = create([loop()])
      engine.start(id, 'user')
      await engine.idle()
      expect(fake.spawns[0].request.brief).toContain('This task is a review loop (at most 2 rounds)')
      expect(stateOf(id, 'impl')).toMatchObject({ rounds: [{ round: 1, review: 'pending' }] })
      engine.reportResult('w1', { status: 'done', summary: 'built it', branch: 'feat-impl', changedFiles: ['a.ts'] })
      await engine.idle()
      expect(fake.spawns).toHaveLength(2)
      const reviewer = fake.spawns[1].request
      expect(reviewer.owner).toEqual({ kind: 'workflow', workflowId: id, taskId: 'impl', attempt: 1, review: 1 })
      expect(reviewer.worktreePath).toBe('/wt/feat-impl')
      expect(reviewer.label).toBe('Task impl · review 1')
      expect(reviewer.model).toBe('opus')
      expect(reviewer.brief).toMatch(/^Check the change\n\n---\n/)
      expect(reviewer.brief).toContain('git -C /wt/feat-impl diff main...feat-impl')
      expect(reviewer.brief).toContain('The worker says: built it\nFiles: a.ts')
      expect(reviewer.brief).not.toContain('Earlier rounds reported')
      const impl = stateOf(id, 'impl')
      expect(impl).toMatchObject({ state: 'running', reviewers: 1, note: 'In review (round 1)' })
      expect(impl.result).toBeUndefined()
      expect(impl.rounds![0]).toMatchObject({ review: 'running', reviewer: 1, work: { summary: 'built it', branch: 'feat-impl', changedFiles: ['a.ts'] } })
      expect(engine.snapshot(id)!).toMatchObject({ workers: { impl: 'w1' }, reviewers: { impl: 'w2' } })
    })

    it('a loop worker may not give a verdict, and a reviewer must', async () => {
      const id = create([loop()])
      engine.start(id, 'user')
      await engine.idle()
      expect(() => engine.reportResult('w1', { status: 'done', summary: 'x', verdict: 'clean' })).toThrow(/reviewer gives the verdict/)
      engine.reportResult('w1', { status: 'done', summary: 'built it' })
      await engine.idle()
      expect(() => engine.reportResult('w1', { status: 'done', summary: 'again' })).toThrow(/in review \(round 1\)/)
      expect(() => engine.reportResult('w2', { status: 'done', summary: 'looks fine' })).toThrow(/verdict/)
      expect(() => engine.reportResult('w2', { status: 'done', summary: 'bad', verdict: 'findings' })).toThrow(/findings/)
      expect(stateOf(id, 'impl').rounds![0].review).toBe('running')
    })

    it('a clean verdict finishes the loop and starts its dependents', async () => {
      const id = await inReview({}, [t('next', { after: ['impl'], brief: 'After {{task.impl.result.summary}}' })])
      expect(engine.reportResult('w2', { status: 'done', summary: 'all good', verdict: 'clean' })).toMatchObject({ state: 'done', role: 'reviewer', outcome: 'clean' })
      await engine.idle()
      const impl = stateOf(id, 'impl')
      expect(impl.state).toBe('done')
      expect(impl.result).toMatchObject({ status: 'done', summary: 'Clean after 1 round: built it', branch: 'feat-impl', changedFiles: ['a.ts'], verdict: 'clean', rounds: 1 })
      expect(fake.spawns[2].request.owner.taskId).toBe('next')
      expect(fake.spawns[2].request.brief).toMatch(/^After Clean after 1 round: built it/)
    })

    it('findings go to the worker by mail and open the next round, whose reviewer sees them and supersedes the first', async () => {
      const id = await inReview()
      expect(engine.reportResult('w2', { status: 'done', summary: 'two issues', verdict: 'findings', findings: ['a.ts:3 off by one', 'a.ts:9 no test'] })).toMatchObject({
        outcome: 'findings-sent',
        state: 'running',
      })
      expect(fake.mail).toHaveLength(1)
      expect(fake.mail[0].to).toBe('w1')
      expect(fake.mail[0].text).toBe(
        `[SimpleEdit workflow "Flow" · task impl · review round 1 of 2]\nThe reviewer found:\n1. a.ts:3 off by one\n2. a.ts:9 no test\nFix them, commit, then call report_result again (status "done").`,
      )
      const impl = stateOf(id, 'impl')
      expect(impl.rounds!.map((r) => [r.round, r.review])).toEqual([
        [1, 'done'],
        [2, 'pending'],
      ])
      expect(impl.note).toBe('Fixing round 1 findings')
      // The worker's turn ending now is the normal case: it fixes and reports.
      engine.onTurnStarted('w1')
      engine.reportResult('w1', { status: 'done', summary: 'fixed both', branch: 'feat-impl' })
      await engine.idle()
      expect(fake.spawns).toHaveLength(3)
      expect(fake.spawns[2].request.owner.review).toBe(2)
      expect(fake.spawns[2].request.label).toBe('Task impl · review 2')
      expect(fake.spawns[2].request.brief).toContain('Earlier rounds reported:\n1. a.ts:3 off by one\n2. a.ts:9 no test\nCheck they are fixed')
      expect(fake.disposed).toEqual(['w2'])
      expect(() => engine.reportResult('w2', { status: 'done', summary: 'late', verdict: 'clean' })).toThrow(/not one/)
      expect(engine.snapshot(id)!.reviewers).toEqual({ impl: 'w3' })
    })

    it('packs a long findings list under the bus cap', async () => {
      await inReview()
      const findings = Array.from({ length: 20 }, (_, i) => `f${i} ${'x'.repeat(490)}`)
      engine.reportResult('w2', { status: 'done', summary: 's', verdict: 'findings', findings })
      expect(fake.mail[0].text.length).toBeLessThanOrEqual(8_000)
      expect(fake.mail[0].text).toMatch(/\(\d+ more not shown; fix these first, the next review will report the rest\)/)
    })

    it('a worker gone when findings arrive is a worker failure', async () => {
      const id = await inReview()
      fake.refuseMail = true
      expect(engine.reportResult('w2', { status: 'done', summary: 's', verdict: 'findings', findings: ['x'] }).outcome).toBe('failed')
      expect(stateOf(id, 'impl')).toMatchObject({ state: 'failed', note: expect.stringContaining("worker's session is gone") })
    })

    async function notConverged(): Promise<string> {
      const id = await inReview()
      engine.reportResult('w2', { status: 'done', summary: 's', verdict: 'findings', findings: ['r1 issue'] })
      engine.reportResult('w1', { status: 'done', summary: 'fixed' })
      await engine.idle()
      expect(engine.reportResult('w3', { status: 'done', summary: 's', verdict: 'findings', findings: ['still broken', 'and this'] }).outcome).toBe('not-converged')
      await engine.idle()
      return id
    }

    it('reaching maxRounds with findings asks the lead and sends no findings mail', async () => {
      const id = await notConverged()
      const impl = stateOf(id, 'impl')
      expect(impl).toMatchObject({ state: 'waiting', note: "Didn't converge in 2 rounds" })
      expect(fake.mail.map((m) => m.to)).toEqual(['w1', LEAD])
      expect(fake.mail[1].text).toContain('task impl: review loop did not converge after 2 rounds. Open findings: 1) still broken 2) and this.')
      expect(fake.mail[1].text).toContain('extend (more rounds), accept (take it as is), or cancel')
      expect(fake.mail[1].text).toContain('Answer with patch_workflow (retry, update, cancel or add tasks; extend or accept a review loop)')
      // Neither of its sessions is waiting on the user.
      engine.onTurnEnded('w1')
      engine.onTurnEnded('w3')
      expect(stateOf(id, 'impl').state).toBe('waiting')
      expect(getWorkflow(id)!.judgments).toHaveLength(1)
    })

    it('extend resumes a loop that did not converge', async () => {
      const id = await notConverged()
      const result = engine.patch(id, getWorkflow(id)!.version, [{ op: 'extend', id: 'impl', rounds: 1 }])
      expect(result.ok).toBe(true)
      const impl = stateOf(id, 'impl')
      expect(impl).toMatchObject({ state: 'running', maxRounds: 3, note: 'Fixing round 2 findings' })
      expect(impl.rounds!.at(-1)).toMatchObject({ round: 3, review: 'pending' })
      expect(fake.mail.at(-1)).toMatchObject({ to: 'w1' })
      expect(fake.mail.at(-1)!.text).toContain('review round 2 of 3')
      expect(getWorkflow(id)!.judgments).toEqual([])
    })

    it('accept finishes a loop that did not converge with its open findings', async () => {
      const id = await notConverged()
      expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'accept', id: 'impl' }]).ok).toBe(true)
      const impl = stateOf(id, 'impl')
      expect(impl.state).toBe('done')
      expect(impl.result).toMatchObject({ verdict: 'findings', findings: ['still broken', 'and this'], rounds: 2, summary: 'Accepted by the lead with 2 open findings: fixed' })
      expect(getWorkflow(id)!.status).toBe('done')
    })

    it('a worker report after non-convergence opens another round', async () => {
      const id = await notConverged()
      expect(engine.reportResult('w1', { status: 'done', summary: 'one more go' }).outcome).toBe('in-review')
      await engine.idle()
      const impl = stateOf(id, 'impl')
      expect(impl.rounds!.at(-1)).toMatchObject({ round: 3, review: 'running', reviewer: 3 })
      expect(getWorkflow(id)!.judgments).toEqual([])
    })

    it('a failed reviewer is retried once under onFailure retry, then fails the loop; a retry re-queues only the reviewer', async () => {
      const id = await inReview({ onFailure: 'retry' })
      expect(engine.reportResult('w2', { status: 'failed', summary: 'no access' }).outcome).toBe('reviewer-retrying')
      await engine.idle()
      expect(fake.spawns.map((x) => x.request.owner.review)).toEqual([undefined, 1, 2])
      expect(stateOf(id, 'impl').state).toBe('running')
      expect(engine.reportResult('w3', { status: 'failed', summary: 'still no access' }).outcome).toBe('failed')
      await engine.idle()
      const impl = stateOf(id, 'impl')
      expect(impl).toMatchObject({ state: 'failed', note: 'The reviewer failed: still no access', attempt: 1 })
      expect(impl.rounds![0].review).toBe('failed')
      expect(fake.mail.at(-1)!.text).toContain('the reviewer of round 1 failed: still no access')
      expect(fake.disposed).toEqual(['w2'])

      expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'retry', id: 'impl' }]).ok).toBe(true)
      await engine.idle()
      expect(fake.spawns).toHaveLength(4)
      expect(fake.spawns[3].request.owner).toMatchObject({ attempt: 1, review: 3 })
      expect(stateOf(id, 'impl')).toMatchObject({ state: 'running', attempt: 1 })
      expect(new Set(fake.disposed)).toEqual(new Set(['w2', 'w3']))
      expect(engine.workerOf('w1')).toEqual({ workflowId: id, taskId: 'impl' })
    })

    it('a loop retry whose worker is gone starts over with a fresh worker', async () => {
      const id = await inReview()
      engine.reportResult('w2', { status: 'failed', summary: 'broke' })
      removePeer('w1')
      engine.patch(id, getWorkflow(id)!.version, [{ op: 'retry', id: 'impl' }])
      await engine.idle()
      expect(fake.spawns.at(-1)!.request.owner).toEqual({ kind: 'workflow', workflowId: id, taskId: 'impl', attempt: 2 })
      expect(stateOf(id, 'impl')).toMatchObject({ attempt: 2, rounds: [{ round: 1, review: 'pending' }] })
      expect(stateOf(id, 'impl').reviewers).toBeUndefined()
      expect(stateOf(id, 'impl').history).toEqual([expect.objectContaining({ attempt: 1, rounds: 1 })])
    })

    it('the worker ending its turn during review is not waiting; the reviewer ending its turn is', async () => {
      const id = await inReview()
      engine.onTurnEnded('w1')
      expect(stateOf(id, 'impl').state).toBe('running')
      engine.onTurnEnded('w2')
      const impl = stateOf(id, 'impl')
      expect(impl).toMatchObject({ state: 'waiting', note: expect.stringContaining('reviewer ended its turn') })
      expect(impl.rounds![0].review).toBe('waiting')
      engine.onUserInput('w2')
      engine.onTurnStarted('w1')
      expect(stateOf(id, 'impl').state).toBe('waiting')
      engine.onTurnStarted('w2')
      expect(stateOf(id, 'impl')).toMatchObject({ state: 'running', steered: false })
      expect(stateOf(id, 'impl').rounds![0]).toMatchObject({ review: 'running', reviewerSteered: true })
      engine.reportResult('w2', { status: 'done', summary: 'ok', verdict: 'clean' })
      expect(stateOf(id, 'impl').result!.steered).toBe(true)
    })

    it('a reviewer that vanishes from a live window is a reviewer failure, not a task failure', async () => {
      const id = await inReview()
      engine.onPeersChanged()
      removePeer('w2')
      engine.onPeersChanged()
      const impl = stateOf(id, 'impl')
      expect(impl).toMatchObject({ state: 'failed', note: 'The reviewer failed: The reviewer session ended without a verdict.' })
      expect(impl.rounds![0].review).toBe('failed')
      expect(fake.disposed).toEqual([])
    })

    it('a worker that vanishes during review fails the loop and ends the round; a retry starts over', async () => {
      const id = await inReview()
      engine.onPeersChanged()
      removePeer('w1')
      engine.onPeersChanged()
      const impl = stateOf(id, 'impl')
      expect(impl).toMatchObject({ state: 'failed', note: 'The worker session ended without reporting a result.' })
      expect(impl.rounds![0]).toMatchObject({ review: 'failed', workerLost: true, note: 'The worker was lost during the review: The worker session ended without reporting a result.' })
      expect(loopPhase(impl)).toBeNull()
      expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'retry', id: 'impl', brief: 'Build it again' }]).ok).toBe(true)
      await engine.idle()
      expect(fake.spawns.at(-1)!.request.owner).toEqual({ kind: 'workflow', workflowId: id, taskId: 'impl', attempt: 2 })
      expect(fake.disposed).toContain('w2')
    })

    it('a worker lost during review closes its reviewer, and a sweep closes one that lingers', async () => {
      const id = await inReview()
      engine.onTurnEnded('w2')
      engine.onPeersChanged()
      removePeer('w1')
      engine.onPeersChanged()
      expect(stateOf(id, 'impl')).toMatchObject({ state: 'failed', rounds: [{ review: 'failed', workerLost: true }] })
      expect(fake.disposed).toEqual(['w2'])
      fake.disposed = []
      engine.onPeersChanged()
      expect(fake.disposed).toEqual(['w2'])
    })

    it('a reviewer may not report items', async () => {
      const id = await inReview()
      expect(() => engine.reportResult('w2', { status: 'done', summary: 'ok', verdict: 'clean', items: ['a'] })).toThrow(/items are the worker's/)
      expect(stateOf(id, 'impl').rounds![0].review).toBe('running')
    })

    it('a retry after a restart reuses the kept worker of a loop whose reviewer failed, and notices losing it', async () => {
      const id = await inReview()
      engine.reportResult('w2', { status: 'failed', summary: 'no access' })
      expect(stateOf(id, 'impl').state).toBe('failed')
      const workerOwner = fake.spawns[0].request.owner
      fake = fakeHost()
      fake.peers.push({ terminalId: 'rw', windowId: WIN, worktreePath: '/wt/feat-impl', status: 'idle', owner: workerOwner })
      engine = createWorkflowEngine(fake.host)
      engine.onHosts(WIN, [LEAD])
      engine.onPeersChanged()
      await engine.idle()
      expect(fake.spawns).toEqual([])
      expect(fake.mail.filter((m) => m.to === 'rw')).toEqual([])
      expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'retry', id: 'impl' }]).ok).toBe(true)
      await engine.idle()
      expect(fake.spawns.map((x) => x.request.owner)).toEqual([{ kind: 'workflow', workflowId: id, taskId: 'impl', attempt: 1, review: 2 }])
      expect(engine.snapshot(id)!).toMatchObject({ workers: { impl: 'rw' }, reviewers: { impl: 'w1' } })
      removePeer('rw')
      engine.onPeersChanged()
      expect(stateOf(id, 'impl')).toMatchObject({ state: 'failed', rounds: [{ review: 'failed', workerLost: true }] })
      expect(fake.disposed).toContain('w1')
    })

    it('cancelling a loop whose reviewer failed detaches its kept worker', async () => {
      const id = await inReview()
      engine.reportResult('w2', { status: 'failed', summary: 'no access' })
      expect(getWorkflow(id)!.status).toBe('failed')
      engine.cancel(id)
      expect(stateOf(id, 'impl')).toMatchObject({ state: 'cancelled', detached: true })
      expect(fake.detached).toEqual(['w1'])
      expect(fake.disposed).toEqual(['w2'])
    })

    it('a patch cancel of a loop whose reviewer failed detaches its kept worker', async () => {
      const id = await inReview()
      engine.reportResult('w2', { status: 'failed', summary: 'no access' })
      expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'cancel', id: 'impl' }]).ok).toBe(true)
      expect(stateOf(id, 'impl')).toMatchObject({ state: 'cancelled', detached: true })
      expect(fake.detached).toEqual(['w1'])
    })

    it('a worker lost while its change waits for a reviewer slot ends that round too', async () => {
      const id = create([loop({ onFailure: 'retry' })])
      engine.start(id, 'user')
      await engine.idle()
      engine.onPeersChanged()
      // Synchronously: the reviewer's start hasn't run yet.
      engine.reportResult('w1', { status: 'done', summary: 'built it' })
      removePeer('w1')
      engine.onPeersChanged()
      const impl = stateOf(id, 'impl')
      // Under onFailure retry the loop queues a fresh worker; the round it left can't be reviewed.
      expect(impl.state).toBe('queued')
      expect(impl.rounds![0]).toMatchObject({ review: 'failed', workerLost: true })
      await engine.idle()
      expect(fake.spawns.map((x) => x.request.owner)).toEqual([
        { kind: 'workflow', workflowId: id, taskId: 'impl', attempt: 1 },
        { kind: 'workflow', workflowId: id, taskId: 'impl', attempt: 2 },
      ])
    })

    it('after a restart the reviewer re-attaches and is nudged once with reviewer wording', async () => {
      const id = await inReview()
      const workerOwner = fake.spawns[0].request.owner
      const reviewerOwner = fake.spawns[1].request.owner
      fake = fakeHost()
      fake.peers.push({ terminalId: 'rw', windowId: WIN, worktreePath: '/wt/feat-impl', status: 'idle', owner: workerOwner })
      fake.peers.push({ terminalId: 'rr', windowId: WIN, worktreePath: '/wt/feat-impl', status: 'running', owner: reviewerOwner })
      engine = createWorkflowEngine(fake.host)
      engine.onHosts(WIN, [LEAD])
      engine.onPeersChanged()
      await engine.idle()
      expect(fake.spawns).toEqual([])
      expect(fake.mail.map((m) => m.to)).toEqual(['rr'])
      expect(fake.mail[0].text).toContain('reviewed round 1 of workflow task "impl"')
      expect(fake.mail[0].text).toContain('verdict "clean" or "findings"')
      expect(engine.snapshot(id)!.reviewers).toEqual({ impl: 'rr' })
      engine.reportResult('rr', { status: 'done', summary: 'ok', verdict: 'clean' })
      expect(stateOf(id, 'impl').state).toBe('done')
    })

    it('a reviewer that never comes back after a restart fails after 90s', async () => {
      const id = await inReview()
      const workerOwner = fake.spawns[0].request.owner
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      fake = fakeHost()
      fake.peers.push({ terminalId: 'rw', windowId: WIN, worktreePath: '/wt/feat-impl', status: 'idle', owner: workerOwner })
      engine = createWorkflowEngine(fake.host)
      engine.onHosts(WIN, [LEAD])
      engine.onPeersChanged()
      await vi.advanceTimersByTimeAsync(90_000)
      await engine.idle()
      expect(stateOf(id, 'impl')).toMatchObject({ state: 'failed', note: expect.stringContaining('reviewer session never started') })
    })

    it('a superseded reviewer that shows up is closed', async () => {
      const id = await inReview()
      engine.reportResult('w2', { status: 'done', summary: 's', verdict: 'findings', findings: ['x'] })
      engine.reportResult('w1', { status: 'done', summary: 'fixed' })
      await engine.idle()
      fake.peers.push({ terminalId: 'ghost', windowId: WIN, worktreePath: '/wt/feat-impl', status: 'idle', owner: { kind: 'workflow', workflowId: id, taskId: 'impl', attempt: 1, review: 1 } })
      engine.onPeersChanged()
      expect(fake.disposed).toContain('ghost')
    })

    it('cancel detaches both the worker and the reviewer', async () => {
      const id = await inReview()
      engine.cancel(id)
      expect(fake.detached.sort()).toEqual(['w1', 'w2'])
      fake.detached = []
      engine.onPeersChanged()
      expect(fake.detached.sort()).toEqual(['w1', 'w2'])
      engine.dismiss(id)
      expect(fake.disposed).toEqual([])
    })

    it('a patch cancel of a loop detaches both', async () => {
      const id = await inReview({}, [t('other')])
      engine.patch(id, getWorkflow(id)!.version, [{ op: 'cancel', id: 'impl' }])
      expect(fake.detached.sort()).toEqual(['w1', 'w3'])
    })

    it('cancelling a loop between rounds detaches its worker and closes the finished reviewer', async () => {
      const id = await inReview()
      engine.reportResult('w2', { status: 'done', summary: 's', verdict: 'findings', findings: ['x'] })
      engine.cancel(id)
      expect(fake.detached).toEqual(['w1'])
      expect(fake.disposed).toEqual(['w2'])
      fake.detached = []
      engine.onPeersChanged()
      expect(fake.detached).toEqual(['w1'])
      engine.dismiss(id)
      expect(fake.detached).toEqual(['w1', 'w1'])
    })

    it('a patch cancel of a loop between rounds closes the finished reviewer too', async () => {
      const id = await inReview({}, [t('other')])
      engine.reportResult('w3', { status: 'done', summary: 's', verdict: 'findings', findings: ['x'] })
      engine.patch(id, getWorkflow(id)!.version, [{ op: 'cancel', id: 'impl' }])
      expect(fake.detached).toEqual(['w1'])
      expect(fake.disposed).toEqual(['w3'])
    })

    it('a patch that both extends and ends a loop is refused, and nothing resumes', async () => {
      const id = await notConverged()
      const mails = fake.mail.length
      for (const second of [{ op: 'cancel' as const, id: 'impl' }, { op: 'accept' as const, id: 'impl' }, { op: 'extend' as const, id: 'impl', rounds: 1 }]) {
        expect(() => engine.patch(id, getWorkflow(id)!.version, [{ op: 'extend', id: 'impl', rounds: 1 }, second])).toThrow(/already changes task "impl"/)
      }
      expect(fake.mail).toHaveLength(mails)
      expect(stateOf(id, 'impl')).toMatchObject({ state: 'waiting', maxRounds: 2 })
      expect(stateOf(id, 'impl').rounds).toHaveLength(2)
    })

    it('a reviewer without a model counts as cloud, whatever its worker runs on', async () => {
      fake.host.isLocalModel = async (_provider, model) => model === 'local-model'
      const id = create([
        t('impl', { kind: 'loop', model: 'local-model', worktree: { branch: 'feat-impl' }, reviewer: { brief: 'Check' } }),
        t('other', { model: 'local-model' }),
      ])
      engine.start(id, 'user')
      await engine.idle()
      expect(fake.spawns.map((x) => x.request.owner.taskId)).toEqual(['impl'])
      engine.reportResult('w1', { status: 'done', summary: 'built' })
      await engine.idle()
      // The reviewer takes a cloud slot, so the local one is free for the other task.
      expect(fake.spawns.map((x) => [x.request.owner.taskId, x.request.owner.review])).toEqual([
        ['impl', undefined],
        ['impl', 1],
        ['other', undefined],
      ])
      expect(fake.spawns[1].request.model).toBeUndefined()
      expect(fake.spawns[1].request.provider).toBeUndefined()
    })

    it('the gate counts a loop once, on its reviewer\'s backend while it reviews', async () => {
      fake.host.isLocalModel = async (_provider, model) => model === 'local-model'
      const id = create([
        t('impl', { kind: 'loop', worktree: { branch: 'feat-impl' }, reviewer: { brief: 'Check', model: 'local-model' } }),
        t('l', { model: 'local-model', after: ['gate'] }),
        t('gate'),
      ])
      engine.start(id, 'user')
      await engine.idle()
      expect(fake.spawns.map((x) => x.request.owner.taskId)).toEqual(['impl', 'gate'])
      engine.reportResult('w1', { status: 'done', summary: 'built' })
      await engine.idle()
      // The local reviewer takes the one local slot; the cloud worker is idle.
      expect(fake.spawns.map((x) => [x.request.owner.taskId, x.request.owner.review])).toEqual([
        ['impl', undefined],
        ['gate', undefined],
        ['impl', 1],
      ])
      engine.reportResult('w2', { status: 'done', summary: 'ok' })
      await engine.idle()
      expect(fake.spawns).toHaveLength(3)
      engine.reportResult('w3', { status: 'done', summary: 'ok', verdict: 'clean' })
      await engine.idle()
      expect(fake.spawns.at(-1)!.request.owner.taskId).toBe('l')
    })
  })

  describe('maps', () => {
    const triage = () => t('triage')
    const map = (extra: Record<string, unknown> = {}) =>
      t('fix', {
        kind: 'map',
        after: ['triage'],
        over: 'triage.result.items',
        brief: 'Fix {{item}} (#{{index}}) after {{task.triage.result.summary}}',
        worktree: { branch: 'fix/{{item}}' },
        acceptance: 'test for {{item}}',
        ...extra,
      })

    async function triaged(items: string[] | undefined, extra: Record<string, unknown> = {}, more: Array<Record<string, unknown>> = []): Promise<string> {
      const id = create([triage(), map(extra), ...more])
      engine.start(id, 'user')
      await engine.idle()
      engine.reportResult('w1', { status: 'done', summary: 'found bugs', ...(items ? { items } : {}) })
      await engine.idle()
      return id
    }

    it('expands into one child per item, with resolved briefs, unique branches and titles', async () => {
      const id = await triaged(['Login breaks', 'Logout {{task.triage.result.summary}}', 'login breaks'])
      const wf = getWorkflow(id)!
      const children = wf.tasks.filter((x) => x.parent === 'fix')
      expect(children.map((c) => [c.id, c.index, c.title, c.worktree?.branch, c.state])).toEqual([
        ['fix.1', 1, 'Login breaks', 'fix/login-breaks', 'running'],
        ['fix.2', 2, 'Logout {{task.triage.result.summary}}', 'fix/logout-task.triage.result.summary', 'running'],
        ['fix.3', 3, 'login breaks', 'fix/login-breaks-3', 'running'],
      ])
      expect(children[0]).toMatchObject({ brief: 'Fix Login breaks (#1) after found bugs', acceptance: 'test for Login breaks', item: 'Login breaks', after: [] })
      expect(stateOf(id, 'fix')).toMatchObject({ state: 'running' })
      expect(wf.version).toBe(1)
      // The child's brief isn't templated again: the item's own `{{…}}` stays as written.
      const second = fake.spawns.find((x) => x.request.owner.taskId === 'fix.2')!.request
      expect(second.brief).toMatch(/^Fix Logout \{\{task\.triage\.result\.summary\}\} \(#2\) after found bugs/)
      expect(second.brief).toContain('You handle item 2 of 3 of map fix ("Task fix"): Logout {{task.triage.result.summary}}')
      expect(second.label).toBe('Logout {{task.triage.result.summary}}')
      expect(second.worktreePath).toBe('/wt/fix/logout-task.triage.result.summary')
      expect(engine.snapshot(id)!.workers).toMatchObject({ 'fix.1': expect.any(String), 'fix.2': expect.any(String) })
    })

    it('tells the source task that later tasks fan out over its items', async () => {
      const id = create([triage(), map({ maxItems: 7 })])
      engine.start(id, 'user')
      await engine.idle()
      expect(fake.spawns[0].request.brief).toContain('Later tasks fan out over your items')
      expect(fake.spawns[0].request.brief).toContain('at most 7')
      expect(stateOf(id, 'fix').state).toBe('queued')
    })

    it('an empty list finishes the map at once', async () => {
      const id = await triaged([], {}, [t('after', { after: ['fix'] })])
      expect(stateOf(id, 'fix')).toMatchObject({ state: 'done', result: { summary: 'No items: nothing to fan out.', items: [] } })
      expect(fake.spawns.at(-1)!.request.owner.taskId).toBe('after')
    })

    /** The lead's way out of a map that couldn't fan out: a new source, and the map moved onto it. */
    async function newSource(id: string, items: string[]): Promise<void> {
      const wf = getWorkflow(id)!
      expect(wf.status).toBe('failed')
      const result = engine.patch(id, wf.version, [
        ...parseWorkflowOps([
          { op: 'add', task: t('triage2', { after: ['triage'] }) },
          { op: 'update', id: 'fix', patch: { after: ['triage2'], over: 'triage2.result.items' } },
        ]),
      ])
      expect(result.ok).toBe(true)
      expect(stateOf(id, 'fix').state).toBe('queued')
      await engine.idle()
      const spawn = fake.spawns.at(-1)!
      expect(spawn.request.owner.taskId).toBe('triage2')
      expect(spawn.request.brief).toContain('Later tasks fan out over your items')
      engine.reportResult(spawn.terminalId, { status: 'done', summary: 'narrowed', items })
      await engine.idle()
    }

    it('a source without items fails the map with a judgment; a new source moves it on', async () => {
      const id = await triaged(undefined)
      expect(stateOf(id, 'fix')).toMatchObject({ state: 'failed', note: 'triage reported no items' })
      expect(getWorkflow(id)!.judgments[0].question).toBe(
        "can't fan out: triage reported no items. To fan out, add a task that reports the items (it may run after triage) and update this map's after and over to it, or cancel the map.",
      )
      await newSource(id, ['one'])
      expect(getWorkflow(id)!.tasks.filter((x) => x.parent === 'fix').map((x) => [x.id, x.state])).toEqual([['fix.1', 'running']])
      expect(getWorkflow(id)!.status).toBe('running')
    })

    it('more items than maxItems is a judgment, never a cut; a narrowing source moves it on', async () => {
      const id = await triaged(['a', 'b', 'c'], { maxItems: 2 })
      expect(stateOf(id, 'fix')).toMatchObject({ state: 'failed', note: 'triage produced 3 items; this map takes at most 2' })
      expect(getWorkflow(id)!.tasks.some((x) => x.parent === 'fix')).toBe(false)
      expect(fake.mail.at(-1)!.text).toContain(
        "this map takes at most 2. To go on, update this map's maxItems to 3, or add a task that narrows or splits the list (it may run after triage) and update this map's after and over to it, or cancel the map.",
      )
      await newSource(id, ['a', 'b'])
      expect(getWorkflow(id)!.tasks.filter((x) => x.parent === 'fix').map((x) => x.item)).toEqual(['a', 'b'])
    })

    it('over the hard cap, raising maxItems is not offered', async () => {
      await triaged(Array.from({ length: 21 }, (_, i) => `i${i}`))
      expect(fake.mail.at(-1)!.text).toContain('produced 21 items; this map takes at most 20. To go on, add a task that narrows')
    })

    it('an item that makes a child brief too long fails the map with a judgment naming it, and nothing is cut', async () => {
      const id = await triaged(['short', `long ${'x'.repeat(400)}`], { brief: `${'b'.repeat(15_800)} {{item}}` })
      expect(stateOf(id, 'fix')).toMatchObject({ state: 'failed', note: expect.stringMatching(/^item 2 \("long x+"\) makes a brief of \d+ characters \(at most 16000\)$/) })
      expect(getWorkflow(id)!.tasks.some((x) => x.parent === 'fix')).toBe(false)
      expect(fake.mail.at(-1)!.text).toContain("Update this map's brief or acceptance to be shorter")
    })

    it('a failed child raises its own judgment while the map keeps running', async () => {
      const id = await triaged(['a', 'b'])
      const [c1, c2] = fake.spawns.slice(1).map((x) => x.terminalId)
      engine.reportResult(c1, { status: 'failed', summary: 'cannot' })
      await engine.idle()
      expect(stateOf(id, 'fix').state).toBe('running')
      expect(getWorkflow(id)!.judgments.map((j) => j.taskId)).toEqual(['fix.1'])
      engine.reportResult(c2, { status: 'done', summary: 'fixed b' })
      await engine.idle()
      expect(getWorkflow(id)!.status).toBe('failed')
      expect(stateOf(id, 'fix').state).toBe('running')
      // The lead retries the child by id.
      expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'retry', id: 'fix.1' }]).ok).toBe(true)
      await engine.idle()
      const retried = fake.spawns.at(-1)!
      expect(retried.request.owner).toMatchObject({ taskId: 'fix.1', attempt: 2 })
      engine.reportResult(retried.terminalId, { status: 'done', summary: 'fixed a\nmore detail', changedFiles: ['a.ts'] })
      await engine.idle()
      const fix = stateOf(id, 'fix')
      expect(fix.state).toBe('done')
      expect(fix.result).toMatchObject({ summary: '2 of 2 items done\n- a: fixed a\n- b: fixed b', items: ['a', 'b'], changedFiles: ['a.ts'] })
      expect(getWorkflow(id)!.status).toBe('done')
    })

    it('an integrate after a map lists its done children\'s branches', async () => {
      const id = await triaged(['a', 'b'], {}, [t('int', { kind: 'integrate', after: ['fix'], shape: 'single' })])
      for (const s of fake.spawns.slice(1)) engine.reportResult(s.terminalId, { status: 'done', summary: `did ${s.request.owner.taskId}` })
      await engine.idle()
      const brief = fake.spawns.at(-1)!.request.brief
      expect(fake.spawns.at(-1)!.request.owner.taskId).toBe('int')
      expect(brief).toContain('- fix.1 (a): branch fix/a — did fix.1')
      expect(brief).toContain('- fix.2 (b): branch fix/b — did fix.2')
      expect(stateOf(id, 'fix').result!.branch).toBeUndefined()
    })

    it('cancelling a map by patch cancels its children and detaches the running ones', async () => {
      const id = await triaged(['a', 'b'])
      expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'cancel', id: 'fix' }]).ok).toBe(true)
      expect(fake.detached.sort()).toEqual(fake.spawns.slice(1).map((x) => x.terminalId).sort())
      expect(getWorkflow(id)!.tasks.filter((x) => x.parent === 'fix').map((x) => x.state)).toEqual(['cancelled', 'cancelled'])
    })

    it("a finished map's items are its done children's only", async () => {
      const id = await triaged(['a', 'b', 'c'])
      expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'cancel', id: 'fix.2' }]).ok).toBe(true)
      for (const s of fake.spawns.slice(1)) if (s.request.owner.taskId !== 'fix.2') engine.reportResult(s.terminalId, { status: 'done', summary: 'ok' })
      await engine.idle()
      expect(stateOf(id, 'fix')).toMatchObject({ state: 'done', result: { items: ['a', 'c'], summary: expect.stringMatching(/^2 of 3 items done/) } })
    })

    it('a map whose children were all cancelled is cancelled, and its dependents ask the lead', async () => {
      const id = await triaged(['a', 'b'], {}, [t('after', { after: ['fix'] })])
      expect(engine.patch(id, getWorkflow(id)!.version, [{ op: 'cancel', id: 'fix.1' }, { op: 'cancel', id: 'fix.2' }]).ok).toBe(true)
      await engine.idle()
      expect(stateOf(id, 'fix').state).toBe('cancelled')
      expect(getWorkflow(id)!.status).toBe('failed')
      expect(getWorkflow(id)!.judgments).toEqual([expect.objectContaining({ taskId: 'after', question: "can't start: it runs after fix (cancelled)." })])
      expect(fake.mail.at(-1)!.text).toContain("task after: can't start: it runs after fix (cancelled).")
    })

    it('a task stuck behind a map with a failed child is told which child failed', async () => {
      const id = await triaged(['a', 'b'], {}, [t('after', { after: ['fix'] })])
      const [c1, c2] = fake.spawns.slice(1).map((x) => x.terminalId)
      engine.reportResult(c1, { status: 'failed', summary: 'cannot' })
      engine.reportResult(c2, { status: 'done', summary: 'ok' })
      await engine.idle()
      expect(getWorkflow(id)!.judgments.find((j) => j.taskId === 'after')!.question).toBe("can't start: it runs after fix (its fix.1 failed).")
    })

    it('a loop can be a map\'s source: its items are the latest round that reported any', async () => {
      const id = create([
        t('triage', { kind: 'loop', worktree: { branch: 'triage' }, reviewer: { brief: 'Check the list' } }),
        t('fix', { kind: 'map', after: ['triage'], over: 'triage.result.items', brief: 'Fix {{item}}', worktree: { branch: 'fix/{{index}}' } }),
      ])
      engine.start(id, 'user')
      await engine.idle()
      engine.reportResult('w1', { status: 'done', summary: 'listed', items: ['a', 'b'] })
      await engine.idle()
      engine.reportResult('w2', { status: 'done', summary: 's', verdict: 'findings', findings: ['wording'] })
      engine.reportResult('w1', { status: 'done', summary: 'reworded the commit only' })
      await engine.idle()
      engine.reportResult('w3', { status: 'done', summary: 'ok', verdict: 'clean' })
      await engine.idle()
      expect(stateOf(id, 'triage').result!.items).toEqual(['a', 'b'])
      expect(getWorkflow(id)!.tasks.filter((x) => x.parent === 'fix').map((x) => x.item)).toEqual(['a', 'b'])
    })

    it('progress counts children once the map expanded', async () => {
      const id = await triaged(['a', 'b'])
      expect(workflowProgress(getWorkflow(id)!)).toEqual({ done: 1, total: 3 })
    })
  })
})
