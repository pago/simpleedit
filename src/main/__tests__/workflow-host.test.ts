import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

type Sender = { id: number; clientKey?: string }
type Handler = (event: { sender: Sender }, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  configDir: '',
  handlers: new Map<string, Handler>(),
  tools: null as null | import('../mcp-bridge').WorkflowTools,
}))

vi.mock('../config-dir', () => ({ configDir: () => state.configDir }))
vi.mock('../ipc-registry', () => ({
  handleInvoke: (channel: string, listener: Handler) => {
    state.handlers.set(channel, listener)
  },
}))
vi.mock('../mcp-bridge', () => ({
  setWorkflowTools: (tools: typeof state.tools) => {
    state.tools = tools
  },
  sendSystemMail: vi.fn(() => 'm1'),
}))

import { openDb, useDbForTests } from '../db'
import { resetBus, syncPeers, type Peer } from '../agent-bus'
import { registerSession, unregisterTerminal } from '../cwd-tracker'
import { getWorkflow, saveWorkflow } from '../workflow-store'
import { initWorkflows } from '../workflow-host'
import type { WorkflowToolName } from '../mcp-bridge'

const P = '/repo/project.git'
const OTHER = '/repo/other.git'
const WIN = 1
const OTHER_WIN = 2

const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Task ${id}`, brief: `Do ${id}`, ...extra })

function peer(terminalId: string, extra: Partial<Peer> = {}): Peer {
  return { terminalId, label: terminalId, provider: 'claude', worktreePath: '/wt/main', status: 'idle', ...extra }
}

function init(): void {
  initWorkflows({
    projectOf: (windowId) => (windowId === WIN ? P : windowId === OTHER_WIN ? OTHER : null),
    windowContents: () => null,
    broadcast: () => {},
    localModels: async () => [],
    unknownModel: async (provider, model) => (model.startsWith('bogus') ? `${provider} doesn't offer the model “${model}”.` : null),
    killTerminal: () => {},
  })
}

function call(tool: WorkflowToolName, args: Record<string, unknown>, terminalId = 'lead', windowId = WIN) {
  return state.tools!.call(tool, args, terminalId, windowId)
}

function invoke(channel: string, sender: Sender, ...args: unknown[]): unknown {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({ sender }, ...args)
}

async function createDraft(terminalId = 'lead'): Promise<{ workflowId: string; version: number }> {
  const res = await call('create_workflow', { title: 'Flow', goal: 'Ship it', tasks: [task('a'), task('b', { after: ['a'] })] }, terminalId)
  expect(res.status).toBe(200)
  return { workflowId: res.body['workflowId'] as string, version: res.body['version'] as number }
}

beforeEach(() => {
  state.configDir = mkdtempSync(join(tmpdir(), 'workflow-host-'))
  state.handlers.clear()
  state.tools = null
  useDbForTests(openDb(':memory:'))
  resetBus()
  syncPeers([peer('lead'), peer('bystander')], WIN)
  init()
})

afterEach(() => {
  useDbForTests(null)
  resetBus()
  rmSync(state.configDir, { recursive: true, force: true })
})

describe('initWorkflows: registration', () => {
  it('registers the workflow IPC channels and the bridge tools', () => {
    for (const channel of ['workflow:list', 'workflow:start', 'workflow:cancel', 'workflow:dismiss', 'workflow:hosts', 'workflow:settings-get', 'workflow:settings-set']) {
      expect(state.handlers.has(channel), channel).toBe(true)
    }
    expect(state.tools).not.toBeNull()
  })
})

describe('create_workflow', () => {
  it('creates a draft and tells the lead to ask the user to Start by default', async () => {
    const res = await call('create_workflow', { title: 'Flow', goal: 'Ship it', tasks: [task('a')] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, status: 'draft', version: 1 })
    expect(res.body['workflowId']).toMatch(/^wf_/)
    expect(res.body['next']).toMatch(/press Start/)
    expect(res.body['next']).not.toMatch(/start_workflow when/)
  })

  it('points the lead at start_workflow once leads may start', async () => {
    invoke('workflow:settings-set', { id: WIN }, { leadMayStart: true })
    const res = await call('create_workflow', { title: 'Flow', goal: 'Ship it', tasks: [task('a')] })
    expect(res.body['next']).toMatch(/Call start_workflow/)
  })

  it('refuses invalid input with every problem listed', async () => {
    const res = await call('create_workflow', { title: '', goal: 'g', tasks: [] })
    expect(res.status).toBe(400)
    expect(res.body['problems']).toEqual(expect.arrayContaining([expect.stringMatching(/^title/), expect.stringMatching(/^tasks/)]))
  })

  it('refuses a task model the catalog does not offer', async () => {
    const res = await call('create_workflow', {
      title: 'Flow',
      goal: 'g',
      tasks: [task('a', { model: 'bogus-1' }), task('b', { provider: 'codex', model: 'gpt-5' }), task('c', { provider: 'codex', model: 'bogus-2' })],
    })
    expect(res.status).toBe(400)
    expect(res.body['problems']).toEqual([`tasks[0].model: claude doesn't offer the model “bogus-1”.`, `tasks[2].model: codex doesn't offer the model “bogus-2”.`])
  })

  it('refuses a workflow worker', async () => {
    syncPeers([peer('lead'), peer('worker', { owner: { kind: 'workflow', workflowId: 'wf_abcdefgh', taskId: 'a', attempt: 1 } })], WIN)
    const res = await call('create_workflow', { title: 'Flow', goal: 'g', tasks: [task('a')] }, 'worker')
    expect(res.status).toBe(400)
    expect((res.body['problems'] as string[]).join()).toMatch(/worker can't create workflows/)
  })
})

describe('patch_workflow', () => {
  it('refuses a session that is not the lead', async () => {
    const { workflowId, version } = await createDraft()
    const res = await call('patch_workflow', { workflowId, baseVersion: version, ops: [{ op: 'cancel', id: 'b' }] }, 'bystander')
    expect(res.status).toBe(400)
    expect((res.body['problems'] as string[]).join()).toMatch(/only the session that created/)
  })

  it('answers 409 for a stale baseVersion', async () => {
    const { workflowId, version } = await createDraft()
    const first = await call('patch_workflow', { workflowId, baseVersion: version, ops: [{ op: 'update', id: 'b', patch: { title: 'B2' } }] })
    expect(first.status).toBe(200)
    expect(first.body['version']).toBe(version + 1)

    const stale = await call('patch_workflow', { workflowId, baseVersion: version, ops: [{ op: 'update', id: 'b', patch: { title: 'B3' } }] })
    expect(stale.status).toBe(409)
    expect(stale.body['error']).toMatch(new RegExp(`version ${version + 1}`))
  })

  it('refuses an added or updated task whose model the catalog does not offer', async () => {
    const { workflowId, version } = await createDraft()
    const res = await call('patch_workflow', {
      workflowId,
      baseVersion: version,
      ops: [
        { op: 'add', task: task('c', { model: 'bogus-add' }) },
        { op: 'update', id: 'b', patch: { model: 'bogus-update' } },
        { op: 'update', id: 'a', patch: { title: 'No model change' } },
      ],
    })
    expect(res.status).toBe(400)
    expect(res.body['problems']).toEqual([
      expect.stringMatching(/^ops\[0\]\.task\.model: .*bogus-add/),
      expect.stringMatching(/^ops\[1\]\.patch\.model: .*bogus-update/),
    ])
    expect(getWorkflow(workflowId)!.version).toBe(version)
  })

  it('refuses a workflow of another project', async () => {
    const { workflowId, version } = await createDraft()
    const res = await call('patch_workflow', { workflowId, baseVersion: version, ops: [{ op: 'cancel', id: 'b' }] }, 'lead', OTHER_WIN)
    expect(res.status).toBe(400)
    expect((res.body['problems'] as string[]).join()).toMatch(/no workflow .* in this project/)
  })
})

describe('start_workflow', () => {
  it('is refused by default with the reason in problems', async () => {
    const { workflowId } = await createDraft()
    const res = await call('start_workflow', { workflowId })
    expect(res.status).toBe(400)
    expect((res.body['problems'] as string[]).join()).toMatch(/Starting is the user's call/)
    expect(invoke('workflow:list', { id: WIN })).toMatchObject({ workflows: [{ workflow: { id: workflowId, status: 'draft' } }] })
  })

  it('is allowed after workflow:settings-set {leadMayStart: true}, which persists', async () => {
    expect(invoke('workflow:settings-set', { id: WIN }, { leadMayStart: true })).toEqual({ leadMayStart: true })
    expect(invoke('workflow:settings-get', { id: WIN })).toEqual({ leadMayStart: true })
    const { workflowId } = await createDraft()
    const res = await call('start_workflow', { workflowId })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, status: 'running' })

    // A fresh host reads the saved setting from configDir().
    init()
    expect(invoke('workflow:settings-get', { id: WIN })).toEqual({ leadMayStart: true })
  })

  it('settings-set refuses remote clients and malformed input', () => {
    expect(() => invoke('workflow:settings-set', { id: WIN, clientKey: 'phone' }, { leadMayStart: true })).toThrow(/remote clients/)
    expect(() => invoke('workflow:settings-set', { id: WIN }, { leadMayStart: 'yes' })).toThrow(/leadMayStart/)
    expect(invoke('workflow:settings-get', { id: WIN })).toEqual({ leadMayStart: false })
  })
})

describe('get_workflow', () => {
  it('without an id lists only the workflows the caller leads', async () => {
    const mine = await createDraft('lead')
    await createDraft('bystander')
    const res = await call('get_workflow', {})
    expect(res.status).toBe(200)
    expect(res.body['workflows']).toEqual([{ workflowId: mine.workflowId, title: 'Flow', status: 'draft', version: mine.version }])
  })

  it('with an id describes the workflow to its lead', async () => {
    const { workflowId } = await createDraft()
    const res = await call('get_workflow', { workflowId })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, workflowId, status: 'draft' })
    expect((res.body['tasks'] as Array<{ id: string }>).map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('report_result', () => {
  it('answers 400 to a session that is not a worker', async () => {
    await createDraft()
    const res = await call('report_result', { status: 'done', summary: 'did it' }, 'bystander')
    expect(res.status).toBe(400)
    expect((res.body['problems'] as string[]).join()).toMatch(/report_result is for workflow workers/)
  })
})

describe('IPC', () => {
  it('workflow:start refuses a workflow from a window of another project', async () => {
    const { workflowId } = await createDraft()
    expect(() => invoke('workflow:start', { id: OTHER_WIN }, workflowId)).toThrow(/No such workflow in this project/)
  })

  it('workflow:start from the lead window starts the draft', async () => {
    const { workflowId } = await createDraft()
    expect(invoke('workflow:start', { id: WIN }, workflowId)).toMatchObject({ workflow: { id: workflowId, status: 'running' } })
  })

  it('workflow:start refuses a malformed id', () => {
    expect(() => invoke('workflow:start', { id: WIN }, '../etc')).toThrow(/Not a workflow id/)
  })

  it('workflow:hosts refuses remote clients', () => {
    expect(() => invoke('workflow:hosts', { id: WIN, clientKey: 'phone-1' }, ['lead'])).toThrow(/not available to remote clients/)
  })

  it('workflow:hosts refuses anything but a list of strings', () => {
    expect(() => invoke('workflow:hosts', { id: WIN }, ['lead', 3])).toThrow(/list of session keys/)
    expect(() => invoke('workflow:hosts', { id: WIN }, ['lead'])).not.toThrow()
  })

  it('workflow:hosts refuses an oversized list or key', () => {
    expect(() => invoke('workflow:hosts', { id: WIN }, Array.from({ length: 1_001 }, (_, i) => `k${i}`))).toThrow(/list of session keys/)
    expect(() => invoke('workflow:hosts', { id: WIN }, ['x'.repeat(201)])).toThrow(/list of session keys/)
  })

  it('workflow:list throws for a window without a repository', () => {
    expect(() => invoke('workflow:list', { id: 99 })).toThrow(/No repository/)
  })
})

describe('lead hand-off', () => {
  afterEach(() => {
    unregisterTerminal('lead')
    unregisterTerminal('successor')
  })

  it('a replacing lead hands its workflows to the successor, which takes its session id once registered', async () => {
    registerSession('sid-lead', 'lead')
    const { workflowId } = await createDraft()
    expect(getWorkflow(workflowId)!.leadKey).toBe('sid-lead')
    expect(state.tools!.leadHandoff('bystander')).toBeNull()
    const handoff = state.tools!.leadHandoff('lead')!
    unregisterTerminal('lead')
    syncPeers([peer('successor'), peer('bystander')], WIN)
    handoff('successor')
    expect(getWorkflow(workflowId)!.leadKey).toBe('successor')
    registerSession('sid-successor', 'successor')
    expect(getWorkflow(workflowId)!.leadKey).toBe('sid-successor')
    const res = await call('get_workflow', { workflowId }, 'successor')
    expect(res.status).toBe(200)
  })
})

describe('review loops', () => {
  const loop = (extra: Record<string, unknown> = {}) => task('impl', { kind: 'loop', worktree: { branch: 'feat' }, reviewer: { brief: 'check' }, ...extra })

  it('refuses a reviewer model the catalog does not offer, on create and on update', async () => {
    const created = await call('create_workflow', { title: 'Flow', goal: 'g', tasks: [loop({ reviewer: { brief: 'check', provider: 'codex', model: 'bogus-r' } })] })
    expect(created.status).toBe(400)
    expect(created.body['problems']).toEqual([`tasks[0].reviewer.model: codex doesn't offer the model “bogus-r”.`])
    const ok = await call('create_workflow', { title: 'Flow', goal: 'g', tasks: [loop()] })
    const workflowId = ok.body['workflowId'] as string
    const patched = await call('patch_workflow', { workflowId, baseVersion: 1, ops: [{ op: 'update', id: 'impl', patch: { reviewer: { brief: 'x', model: 'bogus-p' } } }] })
    expect(patched.status).toBe(400)
    expect(patched.body['problems']).toEqual([expect.stringMatching(/^ops\[0\]\.patch\.reviewer\.model: .*bogus-p/)])
  })

  async function running(review: 'pending' | 'running'): Promise<string> {
    const res = await call('create_workflow', { title: 'Flow', goal: 'g', tasks: [loop()] })
    const id = res.body['workflowId'] as string
    const wf = getWorkflow(id)!
    wf.status = 'running'
    Object.assign(wf.tasks[0], {
      state: 'running',
      attempt: 1,
      worktreePath: '/wt/feat',
      ...(review === 'running'
        ? { reviewers: 1, rounds: [{ round: 1, review: 'running', reviewer: 1, work: { summary: 'built', steered: false, at: 'a' } }] }
        : { rounds: [{ round: 1, review: 'pending' }] }),
    })
    saveWorkflow(wf)
    const owner = { kind: 'workflow' as const, workflowId: id, taskId: 'impl', attempt: 1 }
    syncPeers([peer('lead'), peer('bystander'), peer('worker', { owner }), ...(review === 'running' ? [peer('reviewer', { owner: { ...owner, review: 1 } })] : [])], WIN)
    return id
  }

  it('tells a loop worker that a fresh reviewer checks its change', async () => {
    await running('pending')
    const res = await call('report_result', { status: 'done', summary: 'built', branch: 'feat' }, 'worker')
    expect(res.status).toBe(200)
    expect(res.body['next']).toBe(
      'Recorded. A fresh reviewer will check your change. Its findings, if any, arrive in your inbox: fix them and call report_result again. You can stop here.',
    )
  })

  it('get_workflow names the reviewer\'s session, and a reviewer\'s verdict is answered in a line', async () => {
    const workflowId = await running('running')
    const res = await call('get_workflow', { workflowId })
    expect((res.body['tasks'] as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'impl', session_id: 'worker', reviewer_session_id: 'reviewer', loop: { round: 1, phase: 'reviewing' } })
    const verdict = await call('report_result', { status: 'done', summary: 'fine', verdict: 'clean' }, 'reviewer')
    expect(verdict.body).toMatchObject({ ok: true, state: 'done', next: 'Recorded. You can stop here.' })
  })
})

