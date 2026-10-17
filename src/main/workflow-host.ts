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
import { onAgentStatus } from './agent-status'
import { isDialogNotification } from './thread-delivery-core'
import { onSessionRegistered, sessionForTerminal, terminalForSession } from './cwd-tracker'
import { sendSystemMail, setWorkflowTools, type WorkflowToolName } from './mcp-bridge'
import { createWorktree, listWorktrees } from './worktree'
import { handleInvoke } from './ipc-registry'
import { createWorkflowEngine, waitsOnUser, type EnginePeer, type ReportOutcome, type WorkflowEngine } from './workflow-engine'
import { getWorkflow, listLeadWorkflowIds } from './workflow-store'
import type { WorkflowAlert, WorkflowAlertItem } from './remote/push'
import { parseSessionOwner, type WorkflowOwner } from '../shared/session-owner'
import {
  WorkflowValidationError,
  currentRound,
  describeWorkflow,
  isWorkflowId,
  ownerIsCurrent,
  parseNewWorkflow,
  parseWorkflowOps,
  slimWorkflowSnapshot,
  slotKey,
  waitingSlot,
  type Workflow,
  type WorkflowJudgment,
  type WorkflowList,
  type WorkflowOp,
  type WorkflowProvider,
  type WorkflowReviewerSpec,
  type WorkflowSettings,
  type WorkflowSnapshot,
  type WorkflowTask,
} from '../shared/workflow'
import type { AgentStatus } from '../shared/ipc-types'

/** How long a worker's terminal id may take to come back from the renderer. */
const SPAWN_WAIT_MS = 10_000
/** `workflow:hosts`: a window lists its agent sessions, never this many. */
const MAX_HOST_KEYS = 1_000
const MAX_HOST_KEY_LENGTH = 200
/** A phone hears about a status-only change at most this often per workflow. */
const STATUS_THROTTLE_MS = 1_000

/** The push side of workflows (`remote/push.ts`). */
export interface WorkflowPushHooks {
  alert(alert: WorkflowAlert, options?: { quiet?: boolean }): void
  rearm(key: string): void
  forget(workflowId: string): void
}

export interface WorkflowHostDeps {
  /** The bare repo a window was opened on (its project). */
  projectOf(windowId: number): string | null
  /** A desktop window's own webContents, the only client that can create sessions. */
  windowContents(windowId: number): RemoteClient | null
  /** Every window and every phone: windows get a snapshot whole, phones `slimWorkflowSnapshot`. */
  clients: RemoteClient
  push?: WorkflowPushHooks
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

function titleOf(workflow: Workflow, task: WorkflowTask): string {
  const map = task.parent !== undefined ? workflow.tasks.find((t) => t.id === task.parent) : undefined
  return map ? `${map.title} · ${task.title}` : task.title
}

/** Tasks waiting on the user (not on the lead), one item per waiting session. */
function waitingItems(workflow: Workflow): WorkflowAlertItem[] {
  const items: WorkflowAlertItem[] = []
  for (const task of workflow.tasks) {
    const slot = waitingSlot(task)
    if (!slot || !waitsOnUser(task) || workflow.judgments.some((j) => j.taskId === task.id)) continue
    const review = slot === 'reviewer' ? currentRound(task)?.reviewer : undefined
    items.push({
      key: slotKey(workflow.id, { taskId: task.id, attempt: task.attempt, ...(review !== undefined ? { review } : {}) }),
      taskId: task.id,
      taskTitle: titleOf(workflow, task),
      note: task.note ?? (slot === 'reviewer' ? 'The reviewer stopped without a verdict.' : 'The worker stopped without a result.'),
    })
  }
  return items
}

function judgmentItems(workflow: Workflow, judgments: WorkflowJudgment[]): WorkflowAlertItem[] {
  return judgments.map((j) => {
    const task = workflow.tasks.find((t) => t.id === j.taskId)
    return { key: `${workflow.id}/${j.taskId}@${j.at}`, taskId: j.taskId, taskTitle: task ? titleOf(workflow, task) : j.taskId }
  })
}

/** The episode of a session's dialog (permission, question): apart from its Stop's, which its turn start re-arms. */
function dialogKey(workflowId: string, owner: WorkflowOwner): string {
  return `${slotKey(workflowId, owner)}#p`
}

/** Is this session the one its task waits on? A loop's worker idles while its change is in review; a finished reviewer stays current until the next starts. */
function speaks(task: WorkflowTask, owner: WorkflowOwner): boolean {
  const round = currentRound(task)
  if (owner.review === undefined) return task.kind !== 'loop' || !round || round.review === 'pending'
  return round?.reviewer === owner.review && (round.review === 'running' || round.review === 'waiting')
}

function workflowOwnerOf(terminalId: string): WorkflowOwner | null {
  const owner = parseSessionOwner(getPeer(terminalId)?.owner)
  return owner?.kind === 'workflow' ? owner : null
}

/** The workflow session a terminal is, while it holds its task's current slot. */
function currentOwner(terminalId: string): { workflow: Workflow; task: WorkflowTask; owner: WorkflowOwner } | null {
  const owner = workflowOwnerOf(terminalId)
  if (!owner) return null
  const workflow = getWorkflow(owner.workflowId)
  const task = workflow?.tasks.find((t) => t.id === owner.taskId)
  if (!workflow || !task || !ownerIsCurrent(task, owner)) return null
  return { workflow, task, owner }
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

export interface WorkflowHost extends WorkflowEngine {
  /** Quit: drop pending phone updates. */
  stop(): void
}

export function initWorkflows(deps: WorkflowHostDeps): WorkflowHost {
  let settings = loadWorkflowSettings()
  const lastSent = new Map<string, string>()
  /** What phones last got, per workflow, and when. */
  const lastRemote = new Map<string, { text: string; at: number }>()
  const remoteTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Workflows this run has looked at for push: what already waited then is not news. */
  const alertSeen = new Set<string>()

  /** A phone's copy: slim, plus what a phone can't know for sessions it doesn't list. */
  function forPhone(snapshot: WorkflowSnapshot): WorkflowSnapshot {
    const leadTerminalId = leadTerminal(snapshot.workflow.leadKey)
    const live = new Map(peersWithWindows().map((p) => [p.terminalId, p.status]))
    const statuses: Record<string, AgentStatus> = {}
    for (const id of [...Object.values(snapshot.workers), ...Object.values(snapshot.reviewers), ...(leadTerminalId ? [leadTerminalId] : [])]) {
      const status = live.get(id)
      if (status && status !== 'unknown') statuses[id] = status
    }
    return { ...slimWorkflowSnapshot(snapshot), statuses, leadTerminalId, leadWindowId: engine.leadWindowOf(snapshot.workflow) }
  }

  function sendRemote(id: string, snapshot: WorkflowSnapshot, text: string): void {
    lastRemote.set(id, { text, at: Date.now() })
    deps.clients.sendRemote?.('workflow:changed', snapshot)
  }

  /** Statuses changed but nothing a window shows: phones only, throttled, sent as of when the timer fires. */
  function statusesChanged(id: string): void {
    if (remoteTimers.has(id)) return
    const wait = (lastRemote.get(id)?.at ?? 0) + STATUS_THROTTLE_MS - Date.now()
    const flush = (): void => {
      remoteTimers.delete(id)
      const current = engine.snapshot(id)
      if (!current) return
      const remote = forPhone(current)
      const text = JSON.stringify(remote)
      if (lastRemote.get(id)?.text !== text) sendRemote(id, remote, text)
    }
    if (wait <= 0) flush()
    else {
      const timer = setTimeout(flush, wait)
      timer.unref?.()
      remoteTimers.set(id, timer)
    }
  }

  /** The first look at a workflow this run spends what is already waiting, quietly. */
  function firstSight(workflow: Workflow): void {
    if (alertSeen.has(workflow.id)) return
    alertSeen.add(workflow.id)
    const items = [...waitingItems(workflow), ...judgmentItems(workflow, workflow.judgments)]
    if (items.length > 0) deps.push?.alert(alertFor(workflow, 'waiting', items), { quiet: true })
  }

  /** Dialog episodes alerted and not yet over. */
  const openDialogs = new Set<string>()

  /** Whether what an alert named still waits, for one the debounce held back. */
  function stillPending(workflowId: string, key: string): boolean {
    if (key.endsWith('#p')) return openDialogs.has(key)
    const workflow = getWorkflow(workflowId)
    if (!workflow) return false
    if (waitingItems(workflow).some((i) => i.key === key)) return true
    return workflow.judgments.some((j) => `${workflow.id}/${j.taskId}@${j.at}` === key)
  }

  function alertFor(workflow: Workflow, kind: WorkflowAlert['kind'], items: WorkflowAlertItem[]): WorkflowAlert {
    return {
      kind,
      workflowId: workflow.id,
      workflowTitle: workflow.title,
      leadLabel: workflow.leadLabel,
      windowId: engine.leadWindowOf(workflow),
      items,
      pending: (key) => stillPending(workflow.id, key),
    }
  }

  /** The session's dialog is over (it runs again, stopped or started a turn): its next one is news. */
  function dialogOver(terminalId: string): void {
    const owner = workflowOwnerOf(terminalId)
    if (!owner) return
    const key = dialogKey(owner.workflowId, owner)
    openDialogs.delete(key)
    deps.push?.rearm(key)
  }

  function alertWaiting(workflow: Workflow): void {
    firstSight(workflow)
    const items = waitingItems(workflow)
    if (items.length > 0) deps.push?.alert(alertFor(workflow, 'waiting', items))
  }

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
      const id = snapshot.workflow.id
      if (snapshot.dismissed) {
        lastSent.delete(id)
        lastRemote.delete(id)
        clearTimeout(remoteTimers.get(id))
        remoteTimers.delete(id)
        alertSeen.delete(id)
        deps.push?.forget(id)
        for (const k of openDialogs) if (k.startsWith(`${id}/`)) openDialogs.delete(k)
        if (deps.clients.sendSplit) deps.clients.sendSplit('workflow:changed', snapshot, slimWorkflowSnapshot(snapshot))
        else deps.clients.send('workflow:changed', snapshot)
        return
      }
      alertWaiting(snapshot.workflow)
      // Peer syncs arrive on every status change; most leave every workflow as
      // it was for a window, but phones read the statuses from the snapshot.
      const text = JSON.stringify(snapshot)
      const remote = forPhone(snapshot)
      const remoteText = JSON.stringify(remote)
      if (lastSent.get(id) !== text) {
        lastSent.set(id, text)
        lastRemote.set(id, { text: remoteText, at: Date.now() })
        clearTimeout(remoteTimers.get(id))
        remoteTimers.delete(id)
        if (deps.clients.sendSplit) deps.clients.sendSplit('workflow:changed', snapshot, remote)
        else deps.clients.send('workflow:changed', snapshot)
        return
      }
      if (lastRemote.get(id)?.text !== remoteText) statusesChanged(id)
    },
    leadWoken(workflow, judgments) {
      firstSight(workflow)
      deps.push?.alert(alertFor(workflow, 'lead-woken', judgmentItems(workflow, judgments)))
    },
    log: (message) => console.log(message),
  })

  onPeersChanged(() => engine.onPeersChanged())
  // A worker's permission prompt or idle prompt: precise, and its own pushes are ignored as an owned session's.
  // A worker's dialog. Its idle prompt is left out: a Stop without a result is
  // already a waiting task (`waitingItems`), and one after a result waits on nobody.
  onAgentStatus((event) => {
    if (!event.precise) return
    if (event.status === 'running') dialogOver(event.terminalId)
    if (event.status !== 'waiting' || !isDialogNotification(event.notificationType, event.message)) return
    const found = currentOwner(event.terminalId)
    if (!found || (found.task.state !== 'running' && found.task.state !== 'waiting')) return
    const { workflow, task, owner } = found
    if (!speaks(task, owner) || (task.state === 'waiting' && !waitsOnUser(task)) || workflow.judgments.some((j) => j.taskId === task.id)) return
    const who = owner.review !== undefined ? 'reviewer' : 'worker'
    const key = dialogKey(workflow.id, owner)
    openDialogs.add(key)
    firstSight(workflow)
    deps.push?.alert(
      alertFor(workflow, 'waiting', [
        { key, taskId: task.id, taskTitle: titleOf(workflow, task), note: event.message?.trim() || `The ${who} is asking for permission or input.` },
      ]),
    )
  })
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

  /** The phone is read-only: what changes a workflow belongs to the desktop. */
  function desktopOnly(channel: string, sender: RemoteClient): void {
    if (sender.clientKey !== undefined) throw new Error(`${channel} is not available to remote clients`)
  }

  handleInvoke('workflow:list', (event): WorkflowList => {
    const project = projectFor(event.sender.id)
    const workflows = engine.list(project)
    return { project, workflows: event.sender.clientKey !== undefined ? workflows.map(forPhone) : workflows }
  })
  handleInvoke('workflow:start', (event, id: unknown) => {
    desktopOnly('workflow:start', event.sender)
    return asError(() => engine.start(ownWorkflow(event.sender.id, id), 'user'))
  })
  handleInvoke('workflow:cancel', (event, id: unknown) => {
    desktopOnly('workflow:cancel', event.sender)
    return asError(() => engine.cancel(ownWorkflow(event.sender.id, id)))
  })
  handleInvoke('workflow:dismiss', (event, id: unknown) => {
    desktopOnly('workflow:dismiss', event.sender)
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
    turnStarted(terminalId) {
      const owner = workflowOwnerOf(terminalId)
      if (owner) deps.push?.rearm(slotKey(owner.workflowId, owner))
      dialogOver(terminalId)
      engine.onTurnStarted(terminalId)
    },
    turnEnded(terminalId) {
      dialogOver(terminalId)
      engine.onTurnEnded(terminalId)
    },
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

  return {
    ...engine,
    stop() {
      for (const timer of remoteTimers.values()) clearTimeout(timer)
      remoteTimers.clear()
    },
  }
}
