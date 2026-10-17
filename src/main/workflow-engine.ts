/**
 * Runs workflows: starts every task whose `after` tasks are done, takes
 * workers' results, retries or escalates failures, and wakes the lead only
 * at judgment points.
 *
 * Workers are ordinary terminal sessions owned by the workflow
 * (`SessionOwner` kind `workflow`). Only a renderer can create a session, so
 * the engine asks the lead's window for each one, and a workflow whose lead
 * window is closed starts nothing new (`paused: window-closed`) while running
 * workers carry on.
 *
 * Terminal ids are never stored: they change on restore. The engine learns
 * which terminal is which task's worker from the agent-bus peer list, whose
 * entries carry their owner, so a restored worker re-attaches by its owner.
 */
import type { SessionOwner, WorkflowOwner } from '../shared/session-owner'
import {
  WORKFLOW_MAX_ATTEMPTS_ON_RETRY,
  WORKFLOW_MAX_SUMMARY,
  WorkflowValidationError,
  archiveAttempt,
  isFinished,
  type Workflow,
  type WorkflowJudgment,
  type WorkflowOp,
  type WorkflowSettings,
  type WorkflowSnapshot,
  type WorkflowTask,
  type WorkflowTaskResult,
} from '../shared/workflow'
import { applyOps, archiveWorkflow, createWorkflow, getWorkflow, listLiveWorkflows, listWorkflows, rekeyLead, saveWorkflow } from './workflow-store'
import { MAX_MESSAGE_CHARS } from './agent-bus'
import type { NewWorkflowInput } from '../shared/workflow'

/** A live session as the bus lists it, with the window that listed it. */
export interface EnginePeer {
  terminalId: string
  windowId: number
  worktreePath: string
  status: string
  owner?: SessionOwner
}

export interface SpawnRequest {
  leadTerminalId: string | null
  brief: string
  label: string
  provider?: 'claude' | 'codex'
  model?: string
  reasoningEffort?: string
  worktreePath: string
  owner: WorkflowOwner
}

export interface EngineHost {
  peers(): EnginePeer[]
  /** The lead's live terminal, from its stable key. */
  leadTerminal(leadKey: string): string | null
  /** Start a worker in a window. Resolves with its terminal id, or null when none came back in time. */
  spawnWorker(windowId: number, request: SpawnRequest): Promise<string | null>
  /** The worktree for a branch, created beside the bare repo when missing. */
  ensureWorktree(project: string, branch: string, base?: string): Promise<string>
  /** Where a task without its own worktree runs when the lead's isn't known. */
  mainWorktree(project: string): Promise<string | null>
  /** Mail from SimpleEdit to a session, waking it. Its message id, or null when it can't be queued. */
  sendMail(toTerminalId: string, text: string): string | null
  /** Mail lives in memory: `lost` once it was dropped with its recipient, or the app restarted. */
  mailState(messageId: string): 'pending' | 'read' | 'lost'
  /** Drop a worker's owner: it becomes a normal sidebar session. */
  detachWorker(windowId: number, terminalId: string): void
  disposeWorker(windowId: number, terminalId: string): void
  /** End a worker's process from main, for a window that is already gone. */
  killWorker(terminalId: string): void
  isLocalModel(provider: string | undefined, model: string | undefined): Promise<boolean>
  settings(): WorkflowSettings
  broadcast(snapshot: WorkflowSnapshot): void
  log(message: string): void
}

/** The concurrency gate's limits (`agent-tasks/gate.ts`), counted over workflow workers only. */
const CLOUD_LIMIT = 4
const LOCAL_LIMIT = 1

const NOTE_STOPPED = 'Turn ended without report_result: the worker may be asking you something.'
const NOTE_CLOSED = 'The worker session ended without reporting a result.'
/** A judgment's question is cut here in mail; `get_workflow` has it whole. */
const MAX_MAILED_QUESTION = 1_500

function key(workflowId: string, taskId: string): string {
  return `${workflowId}/${taskId}`
}

export interface WorkflowEngine {
  create(project: string, lead: { terminalId: string; key: string; label: string }, input: NewWorkflowInput): WorkflowSnapshot
  patch(id: string, baseVersion: number, ops: WorkflowOp[]): { ok: true; snapshot: WorkflowSnapshot } | { ok: false; conflict: { version: number } }
  start(id: string, by: 'user' | 'lead'): WorkflowSnapshot
  cancel(id: string): WorkflowSnapshot
  dismiss(id: string): void
  snapshot(id: string): WorkflowSnapshot | null
  list(project: string): WorkflowSnapshot[]
  reportResult(terminalId: string, raw: Record<string, unknown>): { workflowId: string; taskId: string; state: string }
  /** The workflow and task a terminal works on, if it is a current worker. */
  workerOf(terminalId: string): { workflowId: string; taskId: string } | null
  isLead(terminalId: string, workflow: Workflow): boolean
  onPeersChanged(): void
  onHosts(windowId: number, leadKeys: string[]): void
  onWindowClosed(windowId: number): void
  onTurnEnded(terminalId: string): void
  onTurnStarted(terminalId: string): void
  onUserInput(terminalId: string): void
  /** The lead handed off (`spawn_session` replace) or got its provider session id: its workflows follow the new key. */
  rekeyLead(fromKey: string, toKey: string): void
  /** Wait for in-flight spawns (tests). */
  idle(): Promise<void>
}

export function createWorkflowEngine(host: EngineHost): WorkflowEngine {
  /** Leads each window holds, live or waiting to be resumed. */
  const hosts = new Map<number, Set<string>>()
  /**
   * Attempts (`workflow/task#attempt`) the engine started in this app run, so a
   * re-attached worker can be told what happened. Recorded before the spawn:
   * the bus lists a new worker before its terminal id comes back.
   */
  const spawnedThisRun = new Set<string>()
  /** A task whose worker couldn't be started waits until then (epoch ms) before the next try. */
  const retryAfter = new Map<string, number>()
  const SPAWN_RETRY_MS = 5_000
  /** How long after a spawn's handle timed out its worker may still show up. */
  const SPAWN_GRACE_MS = 20_000
  /** Attempts given up on: a worker of one that shows up late is closed, not adopted. */
  const abandoned = new Set<string>()
  /** A restored window gets this long to bring back a running task's worker. */
  const RESTORE_GRACE_MS = 90_000
  const orphanChecks = new Set<string>()
  /** Pending "did its worker ever appear" checks by attempt, cancelled when a closing window makes them moot. */
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Every worker terminal seen per task, and in which window: a worker that vanishes from a live window ended. */
  const seen = new Map<string, { terminalId: string; windowId: number; attempt: number }>()
  const starting = new Set<string>()
  const pending = new Set<Promise<unknown>>()
  /** `workflow/task#attempt@terminal` of re-attached workers already told to carry on. */
  const nudged = new Set<string>()
  /** Mail id per judgment (`workflow/task@at`) sent but not yet read by the lead. */
  const mailed = new Map<string, string>()
  /** Workers detached by a cancel whose renderer may not have dropped their owner before Dismiss. */
  const released = new Set<string>()

  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p)
    void p.finally(() => pending.delete(p))
    return p
  }

  function workerPeers(): Map<string, EnginePeer> {
    const out = new Map<string, EnginePeer>()
    for (const peer of host.peers()) {
      const owner = peer.owner
      if (owner?.kind !== 'workflow' || !owner.workflowId || !owner.taskId) continue
      out.set(`${key(owner.workflowId, owner.taskId)}#${owner.attempt}`, peer)
    }
    return out
  }

  function currentWorker(workflow: Workflow, task: WorkflowTask, peers = workerPeers()): EnginePeer | null {
    return peers.get(`${key(workflow.id, task.id)}#${task.attempt}`) ?? null
  }

  function leadWindow(workflow: Workflow): number | null {
    const terminal = host.leadTerminal(workflow.leadKey)
    if (terminal) {
      const peer = host.peers().find((p) => p.terminalId === terminal)
      if (peer) return peer.windowId
    }
    for (const [windowId, keys] of hosts) if (keys.has(workflow.leadKey)) return windowId
    return null
  }

  function snapshotOf(workflow: Workflow): WorkflowSnapshot {
    const peers = workerPeers()
    const workers: Record<string, string> = {}
    for (const task of workflow.tasks) {
      if (task.attempt === 0) continue
      const peer = currentWorker(workflow, task, peers)
      if (peer) workers[task.id] = peer.terminalId
    }
    const paused = workflow.status === 'running' && leadWindow(workflow) === null ? 'window-closed' : null
    return { workflow, paused, workers, reviewers: {} }
  }

  function publish(workflow: Workflow): WorkflowSnapshot {
    const snapshot = snapshotOf(workflow)
    host.broadcast(snapshot)
    return snapshot
  }

  function save(workflow: Workflow): void {
    saveWorkflow(workflow)
    publish(workflow)
  }

  function mustGet(id: string): Workflow {
    const workflow = getWorkflow(id)
    if (!workflow) throw new WorkflowValidationError([`no workflow ${id}`])
    return workflow
  }

  // -- Judgment points --------------------------------------------

  function raise(workflow: Workflow, taskId: string, question: string): void {
    workflow.judgments = [
      ...workflow.judgments.filter((j) => j.taskId !== taskId),
      { taskId, question, at: new Date().toISOString(), delivered: false },
    ]
  }

  function judgmentKey(workflowId: string, judgment: WorkflowJudgment): string {
    return `${key(workflowId, judgment.taskId)}@${judgment.at}`
  }

  /**
   * Mail the lead every judgment it hasn't read, packed into as few messages as
   * fit the bus's size cap. `delivered` is stored only once the lead read it:
   * mail lives in memory, so mail lost with a restart or with the lead's exit
   * is sent again. Returns true when the workflow changed.
   */
  function deliverJudgments(workflow: Workflow): boolean {
    let changed = false
    const unsent: WorkflowJudgment[] = []
    workflow.judgments = workflow.judgments.map((j): WorkflowJudgment => {
      if (j.delivered) return j
      const k = judgmentKey(workflow.id, j)
      const messageId = mailed.get(k)
      const state = messageId ? host.mailState(messageId) : 'lost'
      if (state === 'pending') return j
      mailed.delete(k)
      if (state === 'read') {
        changed = true
        return { ...j, delivered: true }
      }
      unsent.push(j)
      return j
    })
    if (unsent.length === 0) return changed
    const lead = host.leadTerminal(workflow.leadKey)
    if (!lead || !host.peers().some((p) => p.terminalId === lead)) return changed
    const head = `[SimpleEdit workflow "${workflow.title}" (${workflow.id}) needs your decision]`
    const foot = 'Answer with patch_workflow (retry, update, cancel or add tasks), reply to the worker with send_message, or ask the user. get_workflow shows the whole state.'
    const budget = MAX_MESSAGE_CHARS - head.length - foot.length - 2
    let batch: Array<{ judgment: WorkflowJudgment; line: string }> = []
    let size = 0
    const flush = (): boolean => {
      if (batch.length === 0) return true
      const messageId = host.sendMail(lead, [head, ...batch.map((b) => b.line), foot].join('\n'))
      if (!messageId) return false
      for (const b of batch) mailed.set(judgmentKey(workflow.id, b.judgment), messageId)
      host.log(`[Workflows] Woke lead of ${workflow.id} about ${batch.map((b) => b.judgment.taskId).join(', ')}`)
      batch = []
      size = 0
      return true
    }
    for (const judgment of unsent) {
      const question =
        judgment.question.length > MAX_MAILED_QUESTION ? `${judgment.question.slice(0, MAX_MAILED_QUESTION)}… (get_workflow has the rest)` : judgment.question
      const line = `- task ${judgment.taskId}: ${question}`
      if (size + line.length + 1 > budget && !flush()) return changed
      batch.push({ judgment, line })
      size += line.length + 1
    }
    flush()
    return changed
  }

  // -- Scheduling -------------------------------------------------

  /** Settle the workflow's own status from its tasks. Returns true when it changed. */
  function settle(workflow: Workflow): boolean {
    if (workflow.status !== 'running' && workflow.status !== 'failed') return false
    const live = workflow.tasks.filter((t) => t.state !== 'cancelled')
    const before = workflow.status
    if (live.length === 0) {
      workflow.status = 'cancelled'
      workflow.finishedAt = new Date().toISOString()
      workflow.judgments = []
      return true
    }
    if (live.every((t) => t.state === 'done')) {
      workflow.status = 'done'
      workflow.finishedAt = new Date().toISOString()
      return true
    }
    const byId = new Map(workflow.tasks.map((t) => [t.id, t]))
    const active = workflow.tasks.some((t) => t.state === 'running' || t.state === 'waiting' || starting.has(key(workflow.id, t.id)))
    const startable = workflow.tasks.some((t) => t.state === 'queued' && t.after.every((d) => byId.get(d)?.state === 'done'))
    if (!active && !startable) {
      const blocked = workflow.tasks.filter((t) => t.state === 'queued')
      for (const task of blocked) {
        const stuckOn = task.after.filter((d) => byId.get(d)?.state !== 'done')
        if (!workflow.judgments.some((j) => j.taskId === task.id)) {
          raise(workflow, task.id, `can't start: it runs after ${stuckOn.map((d) => `${d} (${byId.get(d)?.state ?? 'missing'})`).join(', ')}.`)
        }
      }
      workflow.status = 'failed'
      workflow.finishedAt ??= new Date().toISOString()
    } else {
      workflow.status = 'running'
      delete workflow.finishedAt
    }
    return workflow.status !== before
  }

  const locality = new Map<string, boolean>()

  async function isLocal(workflowId: string, task: WorkflowTask): Promise<boolean> {
    const k = `${key(workflowId, task.id)}@${task.provider ?? ''}:${task.model ?? ''}`
    let local = locality.get(k)
    if (local === undefined) {
      local = await host.isLocalModel(task.provider, task.model)
      locality.set(k, local)
    }
    return local
  }

  let scheduling: Promise<void> | null = null
  let again = false

  /**
   * Start every task whose `after` tasks are done, within the backend limits.
   * One pass at a time: a pass decides start by start, so two passes can't
   * both take the last free slot.
   */
  function schedule(): void {
    if (scheduling) {
      again = true
      return
    }
    scheduling = track(
      (async () => {
        do {
          again = false
          await schedulePass()
        } while (again)
      })().finally(() => {
        scheduling = null
        if (again) schedule()
      }),
    )
  }

  async function schedulePass(): Promise<void> {
    const workflows = listLiveWorkflows()
    const busy = { local: 0, cloud: 0 }
    for (const workflow of workflows) {
      for (const task of workflow.tasks) {
        if (task.state === 'running' || task.state === 'waiting' || starting.has(key(workflow.id, task.id))) {
          busy[(await isLocal(workflow.id, task)) ? 'local' : 'cloud']++
        }
      }
    }
    for (const workflow of workflows) {
      if (workflow.status !== 'running') continue
      const windowId = leadWindow(workflow)
      if (windowId === null) continue
      const byId = new Map(workflow.tasks.map((t) => [t.id, t]))
      for (const task of workflow.tasks) {
        const k = key(workflow.id, task.id)
        if (task.state !== 'queued' || starting.has(k)) continue
        if ((retryAfter.get(k) ?? 0) > Date.now()) continue
        if (!task.after.every((d) => byId.get(d)?.state === 'done')) continue
        const backend = (await isLocal(workflow.id, task)) ? 'local' : 'cloud'
        if (busy[backend] >= (backend === 'local' ? LOCAL_LIMIT : CLOUD_LIMIT)) continue
        busy[backend]++
        starting.add(k)
        void track(startTask(workflow.id, task.id, windowId).finally(() => {
          starting.delete(k)
          schedule()
        }))
      }
    }
  }

  function tickAll(): void {
    for (const workflow of listLiveWorkflows()) {
      if (deliverJudgments(workflow)) saveWorkflow(workflow)
      publish(workflow)
    }
    schedule()
  }

  function resolveTemplates(brief: string, workflow: Workflow): string {
    const byId = new Map(workflow.tasks.map((t) => [t.id, t]))
    return brief.replace(/\{\{\s*task\.([a-z0-9][a-z0-9_-]{0,39})\.result\.(summary|branch|changedFiles|items)\s*\}\}/g, (_m, id: string, field: string) => {
      const result = byId.get(id)?.result
      if (!result) return '(no result)'
      if (field === 'summary') return result.summary
      if (field === 'branch') return result.branch ?? byId.get(id)?.worktree?.branch ?? '(no branch)'
      const list = field === 'items' ? result.items : result.changedFiles
      return list && list.length > 0 ? list.join(', ') : '(none)'
    })
  }

  function briefFor(workflow: Workflow, task: WorkflowTask, attempt: number, worktreePath: string): string {
    const byId = new Map(workflow.tasks.map((t) => [t.id, t]))
    const parts = [resolveTemplates(task.brief, workflow)]
    if (task.kind === 'integrate') {
      const shape = {
        single: 'one branch and one PR that contains all of them',
        stack: 'a stack of dependent PRs, in the order listed (`gh stack`)',
        separate: 'one PR per branch, each made to merge cleanly beside the others',
      }[task.shape ?? 'single']
      parts.push(
        [
          'Combine the work of these tasks:',
          ...task.after.map((id) => {
            const dep = byId.get(id)
            const branch = dep?.result?.branch ?? dep?.worktree?.branch ?? '(no branch: it worked in the lead worktree)'
            return `- ${id} (${dep?.title ?? id}): branch ${branch}${dep?.result?.summary ? ` — ${dep.result.summary}` : ''}`
          }),
          `Shape: ${shape}. Resolve conflicts yourself; report a conflict you can't decide with status "needs_lead".`,
        ].join('\n'),
      )
    }
    const previous = attempt > 1 ? (task.note ?? task.history?.find((h) => h.attempt === attempt - 1)?.note) : undefined
    parts.push(
      [
        '---',
        `You are a worker in the SimpleEdit workflow "${workflow.title}" (workflow ${workflow.id}, task ${task.id}${attempt > 1 ? `, attempt ${attempt}` : ''}).`,
        `Work in ${worktreePath}${task.worktree ? ` on branch ${task.worktree.branch}` : ''}.`,
        ...(task.acceptance ? [`Done means: ${task.acceptance}`] : []),
        ...(previous ? [`An earlier attempt failed: ${previous}`] : []),
        'When you are finished, call the report_result tool once: status "done" with a short summary (plus branch and changedFiles), "failed" if you can\'t complete it, or "needs_lead" with your question if a decision is needed. Ending your turn without report_result tells SimpleEdit you are waiting for the user.',
      ].join('\n'),
    )
    return parts.join('\n\n')
  }

  async function startTask(workflowId: string, taskId: string, windowId: number): Promise<void> {
    let workflow = getWorkflow(workflowId)
    let task = workflow?.tasks.find((t) => t.id === taskId)
    if (!workflow || !task || workflow.status !== 'running' || task.state !== 'queued') return
    let worktreePath: string | null
    try {
      if (task.worktree) {
        worktreePath = await host.ensureWorktree(workflow.project, task.worktree.branch, task.worktree.base)
      } else {
        const lead = host.leadTerminal(workflow.leadKey)
        worktreePath = host.peers().find((p) => p.terminalId === lead)?.worktreePath ?? (await host.mainWorktree(workflow.project))
      }
    } catch (error) {
      worktreePath = null
      host.log(`[Workflows] ${workflowId}/${taskId}: worktree failed: ${error instanceof Error ? error.message : String(error)}`)
      const fresh = getWorkflow(workflowId)
      const t = fresh?.tasks.find((x) => x.id === taskId)
      if (fresh && t && t.state === 'queued') {
        t.state = 'failed'
        t.note = `Couldn't prepare worktree ${task.worktree?.branch}: ${error instanceof Error ? error.message : String(error)}`
        t.finishedAt = new Date().toISOString()
        raise(fresh, t.id, t.note)
        settle(fresh)
        deliverJudgments(fresh)
        save(fresh)
      }
      return
    }
    if (!worktreePath) return

    // Re-read: the worktree await let patches and cancels in.
    workflow = getWorkflow(workflowId)
    task = workflow?.tasks.find((t) => t.id === taskId)
    if (!workflow || !task || workflow.status !== 'running' || task.state !== 'queued') return
    const attempt = task.attempt + 1
    const brief = briefFor(workflow, task, attempt, worktreePath)
    archiveAttempt(task)
    task.attempt = attempt
    task.state = 'running'
    task.worktreePath = worktreePath
    task.steered = false
    task.startedAt = new Date().toISOString()
    delete task.finishedAt
    save(workflow)
    host.log(`[Workflows] Starting ${workflowId}/${taskId} attempt ${attempt} in ${worktreePath}`)
    sweepStrays()

    const owner: WorkflowOwner = { kind: 'workflow', workflowId, taskId, attempt }
    spawnedThisRun.add(`${key(workflowId, taskId)}#${attempt}`)
    try {
      const terminalId = await host.spawnWorker(windowId, {
        leadTerminalId: host.leadTerminal(workflow.leadKey),
        brief,
        label: task.title,
        ...(task.provider ? { provider: task.provider } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.effort ? { reasoningEffort: task.effort } : {}),
        worktreePath,
        owner,
      })
      if (terminalId) retryAfter.delete(key(workflowId, taskId))
      // Unless its window closed meanwhile: the reopened window's restore check covers it then.
      else if (spawnedThisRun.has(`${key(workflowId, taskId)}#${attempt}`)) armGrace(workflowId, taskId, attempt, SPAWN_GRACE_MS)
    } catch (error) {
      const fresh = getWorkflow(workflowId)
      const t = fresh?.tasks.find((x) => x.id === taskId)
      if (!fresh || !t || t.attempt !== attempt || t.state !== 'running') return
      // Nothing started: the attempt doesn't count.
      t.state = 'queued'
      t.attempt = attempt - 1
      t.note = `Couldn't start a worker: ${error instanceof Error ? error.message : String(error)}`
      save(fresh)
      retryAfter.set(key(workflowId, taskId), Date.now() + SPAWN_RETRY_MS)
      setTimeout(schedule, SPAWN_RETRY_MS).unref?.()
    }
  }

  function armGrace(workflowId: string, taskId: string, attempt: number, ms: number): void {
    const attemptKey = `${key(workflowId, taskId)}#${attempt}`
    clearTimeout(graceTimers.get(attemptKey))
    const timer = setTimeout(() => {
      graceTimers.delete(attemptKey)
      abandonIfUnbound(workflowId, taskId, attempt)
    }, ms)
    timer.unref?.()
    graceTimers.set(attemptKey, timer)
  }

  function cancelGrace(attemptKey: string): void {
    clearTimeout(graceTimers.get(attemptKey))
    graceTimers.delete(attemptKey)
  }

  /** A spawn whose handle never came back and whose worker never appeared failed. */
  function abandonIfUnbound(workflowId: string, taskId: string, attempt: number): void {
    const workflow = getWorkflow(workflowId)
    const task = workflow?.tasks.find((t) => t.id === taskId)
    if (!workflow || !task || task.attempt !== attempt || (task.state !== 'running' && task.state !== 'waiting')) return
    if (currentWorker(workflow, task)) return
    abandoned.add(`${key(workflowId, taskId)}#${attempt}`)
    host.log(`[Workflows] ${workflowId}/${taskId} attempt ${attempt}: no worker appeared`)
    fail(workflow, task, 'The worker session never started or was lost.')
    settle(workflow)
    deliverJudgments(workflow)
    save(workflow)
    schedule()
  }

  /**
   * Workers the engine has let go of but whose session is still owned: one
   * that appeared only after its task was cancelled or its spawn abandoned, one
   * a retry replaced, or one whose workflow was dismissed. Detach or close them
   * on sight.
   */
  function sweepStrays(): void {
    const workflows = new Map<string, Workflow | null>()
    const owned = new Set<string>()
    for (const peer of host.peers()) {
      const owner = peer.owner
      if (owner?.kind !== 'workflow') continue
      owned.add(peer.terminalId)
      if (released.has(peer.terminalId)) {
        host.detachWorker(peer.windowId, peer.terminalId)
        continue
      }
      if (!workflows.has(owner.workflowId)) workflows.set(owner.workflowId, getWorkflow(owner.workflowId))
      const workflow = workflows.get(owner.workflowId)
      const task = workflow?.tasks.find((t) => t.id === owner.taskId)
      if (!workflow || abandoned.has(`${key(owner.workflowId, owner.taskId)}#${owner.attempt}`) || (task && owner.attempt < task.attempt)) {
        host.disposeWorker(peer.windowId, peer.terminalId)
      } else if (task?.state === 'cancelled' && task.detached && task.attempt === owner.attempt) {
        host.detachWorker(peer.windowId, peer.terminalId)
      }
    }
    for (const terminalId of released) if (!owned.has(terminalId)) released.delete(terminalId)
  }

  /** Forget everything held in memory about a workflow. */
  function prune(workflowId: string): void {
    const prefix = `${workflowId}/`
    for (const set of [spawnedThisRun, abandoned, orphanChecks, nudged]) {
      for (const k of set) if (k.startsWith(prefix)) set.delete(k)
    }
    for (const [k, timer] of graceTimers) {
      if (!k.startsWith(prefix)) continue
      clearTimeout(timer)
      graceTimers.delete(k)
    }
    for (const map of [retryAfter, seen, locality, mailed] as Array<Map<string, unknown>>) {
      for (const k of map.keys()) if (k.startsWith(prefix)) map.delete(k)
    }
  }

  // -- Task outcomes ----------------------------------------------

  function locate(terminalId: string): { workflow: Workflow; task: WorkflowTask; peer: EnginePeer } | null {
    const peer = host.peers().find((p) => p.terminalId === terminalId)
    const owner = peer?.owner
    if (!peer || owner?.kind !== 'workflow' || !owner.workflowId || !owner.taskId) return null
    const workflow = getWorkflow(owner.workflowId)
    const task = workflow?.tasks.find((t) => t.id === owner.taskId)
    if (!workflow || !task || task.attempt !== owner.attempt) return null
    return { workflow, task, peer }
  }

  function fail(workflow: Workflow, task: WorkflowTask, summary: string): void {
    task.finishedAt = new Date().toISOString()
    if (task.onFailure === 'retry' && task.attempt < WORKFLOW_MAX_ATTEMPTS_ON_RETRY) {
      task.state = 'queued'
      task.note = summary
      host.log(`[Workflows] Retrying ${workflow.id}/${task.id} after: ${summary}`)
      return
    }
    task.state = 'failed'
    task.note = summary
    raise(
      workflow,
      task.id,
      `failed${task.attempt > 1 ? ` after ${task.attempt} attempts` : ''}: ${summary}${task.steered ? ' (the user stepped into this worker)' : ''}`,
    )
  }

  function strings(v: unknown, max = 200): string[] | undefined {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new WorkflowValidationError(['expected a list of strings'])
    return (v as string[]).slice(0, max).map((s) => s.slice(0, 500))
  }

  return {
    create(project, lead, input) {
      const workflow = createWorkflow(project, { key: lead.key, label: lead.label }, input)
      host.log(`[Workflows] ${lead.label} created ${workflow.id} "${workflow.title}" (${workflow.tasks.length} tasks)`)
      return publish(workflow)
    },

    patch(id, baseVersion, ops) {
      const before = mustGet(id)
      const result = applyOps(id, baseVersion, ops)
      if (!result.ok) return result
      const workflow = result.workflow
      const peers = workerPeers()
      for (const task of workflow.tasks) {
        const old = before.tasks.find((t) => t.id === task.id)
        if (task.detached && !old?.detached) {
          const peer = old ? currentWorker(before, old, peers) : null
          if (peer) host.detachWorker(peer.windowId, peer.terminalId)
        }
      }
      settle(workflow)
      save(workflow)
      schedule()
      return { ok: true, snapshot: snapshotOf(getWorkflow(id) ?? workflow) }
    },

    start(id, by) {
      const workflow = mustGet(id)
      if (by === 'lead' && !host.settings().leadMayStart) {
        throw new WorkflowValidationError([
          'Starting is the user\'s call: ask them to review the graph in the Workflow tab and press Start. (Settings → Workflows lets leads start workflows themselves.)',
        ])
      }
      if (workflow.status !== 'draft') throw new WorkflowValidationError([`workflow ${id} is ${workflow.status}, not a draft`])
      workflow.status = 'running'
      workflow.startedAt = new Date().toISOString()
      save(workflow)
      host.log(`[Workflows] ${id} started by the ${by}`)
      schedule()
      return snapshotOf(getWorkflow(id) ?? workflow)
    },

    cancel(id) {
      const workflow = mustGet(id)
      if (isFinished(workflow.status) && workflow.status !== 'failed') return snapshotOf(workflow)
      const peers = workerPeers()
      const now = new Date().toISOString()
      for (const task of workflow.tasks) {
        if (task.state === 'done' || task.state === 'cancelled' || task.state === 'failed') continue
        if (task.state === 'running' || task.state === 'waiting') {
          const peer = currentWorker(workflow, task, peers)
          if (peer) host.detachWorker(peer.windowId, peer.terminalId)
          task.detached = true
        }
        task.state = 'cancelled'
        task.finishedAt = now
      }
      workflow.status = 'cancelled'
      workflow.finishedAt = now
      workflow.judgments = []
      save(workflow)
      return snapshotOf(workflow)
    },

    dismiss(id) {
      const workflow = mustGet(id)
      if (workflow.status === 'running') throw new WorkflowValidationError(['cancel the workflow before dismissing it'])
      const tasks = new Map(workflow.tasks.map((t) => [t.id, t]))
      for (const peer of host.peers()) {
        const owner = peer.owner
        if (owner?.kind !== 'workflow' || owner.workflowId !== id) continue
        const task = tasks.get(owner.taskId)
        if (task?.state === 'cancelled' && task.detached && task.attempt === owner.attempt) {
          released.add(peer.terminalId)
          host.detachWorker(peer.windowId, peer.terminalId)
        } else {
          host.disposeWorker(peer.windowId, peer.terminalId)
        }
      }
      archiveWorkflow(id)
      prune(id)
      host.log(`[Workflows] ${id} dismissed`)
      host.broadcast({ workflow, paused: null, workers: {}, reviewers: {}, dismissed: true })
    },

    snapshot(id) {
      const workflow = getWorkflow(id)
      return workflow ? snapshotOf(workflow) : null
    },

    list(project) {
      return listWorkflows(project).map(snapshotOf)
    },

    reportResult(terminalId, raw) {
      const found = locate(terminalId)
      if (!found) throw new WorkflowValidationError(['report_result is for workflow workers; this session is not one (or its task was replaced)'])
      const { workflow, task } = found
      if (task.state !== 'running' && task.state !== 'waiting') {
        throw new WorkflowValidationError([`task ${task.id} is ${task.state}; its result can't change now`])
      }
      const status = raw['status']
      if (status !== 'done' && status !== 'failed' && status !== 'needs_lead') throw new WorkflowValidationError(['status: "done", "failed" or "needs_lead"'])
      const summary = typeof raw['summary'] === 'string' ? raw['summary'].trim().slice(0, WORKFLOW_MAX_SUMMARY) : ''
      if (!summary) throw new WorkflowValidationError(['summary: say in a few lines what you did or what you need'])
      const branch = typeof raw['branch'] === 'string' && raw['branch'] ? raw['branch'].slice(0, 200) : undefined
      const verdict = raw['verdict']
      if (verdict !== undefined && verdict !== 'clean' && verdict !== 'findings') throw new WorkflowValidationError(['verdict: "clean" or "findings"'])
      const changedFiles = strings(raw['changedFiles'])
      const items = strings(raw['items'])
      const findings = strings(raw['findings'])
      const result: WorkflowTaskResult = {
        status,
        summary,
        ...(branch ? { branch } : {}),
        ...(changedFiles ? { changedFiles } : {}),
        ...(items ? { items } : {}),
        ...(verdict ? { verdict } : {}),
        ...(findings ? { findings } : {}),
        steered: task.steered,
        at: new Date().toISOString(),
      }
      task.result = result
      if (status === 'done') {
        task.state = 'done'
        task.finishedAt = result.at
        delete task.note
        workflow.judgments = workflow.judgments.filter((j) => j.taskId !== task.id)
      } else if (status === 'failed') {
        fail(workflow, task, summary)
      } else {
        task.state = 'waiting'
        task.note = `Asks the lead: ${summary}`
        raise(workflow, task.id, `asks (worker session ${terminalId}): ${summary}${task.steered ? ' (the user stepped into this worker)' : ''}`)
      }
      settle(workflow)
      deliverJudgments(workflow)
      save(workflow)
      host.log(`[Workflows] ${workflow.id}/${task.id} reported ${status}${task.steered ? ' (steered)' : ''}`)
      schedule()
      return { workflowId: workflow.id, taskId: task.id, state: task.state }
    },

    workerOf(terminalId) {
      const found = locate(terminalId)
      return found ? { workflowId: found.workflow.id, taskId: found.task.id } : null
    },

    isLead(terminalId, workflow) {
      return host.leadTerminal(workflow.leadKey) === terminalId
    },

    onPeersChanged() {
      sweepStrays()
      const peers = workerPeers()
      for (const workflow of listLiveWorkflows()) {
        let changed = false
        for (const task of workflow.tasks) {
          if (task.state !== 'running' && task.state !== 'waiting') continue
          const k = key(workflow.id, task.id)
          const peer = currentWorker(workflow, task, peers)
          const before = seen.get(k)
          if (peer) {
            seen.set(k, { terminalId: peer.terminalId, windowId: peer.windowId, attempt: task.attempt })
            const attemptKey = `${k}#${task.attempt}`
            if (spawnedThisRun.has(attemptKey)) continue
            if (before?.terminalId !== peer.terminalId) host.log(`[Workflows] Re-attached ${k} to ${peer.terminalId}`)
            const nudge = `${attemptKey}@${peer.terminalId}`
            if (task.state === 'running' && !nudged.has(nudge)) {
              const sent = host.sendMail(
                peer.terminalId,
                `SimpleEdit restarted while you worked on workflow task "${task.id}". Check where you left off, continue, and finish with report_result.`,
              )
              if (sent) nudged.add(nudge)
            }
            continue
          }
          // A worker this run saw is gone from a window that is still open: it was
          // closed or it exited. A closing window drops its hosts first (`onWindowClosed`).
          if (before && before.attempt === task.attempt && hostsWindow(before.windowId)) {
            seen.delete(k)
            fail(workflow, task, NOTE_CLOSED)
            changed = true
          }
        }
        if (changed) {
          settle(workflow)
          deliverJudgments(workflow)
          saveWorkflow(workflow)
        }
      }
      tickAll()
    },

    onHosts(windowId, leadKeys) {
      hosts.set(windowId, new Set(leadKeys))
      // After a restart a running task's worker comes back only if its session was saved.
      for (const workflow of listLiveWorkflows()) {
        if (leadWindow(workflow) !== windowId) continue
        for (const task of workflow.tasks) {
          const attemptKey = `${key(workflow.id, task.id)}#${task.attempt}`
          if ((task.state !== 'running' && task.state !== 'waiting') || spawnedThisRun.has(attemptKey) || orphanChecks.has(attemptKey)) continue
          orphanChecks.add(attemptKey)
          armGrace(workflow.id, task.id, task.attempt, RESTORE_GRACE_MS)
        }
      }
      tickAll()
    },

    onWindowClosed(windowId) {
      // The window's bridge stops with it, so its workers could never report.
      // Like a restart: they end now, and the reopened window resumes and
      // nudges them, or they fail after a fresh grace. Any check already
      // running would fail them early, so those go too.
      const forget = (attemptKey: string): void => {
        spawnedThisRun.delete(attemptKey)
        orphanChecks.delete(attemptKey)
        cancelGrace(attemptKey)
      }
      for (const workflow of listLiveWorkflows()) {
        if (leadWindow(workflow) !== windowId) continue
        for (const task of workflow.tasks) {
          if (task.state === 'running' || task.state === 'waiting') forget(`${key(workflow.id, task.id)}#${task.attempt}`)
        }
      }
      hosts.delete(windowId)
      for (const peer of host.peers()) {
        const owner = peer.owner
        if (peer.windowId !== windowId || owner?.kind !== 'workflow' || released.has(peer.terminalId)) continue
        const task = getWorkflow(owner.workflowId)?.tasks.find((t) => t.id === owner.taskId)
        if (task?.detached && task.attempt === owner.attempt) continue
        forget(`${key(owner.workflowId, owner.taskId)}#${owner.attempt}`)
        host.killWorker(peer.terminalId)
      }
      for (const [k, s] of seen) {
        if (s.windowId !== windowId) continue
        seen.delete(k)
        forget(`${k}#${s.attempt}`)
      }
      for (const workflow of listLiveWorkflows()) publish(workflow)
    },

    onTurnEnded(terminalId) {
      const found = locate(terminalId)
      if (!found || found.task.state !== 'running') return
      found.task.state = 'waiting'
      found.task.note = NOTE_STOPPED
      save(found.workflow)
    },

    onTurnStarted(terminalId) {
      const found = locate(terminalId)
      if (!found || found.task.state !== 'waiting') return
      // A new turn is the user's or the lead's answer arriving.
      found.task.state = 'running'
      delete found.task.note
      found.workflow.judgments = found.workflow.judgments.filter((j) => j.taskId !== found.task.id)
      save(found.workflow)
    },

    onUserInput(terminalId) {
      const found = locate(terminalId)
      if (!found || found.task.steered || (found.task.state !== 'running' && found.task.state !== 'waiting')) return
      found.task.steered = true
      save(found.workflow)
    },

    rekeyLead(fromKey, toKey) {
      const ids = rekeyLead(fromKey, toKey)
      if (ids.length === 0) return
      host.log(`[Workflows] Lead ${fromKey} is now ${toKey} for ${ids.join(', ')}`)
      for (const id of ids) {
        const workflow = getWorkflow(id)
        if (workflow) publish(workflow)
      }
      tickAll()
    },

    async idle() {
      while (pending.size > 0) await Promise.all([...pending])
    },
  }

  function hostsWindow(windowId: number): boolean {
    return hosts.has(windowId)
  }
}

