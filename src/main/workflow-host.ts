/**
 * The workflow engine wired to the app: windows, the agent bus, worktrees,
 * IPC (`workflow:*`) and the MCP tools.
 *
 * Tools are answered here rather than in `mcp-bridge.ts` so the bridge only
 * routes; `setWorkflowTools` hands them over, as the backlog does.
 */
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { RemoteClient } from './client-hub'
import { configDir } from './config-dir'
import { awaitSpawn, getPeer, messageState, onPeersChanged, peersWithWindows, type Peer } from './agent-bus'
import { onSessionRegistered, sessionForTerminal, terminalForSession } from './cwd-tracker'
import { sendSystemMail, setWorkflowTools, type WorkflowToolName } from './mcp-bridge'
import { createWorktree, listWorktrees } from './worktree'
import { handleInvoke } from './ipc-registry'
import { createWorkflowEngine, type EnginePeer, type ReportOutcome, type WorkflowEngine } from './workflow-engine'
import { getWorkflow, listLeadWorkflowIds } from './workflow-store'
import { parseSessionOwner } from '../shared/session-owner'
import {
  WorkflowValidationError,
  describeWorkflow,
  isWorkflowId,
  parseNewWorkflow,
  parseWorkflowOps,
  type WorkflowList,
  type WorkflowOp,
  type WorkflowProvider,
  type WorkflowReviewerSpec,
  type WorkflowSettings,
  type WorkflowSnapshot,
} from '../shared/workflow'
import type { EventMap } from '../shared/ipc-types'

/** How long a worker's terminal id may take to come back from the renderer. */
const SPAWN_WAIT_MS = 10_000
/** `workflow:hosts`: a window lists its agent sessions, never this many. */
const MAX_HOST_KEYS = 1_000
const MAX_HOST_KEY_LENGTH = 200

export interface WorkflowHostDeps {
  /** The bare repo a window was opened on (its project). */
  projectOf(windowId: number): string | null
  /** A desktop window's own webContents, the only client that can create sessions. */
  windowContents(windowId: number): RemoteClient | null
  broadcast<K extends keyof EventMap>(channel: K, data: EventMap[K]): void
  localModels(): Promise<string[]>
  /** Why a task's model can't be started (the pickers' catalog), or null when it can. */
  unknownModel(provider: WorkflowProvider, model: string): Promise<string | null>
  killTerminal(terminalId: string): void
}

const SETTINGS_FILE = 'workflows.json'

export function loadWorkflowSettings(): WorkflowSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir(), SETTINGS_FILE), 'utf8'))
    const leadMayStart = typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).leadMayStart === true
    return { leadMayStart }
  } catch {
    return { leadMayStart: false }
  }
}

function saveWorkflowSettings(settings: WorkflowSettings): void {
  try {
    writeFileSync(join(configDir(), SETTINGS_FILE), JSON.stringify(settings, null, 2), 'utf8')
  } catch {
    /* a setting that won't persist still governs this session */
  }
}

function toEnginePeer(peer: Peer & { windowId: number }): EnginePeer {
  return {
    terminalId: peer.terminalId,
    windowId: peer.windowId,
    worktreePath: peer.worktreePath,
    status: peer.status,
    ...(peer.owner ? { owner: peer.owner } : {}),
  }
}

function leadTerminal(leadKey: string): string | null {
  return terminalForSession(leadKey) ?? (getPeer(leadKey) ? leadKey : null)
}

/** What `report_result` tells the session that called it. */
const NEXT: Record<ReportOutcome, string> = {
  done: 'Recorded. Your task is done; you can stop here.',
  retrying: 'Recorded. A fresh worker will retry this task; you can stop here.',
  failed: 'Recorded. The lead has been told; you can stop here.',
  'asked-lead': 'Recorded. The lead has been asked; wait for its answer in your inbox.',
  'in-review':
    'Recorded. A fresh reviewer will check your change. Its findings, if any, arrive in your inbox: fix them and call report_result again. You can stop here.',
  'findings-sent': 'Recorded. You can stop here.',
  clean: 'Recorded. You can stop here.',
  'not-converged': 'Recorded. You can stop here.',
  'reviewer-retrying': 'Recorded. A fresh reviewer will take this round; you can stop here.',
}

function problemsBody(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof WorkflowValidationError) return { status: 400, body: { error: 'The workflow was refused.', problems: error.problems } }
  return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
}

export function initWorkflows(deps: WorkflowHostDeps): WorkflowEngine {
  let settings = loadWorkflowSettings()
  const lastSent = new Map<string, string>()

  const engine = createWorkflowEngine({
    peers: () => peersWithWindows().map(toEnginePeer),
    leadTerminal,
    async spawnWorker(windowId, request) {
      const contents = deps.windowContents(windowId)
      if (!contents || contents.isDestroyed()) throw new Error('The lead\'s window is gone.')
      const correlationId = randomUUID()
      contents.send('agent-session:spawn', {
        sourceTerminalId: request.leadTerminalId ?? '',
        brief: request.brief,
        correlationId,
        label: request.label,
        ...(request.model ? { model: request.model } : {}),
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        worktreePath: request.worktreePath,
        target: 'new-pane',
        owner: request.owner,
      })
      const peer = await awaitSpawn(correlationId, SPAWN_WAIT_MS)
      return peer?.terminalId ?? null
    },
    async ensureWorktree(project, branch, base) {
      const existing = (await listWorktrees(project)).find((w) => w.branch === branch)
      if (existing) return existing.path
      const target = join(project, '..', branch)
      if (existsSync(target)) throw new Error(`${target} exists but is not a worktree of ${branch}`)
      return (await createWorktree(project, branch, base)).path
    },
    async mainWorktree(project) {
      return (await listWorktrees(project)).find((w) => w.isMain)?.path ?? null
    },
    async baseBranch(project) {
      return (await listWorktrees(project)).find((w) => w.isMain)?.branch ?? null
    },
    sendMail: (to, text) => sendSystemMail('workflow', to, text),
    mailState(messageId) {
      const state = messageState(messageId)
      if (state === 'delivered') return 'read'
      return state === 'queued' || state === 'notified' ? 'pending' : 'lost'
    },
    detachWorker(windowId, terminalId) {
      deps.windowContents(windowId)?.send('workflow:worker', { terminalId, action: 'detach' })
    },
    disposeWorker(windowId, terminalId) {
      deps.windowContents(windowId)?.send('workflow:worker', { terminalId, action: 'dispose' })
    },
    killWorker: (terminalId) => deps.killTerminal(terminalId),
    async isLocalModel(provider, model) {
      if ((provider ?? 'claude') !== 'claude' || !model) return false
      return (await deps.localModels().catch((): string[] => [])).includes(model)
    },
    settings: () => settings,
    broadcast(snapshot: WorkflowSnapshot) {
      // Peer syncs arrive on every status change; most leave every workflow as it was.
      const text = JSON.stringify(snapshot)
      if (lastSent.get(snapshot.workflow.id) === text) return
      if (snapshot.dismissed) lastSent.delete(snapshot.workflow.id)
      else lastSent.set(snapshot.workflow.id, text)
      deps.broadcast('workflow:changed', snapshot)
    },
    log: (message) => console.log(message),
  })

  onPeersChanged(() => engine.onPeersChanged())
  // A lead without a provider session id yet is keyed by its terminal id until it gets one.
  onSessionRegistered((sessionId, terminalId) => engine.rekeyLead(terminalId, sessionId))

  function projectFor(webContentsId: number): string {
    const project = deps.projectOf(webContentsId)
    if (!project) throw new Error('No repository set for this window')
    return project
  }

  /** A workflow id from a client, which must belong to the caller's project. */
  function ownWorkflow(webContentsId: number, id: unknown): string {
    if (!isWorkflowId(id)) throw new Error('Not a workflow id')
    const workflow = getWorkflow(id)
    if (!workflow || workflow.project !== projectFor(webContentsId)) throw new Error('No such workflow in this project')
    return id
  }

  function asError(fn: () => WorkflowSnapshot | void): WorkflowSnapshot | void {
    try {
      return fn()
    } catch (error) {
      if (error instanceof WorkflowValidationError) throw new Error(error.problems.join('\n'))
      throw error
    }
  }

  handleInvoke('workflow:list', (event): WorkflowList => {
    const project = projectFor(event.sender.id)
    return { project, workflows: engine.list(project) }
  })
  handleInvoke('workflow:start', (event, id: unknown) => asError(() => engine.start(ownWorkflow(event.sender.id, id), 'user')))
  handleInvoke('workflow:cancel', (event, id: unknown) => asError(() => engine.cancel(ownWorkflow(event.sender.id, id))))
  handleInvoke('workflow:dismiss', (event, id: unknown) => {
    asError(() => engine.dismiss(ownWorkflow(event.sender.id, id)))
  })
  handleInvoke('workflow:hosts', (event, keys: unknown) => {
    if (event.sender.clientKey !== undefined) throw new Error('workflow:hosts is not available to remote clients')
    if (!Array.isArray(keys) || keys.length > MAX_HOST_KEYS || !keys.every((k) => typeof k === 'string' && k.length <= MAX_HOST_KEY_LENGTH)) {
      throw new Error('Expected a list of session keys')
    }
    engine.onHosts(event.sender.id, keys)
  })
  handleInvoke('workflow:settings-get', () => settings)
  handleInvoke('workflow:settings-set', (event, next: unknown) => {
    if (event.sender.clientKey !== undefined) throw new Error('workflow:settings-set is not available to remote clients')
    if (typeof next !== 'object' || next === null || typeof (next as Record<string, unknown>).leadMayStart !== 'boolean') {
      throw new Error('Expected {leadMayStart: boolean}')
    }
    settings = { leadMayStart: (next as WorkflowSettings).leadMayStart }
    saveWorkflowSettings(settings)
    return settings
  })

  setWorkflowTools({
    async call(tool: WorkflowToolName, args, terminalId, webContentsId) {
      try {
        return await callTool(tool, args, terminalId, webContentsId)
      } catch (error) {
        return problemsBody(error)
      }
    },
    turnStarted: (terminalId) => engine.onTurnStarted(terminalId),
    turnEnded: (terminalId) => engine.onTurnEnded(terminalId),
    leadHandoff(terminalId) {
      // Read now: the replaced session's registration goes when it exits.
      const fromKey = sessionForTerminal(terminalId) ?? terminalId
      if (listLeadWorkflowIds(fromKey).length === 0) return null
      return (successor) => engine.rekeyLead(fromKey, sessionForTerminal(successor) ?? successor)
    },
  })

  type ModelUse = { at: string; provider?: WorkflowProvider; model?: string }

  /** A task's own model and its reviewer's. */
  function taskModels(at: string, task: { provider?: WorkflowProvider; model?: string; reviewer?: WorkflowReviewerSpec }): ModelUse[] {
    return [
      { at, provider: task.provider, model: task.model },
      ...(task.reviewer ? [{ at: `${at}.reviewer`, provider: task.reviewer.provider, model: task.reviewer.model }] : []),
    ]
  }

  /** Every task model the catalog doesn't offer, as problems for the lead. */
  async function modelProblems(tasks: ModelUse[]): Promise<string[]> {
    const reasons = new Map<string, Promise<string | null>>()
    const problems: string[] = []
    for (const { at, provider = 'claude', model } of tasks) {
      if (!model) continue
      const k = `${provider}:${model}`
      if (!reasons.has(k)) reasons.set(k, deps.unknownModel(provider, model).catch(() => null))
      const reason = await reasons.get(k)!
      if (reason) problems.push(`${at}.model: ${reason}`)
    }
    return problems
  }

  function opModels(id: string, ops: WorkflowOp[]): ModelUse[] {
    const current = new Map((getWorkflow(id)?.tasks ?? []).map((t) => [t.id, t]))
    return ops.flatMap((op, i): ModelUse[] => {
      if (op.op === 'add') return taskModels(`ops[${i}].task`, op.task)
      if (op.op !== 'update') return []
      const task = current.get(op.id)
      const uses: ModelUse[] = []
      if (op.patch.model !== undefined || op.patch.provider !== undefined) {
        const model = op.patch.model === null ? undefined : (op.patch.model ?? task?.model)
        uses.push({ at: `ops[${i}].patch`, provider: op.patch.provider ?? task?.provider, model })
      }
      if (op.patch.reviewer) uses.push({ at: `ops[${i}].patch.reviewer`, provider: op.patch.reviewer.provider, model: op.patch.reviewer.model })
      return uses
    })
  }

  function leadWorkflow(args: Record<string, unknown>, terminalId: string, webContentsId: number): string {
    const id = args['workflowId']
    if (!isWorkflowId(id)) throw new WorkflowValidationError(['workflowId: the id create_workflow returned'])
    const workflow = getWorkflow(id)
    if (!workflow || workflow.project !== projectFor(webContentsId)) throw new WorkflowValidationError([`no workflow ${id} in this project`])
    if (!engine.isLead(terminalId, workflow)) throw new WorkflowValidationError([`only the session that created ${id} can change it`])
    return id
  }

  async function callTool(
    tool: WorkflowToolName,
    args: Record<string, unknown>,
    terminalId: string,
    webContentsId: number,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    switch (tool) {
      case 'create_workflow': {
        const owner = parseSessionOwner(getPeer(terminalId)?.owner)
        if (owner?.kind === 'workflow') throw new WorkflowValidationError(['a workflow worker can\'t create workflows; report back with report_result instead'])
        const input = parseNewWorkflow(args)
        const unknown = await modelProblems(input.tasks.flatMap((t, i) => taskModels(`tasks[${i}]`, t)))
        if (unknown.length > 0) throw new WorkflowValidationError(unknown)
        const project = projectFor(webContentsId)
        const key = sessionForTerminal(terminalId) ?? terminalId
        const label = getPeer(terminalId)?.label ?? terminalId
        const snapshot = engine.create(project, { terminalId, key, label }, input)
        const next = settings.leadMayStart
          ? 'Call start_workflow when you are ready, or let the user press Start in the Workflow tab.'
          : 'Ask the user to review the graph in the Workflow tab and press Start. You will be woken only if a task needs your decision; get_workflow shows progress.'
        return { status: 200, body: { ok: true, workflowId: snapshot.workflow.id, version: snapshot.workflow.version, status: snapshot.workflow.status, next } }
      }
      case 'patch_workflow': {
        const id = leadWorkflow(args, terminalId, webContentsId)
        const baseVersion = args['baseVersion']
        if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion)) throw new WorkflowValidationError(['baseVersion: the version get_workflow or create_workflow returned'])
        const ops = parseWorkflowOps(args['ops'])
        const unknown = await modelProblems(opModels(id, ops))
        if (unknown.length > 0) throw new WorkflowValidationError(unknown)
        const result = engine.patch(id, baseVersion, ops)
        if (!result.ok) {
          return {
            status: 409,
            body: { error: `The workflow changed since version ${baseVersion}; it is at version ${result.conflict.version}. Read it again with get_workflow and redo the patch.` },
          }
        }
        return { status: 200, body: { ok: true, ...describeWorkflow(result.snapshot) } }
      }
      case 'start_workflow': {
        const id = leadWorkflow(args, terminalId, webContentsId)
        return { status: 200, body: { ok: true, ...describeWorkflow(engine.start(id, 'lead')) } }
      }
      case 'get_workflow': {
        if (args['workflowId'] === undefined) {
          const project = projectFor(webContentsId)
          const mine = engine.list(project).filter((s) => engine.isLead(terminalId, s.workflow))
          return {
            status: 200,
            body: { ok: true, workflows: mine.map((s) => ({ workflowId: s.workflow.id, title: s.workflow.title, status: s.workflow.status, version: s.workflow.version })) },
          }
        }
        const id = leadWorkflow(args, terminalId, webContentsId)
        return { status: 200, body: { ok: true, ...describeWorkflow(engine.snapshot(id)!) } }
      }
      case 'report_result': {
        const answer = engine.reportResult(terminalId, args)
        return { status: 200, body: { ok: true, task: answer.taskId, state: answer.state, next: NEXT[answer.outcome] } }
      }
    }
  }

  return engine
}
