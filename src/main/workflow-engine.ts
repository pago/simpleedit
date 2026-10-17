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
  WORKFLOW_LOOP_ROUNDS_DEFAULT,
  WORKFLOW_MAX_ATTEMPTS_ON_RETRY,
  WORKFLOW_MAX_BRIEF,
  WORKFLOW_MAX_FINDINGS,
  WORKFLOW_MAX_GOAL,
  WORKFLOW_MAX_MAP_ITEMS,
  WORKFLOW_MAX_SUMMARY,
  WorkflowValidationError,
  archiveAttempt,
  childBranch,
  childTitle,
  childrenOf,
  currentRound,
  currentSlots,
  detachedSlot,
  isChild,
  isFinished,
  loopItems,
  loopPhase,
  overSource,
  ownerIsCurrent,
  slotKey,
  waitingSlot,
  type TaskSlot,
  type Workflow,
  type WorkflowJudgment,
  type WorkflowLoopRound,
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
  /** The main worktree's branch: what a reviewer diffs a loop's branch against when it names no base. */
  baseBranch(project: string): Promise<string | null>
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
  /** Judgments were handed to the lead's mailbox (again, when earlier mail was lost). */
  leadWoken?(workflow: Workflow, judgments: WorkflowJudgment[]): void
  log(message: string): void
}

/** The concurrency gate's limits (`agent-tasks/gate.ts`), counted over workflow workers only. */
const CLOUD_LIMIT = 4
const LOCAL_LIMIT = 1

const NOTE_STOPPED = 'Turn ended without report_result: the worker may be asking you something.'
const NOTE_REVIEWER_STOPPED = 'The reviewer ended its turn without a verdict: it may be asking you something.'
/** A `waiting` task waits on the user only when its session ended a turn without a result; any other wait is the lead's to answer. */
export function waitsOnUser(task: WorkflowTask): boolean {
  return task.state === 'waiting' && (task.note === NOTE_STOPPED || task.note === NOTE_REVIEWER_STOPPED)
}
const NOTE_CLOSED = 'The worker session ended without reporting a result.'
const NOTE_REVIEWER_CLOSED = 'The reviewer session ended without a verdict.'
/** A judgment's question is cut here in mail; `get_workflow` has it whole. */
const MAX_MAILED_QUESTION = 1_500
/** Findings named in a non-convergence judgment; `get_workflow` lists them all. */
const JUDGMENT_FINDINGS = 5
const MAILED_FINDING = 600
/** report_result's lists: at most this many entries of at most MAX_ENTRY characters. */
const MAX_LIST = 200
const MAX_ENTRY = 500

function key(workflowId: string, taskId: string): string {
  return `${workflowId}/${taskId}`
}

export type SessionRole = 'worker' | 'reviewer'

export type ReportOutcome =
  | 'done'
  | 'retrying'
  | 'failed'
  | 'asked-lead'
  | 'in-review'
  | 'findings-sent'
  | 'clean'
  | 'not-converged'
  | 'reviewer-retrying'

export interface ReportAnswer {
  workflowId: string
  taskId: string
  state: string
  role: SessionRole
  outcome: ReportOutcome
}

export interface WorkflowEngine {
  create(project: string, lead: { terminalId: string; key: string; label: string }, input: NewWorkflowInput): WorkflowSnapshot
  patch(id: string, baseVersion: number, ops: WorkflowOp[]): { ok: true; snapshot: WorkflowSnapshot } | { ok: false; conflict: { version: number } }
  start(id: string, by: 'user' | 'lead'): WorkflowSnapshot
  cancel(id: string): WorkflowSnapshot
  dismiss(id: string): void
  snapshot(id: string): WorkflowSnapshot | null
  list(project: string): WorkflowSnapshot[]
  reportResult(terminalId: string, raw: Record<string, unknown>): ReportAnswer
  /** The workflow and task a terminal works on, if it is a current worker or reviewer. */
  workerOf(terminalId: string): { workflowId: string; taskId: string } | null
  isLead(terminalId: string, workflow: Workflow): boolean
  /** The window hosting the workflow's lead, live or waiting to be resumed. */
  leadWindowOf(workflow: Workflow): number | null
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
   * Sessions (`slotKey`) the engine started in this app run, so a re-attached
   * one can be told what happened. Recorded before the spawn: the bus lists a
   * new session before its terminal id comes back.
   */
  const spawnedThisRun = new Set<string>()
  /** A task (or a loop's reviewer, `~r`) that couldn't be started waits until then (epoch ms) before the next try. */
  const retryAfter = new Map<string, number>()
  const SPAWN_RETRY_MS = 5_000
  /** How long after a spawn's handle timed out its worker may still show up. */
  const SPAWN_GRACE_MS = 20_000
  /** Sessions given up on: one that shows up late is closed, not adopted. */
  const abandoned = new Set<string>()
  /** A restored window gets this long to bring back a running task's worker. */
  const RESTORE_GRACE_MS = 90_000
  const orphanChecks = new Set<string>()
  /** Pending "did its session ever appear" checks by slot, cancelled when a closing window makes them moot. */
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Every session seen per task (`workflow/task`, a loop's reviewer `workflow/task~r`)
   * and in which window: one that vanishes from a live window ended.
   */
  const seen = new Map<string, { terminalId: string; windowId: number; slot: string }>()
  /** `workflow/task` for a worker spawn in flight, `workflow/task~r` for a reviewer's. */
  const starting = new Set<string>()
  const pending = new Set<Promise<unknown>>()
  /** `slotKey@terminal` of re-attached sessions already told to carry on. */
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
      out.set(slotKey(owner.workflowId, owner), peer)
    }
    return out
  }

  function slotPeer(workflow: Workflow, slot: TaskSlot, peers = workerPeers()): EnginePeer | null {
    return peers.get(slotKey(workflow.id, slot)) ?? null
  }

  function currentWorker(workflow: Workflow, task: WorkflowTask, peers = workerPeers()): EnginePeer | null {
    return slotPeer(workflow, { taskId: task.id, attempt: task.attempt }, peers)
  }

  function currentReviewer(workflow: Workflow, task: WorkflowTask, peers = workerPeers()): EnginePeer | null {
    if (task.kind !== 'loop' || !task.reviewers) return null
    return slotPeer(workflow, { taskId: task.id, attempt: task.attempt, review: task.reviewers }, peers)
  }

  function seenKey(workflowId: string, slot: TaskSlot): string {
    return `${key(workflowId, slot.taskId)}${slot.review !== undefined ? '~r' : ''}`
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
    const reviewers: Record<string, string> = {}
    for (const task of workflow.tasks) {
      if (task.attempt === 0) continue
      const peer = currentWorker(workflow, task, peers)
      if (peer) workers[task.id] = peer.terminalId
      const reviewer = currentReviewer(workflow, task, peers)
      if (reviewer) reviewers[task.id] = reviewer.terminalId
    }
    const paused = workflow.status === 'running' && leadWindow(workflow) === null ? 'window-closed' : null
    return { workflow, paused, workers, reviewers }
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
    const foot = 'Answer with patch_workflow (retry, update, cancel or add tasks; extend or accept a review loop), reply to the worker with send_message, or ask the user. get_workflow shows the whole state.'
    const budget = MAX_MESSAGE_CHARS - head.length - foot.length - 2
    let batch: Array<{ judgment: WorkflowJudgment; line: string }> = []
    let size = 0
    const flush = (): boolean => {
      if (batch.length === 0) return true
      const messageId = host.sendMail(lead, [head, ...batch.map((b) => b.line), foot].join('\n'))
      if (!messageId) return false
      for (const b of batch) mailed.set(judgmentKey(workflow.id, b.judgment), messageId)
      host.leadWoken?.(workflow, batch.map((b) => b.judgment))
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

  // -- Maps -------------------------------------------------------

  /**
   * Expand every queued map whose `after` tasks are done into one child task
   * per item of its source. Runtime, not a patch: no version bump. Returns
   * true when the workflow changed.
   */
  function expandMaps(workflow: Workflow): boolean {
    let changed = false
    const byId = new Map(workflow.tasks.map((t) => [t.id, t]))
    for (const map of [...workflow.tasks]) {
      if (map.kind !== 'map' || map.state !== 'queued' || !map.over) continue
      if (!map.after.every((d) => byId.get(d)?.state === 'done')) continue
      changed = true
      const now = new Date().toISOString()
      const source = overSource(map.over) ?? ''
      const items = byId.get(source)?.result?.items
      const limit = map.maxItems ?? WORKFLOW_MAX_MAP_ITEMS
      // A done source can't be changed: a new source is the way out.
      const newSource = (what: string): string =>
        `add a task that ${what} (it may run after ${source}) and update this map's after and over to it, or cancel the map`
      const refuse = (note: string, question: string): void => {
        map.state = 'failed'
        map.finishedAt = now
        map.note = note
        raise(workflow, map.id, `can't fan out: ${question}`)
        host.log(`[Workflows] ${workflow.id}/${map.id}: ${note}`)
      }
      if (!items) {
        refuse(`${source} reported no items`, `${source} reported no items. To fan out, ${newSource('reports the items')}.`)
        continue
      }
      if (items.length > limit) {
        const bump = items.length <= WORKFLOW_MAX_MAP_ITEMS ? `update this map's maxItems to ${items.length}, or ` : ''
        refuse(
          `${source} produced ${items.length} items; this map takes at most ${limit}`,
          `${source} produced ${items.length} items; this map takes at most ${limit}. To go on, ${bump}${newSource('narrows or splits the list')}.`,
        )
        continue
      }
      const fill = (text: string, item: string, index: number): string =>
        resolveTemplates(text, workflow)
          .replace(/\{\{\s*index\s*\}\}/g, () => String(index))
          .replace(/\{\{\s*item\s*\}\}/g, () => item)
      const filled = items.map((item, i) => ({
        brief: fill(map.brief, item, i + 1),
        ...(map.acceptance ? { acceptance: fill(map.acceptance, item, i + 1) } : {}),
      }))
      const tooLong = filled.findIndex((f) => f.brief.length > WORKFLOW_MAX_BRIEF || (f.acceptance?.length ?? 0) > WORKFLOW_MAX_GOAL)
      if (tooLong >= 0) {
        const { brief, acceptance } = filled[tooLong]
        const what =
          brief.length > WORKFLOW_MAX_BRIEF
            ? `a brief of ${brief.length} characters (at most ${WORKFLOW_MAX_BRIEF})`
            : `an acceptance of ${acceptance?.length} characters (at most ${WORKFLOW_MAX_GOAL})`
        const named = `item ${tooLong + 1} ("${childTitle(items[tooLong], tooLong + 1)}")`
        refuse(
          `${named} makes ${what}`,
          `${named} of ${source} makes ${what}. Update this map's brief or acceptance to be shorter, or ${newSource('reports shorter items')}.`,
        )
        continue
      }
      map.startedAt = now
      if (items.length === 0) {
        map.state = 'done'
        map.finishedAt = now
        map.result = { status: 'done', summary: 'No items: nothing to fan out.', items: [], steered: false, at: now }
        continue
      }
      const taken = new Set(workflow.tasks.flatMap((t) => (t.worktree && t.kind !== 'map' ? [t.worktree.branch] : [])))
      items.forEach((item, i) => {
        const index = i + 1
        const branch = map.worktree ? childBranch(map.worktree.branch, item, index, taken) : undefined
        if (branch) taken.add(branch)
        const child: WorkflowTask = {
          id: `${map.id}.${index}`,
          title: childTitle(item, index),
          kind: 'agent',
          after: [],
          ...filled[i],
          ...(map.provider ? { provider: map.provider } : {}),
          ...(map.model ? { model: map.model } : {}),
          ...(map.effort ? { effort: map.effort } : {}),
          ...(branch ? { worktree: { branch, ...(map.worktree?.base ? { base: map.worktree.base } : {}) } } : {}),
          onFailure: map.onFailure,
          state: 'queued',
          attempt: 0,
          steered: false,
          parent: map.id,
          index,
          item,
        }
        workflow.tasks.push(child)
      })
      map.state = 'running'
      delete map.note
      host.log(`[Workflows] ${workflow.id}/${map.id} fans out over ${items.length} items of ${source}`)
    }
    return changed
  }

  /** An expanded map is done once its children are; their results roll up into its own. */
  function rollUpMaps(workflow: Workflow): void {
    for (const map of workflow.tasks) {
      if (map.kind !== 'map' || map.state !== 'running') continue
      const children = childrenOf(workflow, map.id)
      if (children.length === 0 || !children.every((c) => c.state === 'done' || c.state === 'cancelled')) continue
      const now = new Date().toISOString()
      map.finishedAt = now
      const done = children.filter((c) => c.state === 'done')
      if (done.length === 0) {
        map.state = 'cancelled'
        continue
      }
      map.state = 'done'
      const lines = children.map((c) => `- ${c.title}: ${c.state === 'done' ? (c.result?.summary.split('\n')[0] ?? '') : 'cancelled'}`)
      const changed = [...new Set(done.flatMap((c) => c.result?.changedFiles ?? []))].slice(0, 200)
      map.result = {
        status: 'done',
        summary: [`${done.length} of ${children.length} items done`, ...lines].join('\n').slice(0, WORKFLOW_MAX_SUMMARY),
        items: done.map((c) => c.item ?? ''),
        ...(changed.length > 0 ? { changedFiles: changed } : {}),
        steered: done.some((c) => c.result?.steered === true),
        at: now,
      }
      workflow.judgments = workflow.judgments.filter((j) => j.taskId !== map.id)
      host.log(`[Workflows] ${workflow.id}/${map.id} done: ${done.length} of ${children.length} items`)
    }
  }

  // -- Scheduling -------------------------------------------------

  /** Settle the workflow's own status from its tasks. Returns true when it changed. */
  function settle(workflow: Workflow): boolean {
    if (workflow.status !== 'running' && workflow.status !== 'failed') return false
    rollUpMaps(workflow)
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
    // An expanded map holds no session: its children carry the activity.
    const active = workflow.tasks.some((t) => activeRole(workflow.id, t) !== null || (t.kind === 'loop' && t.state === 'running'))
    const startable = workflow.tasks.some((t) => t.state === 'queued' && t.after.every((d) => byId.get(d)?.state === 'done'))
    if (!active && !startable) {
      const blocked = workflow.tasks.filter((t) => t.state === 'queued')
      const why = (id: string): string => {
        const dep = byId.get(id)
        const failed = dep?.kind === 'map' && dep.state === 'running' ? childrenOf(workflow, id).filter((c) => c.state === 'failed') : []
        return failed.length > 0 ? `${id} (its ${failed.map((c) => c.id).join(', ')} failed)` : `${id} (${dep?.state ?? 'missing'})`
      }
      for (const task of blocked) {
        const stuckOn = task.after.filter((d) => byId.get(d)?.state !== 'done')
        if (!workflow.judgments.some((j) => j.taskId === task.id)) {
          raise(workflow, task.id, `can't start: it runs after ${stuckOn.map(why).join(', ')}.`)
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

  /**
   * Which session of a task holds a slot of the gate, if any. A loop counts
   * once: its worker while it works, its reviewer while it reviews, nothing
   * while the round waits for a reviewer to start.
   */
  function activeRole(workflowId: string, task: WorkflowTask): SessionRole | null {
    if (task.kind === 'map') return null
    const k = key(workflowId, task.id)
    if (starting.has(`${k}~r`)) return 'reviewer'
    if (starting.has(k)) return 'worker'
    if (task.state !== 'running' && task.state !== 'waiting') return null
    if (task.kind !== 'loop') return 'worker'
    const review = currentRound(task)?.review
    if (review === 'queued') return null
    return review === 'running' || review === 'waiting' ? 'reviewer' : 'worker'
  }

  const locality = new Map<string, boolean>()

  async function isLocal(workflowId: string, task: WorkflowTask, role: SessionRole = 'worker'): Promise<boolean> {
    const agent: { provider?: string; model?: string } = role === 'reviewer' ? (task.reviewer ?? {}) : task
    const k = `${key(workflowId, task.id)}@${role}:${agent.provider ?? ''}:${agent.model ?? ''}`
    let local = locality.get(k)
    if (local === undefined) {
      local = await host.isLocalModel(agent.provider, agent.model)
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
    for (const workflow of workflows) {
      if (workflow.status !== 'running' || leadWindow(workflow) === null) continue
      if (!expandMaps(workflow)) continue
      settle(workflow)
      deliverJudgments(workflow)
      save(workflow)
    }
    const busy = { local: 0, cloud: 0 }
    for (const workflow of workflows) {
      for (const task of workflow.tasks) {
        const role = activeRole(workflow.id, task)
        if (role) busy[(await isLocal(workflow.id, task, role)) ? 'local' : 'cloud']++
      }
    }
    const take = async (workflowId: string, task: WorkflowTask, role: SessionRole): Promise<boolean> => {
      const backend = (await isLocal(workflowId, task, role)) ? 'local' : 'cloud'
      if (busy[backend] >= (backend === 'local' ? LOCAL_LIMIT : CLOUD_LIMIT)) return false
      busy[backend]++
      return true
    }
    for (const workflow of workflows) {
      if (workflow.status !== 'running') continue
      const windowId = leadWindow(workflow)
      if (windowId === null) continue
      const byId = new Map(workflow.tasks.map((t) => [t.id, t]))
      for (const task of workflow.tasks) {
        const k = key(workflow.id, task.id)
        if (task.kind === 'loop' && task.state === 'running' && currentRound(task)?.review === 'queued') {
          const rk = `${k}~r`
          if (starting.has(rk) || (retryAfter.get(rk) ?? 0) > Date.now() || !(await take(workflow.id, task, 'reviewer'))) continue
          starting.add(rk)
          void track(startReviewer(workflow.id, task.id, windowId).finally(() => {
            starting.delete(rk)
            schedule()
          }))
          continue
        }
        if (task.kind === 'map' || task.state !== 'queued' || starting.has(k)) continue
        if ((retryAfter.get(k) ?? 0) > Date.now()) continue
        if (!task.after.every((d) => byId.get(d)?.state === 'done')) continue
        if (!(await take(workflow.id, task, 'worker'))) continue
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
      const task = byId.get(id)
      const result = task?.result
      if (!result) return '(no result)'
      if (field === 'summary') return result.summary
      // A map's branch is a pattern; its children each have their own.
      if (field === 'branch') return result.branch ?? (task.kind === 'map' ? undefined : task.worktree?.branch) ?? '(no branch)'
      const list = field === 'items' ? result.items : result.changedFiles
      return list && list.length > 0 ? list.join(', ') : '(none)'
    })
  }

  function integrateLines(workflow: Workflow, task: WorkflowTask): string[] {
    const byId = new Map(workflow.tasks.map((t) => [t.id, t]))
    const line = (id: string, title: string, dep: WorkflowTask | undefined): string => {
      const branch = dep?.result?.branch ?? dep?.worktree?.branch ?? '(no branch: it worked in the lead worktree)'
      return `- ${id} (${title}): branch ${branch}${dep?.result?.summary ? ` — ${dep.result.summary}` : ''}`
    }
    return task.after.flatMap((id) => {
      const dep = byId.get(id)
      if (dep?.kind !== 'map') return [line(id, dep?.title ?? id, dep)]
      const done = childrenOf(workflow, id).filter((c) => c.state === 'done')
      return done.length > 0 ? done.map((c) => line(c.id, c.title, c)) : [`- ${id} (${dep.title}): no items were done`]
    })
  }

  function briefFor(workflow: Workflow, task: WorkflowTask, attempt: number, worktreePath: string): string {
    // A child's brief was resolved at expansion; its item may contain `{{` of its own.
    const parts = [isChild(task) ? task.brief : resolveTemplates(task.brief, workflow)]
    if (task.kind === 'integrate') {
      const shape = {
        single: 'one branch and one PR that contains all of them',
        stack: 'a stack of dependent PRs, in the order listed (`gh stack`)',
        separate: 'one PR per branch, each made to merge cleanly beside the others',
      }[task.shape ?? 'single']
      parts.push(
        [
          'Combine the work of these tasks:',
          ...integrateLines(workflow, task),
          `Shape: ${shape}. Resolve conflicts yourself; report a conflict you can't decide with status "needs_lead".`,
        ].join('\n'),
      )
    }
    const previous = attempt > 1 ? (task.note ?? task.history?.find((h) => h.attempt === attempt - 1)?.note) : undefined
    const consumers = workflow.tasks.filter((t) => t.kind === 'map' && t.over && overSource(t.over) === task.id)
    const parent = task.parent !== undefined ? workflow.tasks.find((t) => t.id === task.parent) : undefined
    const branch = task.worktree?.branch
    const finish =
      task.kind === 'loop'
        ? [
            `This task is a review loop (at most ${task.maxRounds ?? WORKFLOW_LOOP_ROUNDS_DEFAULT} rounds). When your change is ready, commit it on branch ${branch} and call report_result with status "done", a short summary, branch and changedFiles. A fresh reviewer then reviews your branch; its findings arrive in your inbox as mail. Fix them, commit, and call report_result again.`,
            'Report "failed" if you can\'t complete it, or "needs_lead" with your question if a decision is needed. Ending your turn without report_result tells SimpleEdit you are waiting for the user.',
          ]
        : [
            'When you are finished, call the report_result tool once: status "done" with a short summary (plus branch and changedFiles), "failed" if you can\'t complete it, or "needs_lead" with your question if a decision is needed. Ending your turn without report_result tells SimpleEdit you are waiting for the user.',
          ]
    parts.push(
      [
        '---',
        `You are a worker in the SimpleEdit workflow "${workflow.title}" (workflow ${workflow.id}, task ${task.id}${attempt > 1 ? `, attempt ${attempt}` : ''}).`,
        ...(parent ? [`You handle item ${task.index} of ${childrenOf(workflow, parent.id).length} of map ${parent.id} ("${parent.title}"): ${task.item}`] : []),
        `Work in ${worktreePath}${branch ? ` on branch ${branch}` : ''}.`,
        ...(task.acceptance ? [`Done means: ${task.acceptance}`] : []),
        ...(previous ? [`An earlier attempt failed: ${previous}`] : []),
        ...(consumers.length > 0
          ? [
              `Later tasks fan out over your items: in report_result, give items as a list of short strings, one per unit of work, at most ${Math.min(...consumers.map((m) => m.maxItems ?? Number.POSITIVE_INFINITY))}.`,
            ]
          : []),
        ...finish,
      ].join('\n'),
    )
    return parts.join('\n\n')
  }

  function reviewerBrief(workflow: Workflow, task: WorkflowTask, round: WorkflowLoopRound, base: string): string {
    const path = task.worktreePath ?? ''
    const branch = round.work?.branch ?? task.worktree?.branch ?? 'HEAD'
    const files = round.work?.changedFiles ?? []
    const earlier = (task.rounds ?? []).filter((r) => r.round < round.round && r.findings && r.findings.length > 0).at(-1)
    return [
      resolveTemplates(task.reviewer?.brief ?? '', workflow),
      [
        '---',
        `You review round ${round.round} of the review loop ${task.id} ("${task.title}") in the SimpleEdit workflow "${workflow.title}" (workflow ${workflow.id}).`,
        `Review the changes on branch ${branch} in ${path}: git -C ${path} diff ${base}...${branch}`,
        `The worker says: ${round.work?.summary ?? '(nothing)'}${files.length > 0 ? `\nFiles: ${files.join(', ')}` : ''}`,
        'Do not edit files: report what should change.',
        ...(earlier
          ? [`Earlier rounds reported:\n${earlier.findings!.map((f, i) => `${i + 1}. ${f}`).join('\n')}\nCheck they are fixed, and look beyond them.`]
          : []),
        `When done, call report_result once: status "done" with verdict "clean", or verdict "findings" and findings: at most ${WORKFLOW_MAX_FINDINGS} items, each one or two lines with file:line. Status "failed" only if you can't review; "needs_lead" with your question if a decision is needed. Ending your turn without report_result tells SimpleEdit you are waiting for the user.`,
      ].join('\n'),
    ].join('\n\n')
  }

  /** The findings mail to a loop's worker, packed under the bus's size cap. */
  function findingsMail(workflow: Workflow, task: WorkflowTask, round: WorkflowLoopRound): string {
    const head = `[SimpleEdit workflow "${workflow.title}" · task ${task.id} · review round ${round.round} of ${task.maxRounds ?? WORKFLOW_LOOP_ROUNDS_DEFAULT}]\nThe reviewer found:`
    const foot = 'Fix them, commit, then call report_result again (status "done").'
    const findings = round.findings ?? []
    const budget = MAX_MESSAGE_CHARS - head.length - foot.length - 120
    const lines: string[] = []
    let size = 0
    for (const [i, finding] of findings.entries()) {
      const line = `${i + 1}. ${finding.length > MAILED_FINDING ? `${finding.slice(0, MAILED_FINDING)}…` : finding}`
      if (size + line.length + 1 > budget) {
        lines.push(`(${findings.length - i} more not shown; fix these first, the next review will report the rest)`)
        break
      }
      lines.push(line)
      size += line.length + 1
    }
    return [head, ...lines, foot].join('\n')
  }

  /** Mail a loop's worker its round's findings and open the next round; a worker that can't take them failed. */
  function sendFindings(workflow: Workflow, task: WorkflowTask, round: WorkflowLoopRound): boolean {
    const worker = currentWorker(workflow, task)
    const sent = worker ? host.sendMail(worker.terminalId, findingsMail(workflow, task, round)) : null
    if (!sent) {
      fail(workflow, task, "The reviewer reported findings, but the worker's session is gone: they couldn't be sent.")
      return false
    }
    task.rounds = [...(task.rounds ?? []), { round: round.round + 1, review: 'pending', startedAt: new Date().toISOString() }]
    task.state = 'running'
    task.note = `Fixing round ${round.round} findings`
    host.log(`[Workflows] ${workflow.id}/${task.id}: round ${round.round} findings sent to the worker`)
    return true
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
        // It counts as an attempt, so onFailure "retry" gets one more and then escalates.
        archiveAttempt(t)
        t.attempt += 1
        t.startedAt = new Date().toISOString()
        fail(fresh, t, `Couldn't prepare worktree ${task.worktree?.branch}: ${error instanceof Error ? error.message : String(error)}`)
        if (t.state === 'queued') {
          retryAfter.set(key(workflowId, taskId), Date.now() + SPAWN_RETRY_MS)
          setTimeout(schedule, SPAWN_RETRY_MS).unref?.()
        }
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
    if (task.kind === 'loop') {
      task.rounds = [{ round: 1, review: 'pending', startedAt: task.startedAt }]
      task.reviewers = 0
    }
    save(workflow)
    host.log(`[Workflows] Starting ${workflowId}/${taskId} attempt ${attempt} in ${worktreePath}`)
    sweepStrays()

    const owner: WorkflowOwner = { kind: 'workflow', workflowId, taskId, attempt }
    const slot = slotKey(workflowId, owner)
    spawnedThisRun.add(slot)
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
      else if (spawnedThisRun.has(slot)) armGrace(workflowId, owner, SPAWN_GRACE_MS)
    } catch (error) {
      const fresh = getWorkflow(workflowId)
      const t = fresh?.tasks.find((x) => x.id === taskId)
      if (!fresh || !t || t.attempt !== attempt || t.state !== 'running') return
      // Nothing started: the attempt doesn't count.
      t.state = 'queued'
      t.attempt = attempt - 1
      delete t.rounds
      delete t.reviewers
      t.note = `Couldn't start a worker: ${error instanceof Error ? error.message : String(error)}`
      save(fresh)
      retryAfter.set(key(workflowId, taskId), Date.now() + SPAWN_RETRY_MS)
      setTimeout(schedule, SPAWN_RETRY_MS).unref?.()
    }
  }

  /** Start a fresh reviewer for a loop's queued round, in the worker's worktree. */
  async function startReviewer(workflowId: string, taskId: string, windowId: number): Promise<void> {
    let workflow = getWorkflow(workflowId)
    let task = workflow?.tasks.find((t) => t.id === taskId)
    if (!workflow || !task || workflow.status !== 'running' || task.state !== 'running' || currentRound(task)?.review !== 'queued') return
    const base = task.worktree?.base ?? (await host.baseBranch(workflow.project).catch(() => null)) ?? 'HEAD'

    workflow = getWorkflow(workflowId)
    task = workflow?.tasks.find((t) => t.id === taskId)
    const round = task ? currentRound(task) : undefined
    if (!workflow || !task || !round || workflow.status !== 'running' || task.state !== 'running' || round.review !== 'queued') return
    const previous = { reviewers: task.reviewers ?? 0, reviewer: round.reviewer }
    const review = previous.reviewers + 1
    task.reviewers = review
    round.reviewer = review
    round.review = 'running'
    task.note = `In review (round ${round.round})`
    const brief = reviewerBrief(workflow, task, round, base)
    save(workflow)
    host.log(`[Workflows] Starting reviewer ${review} of ${workflowId}/${taskId} for round ${round.round}`)
    // Reviewer n supersedes n-1, which is closed here.
    sweepStrays()

    const owner: WorkflowOwner = { kind: 'workflow', workflowId, taskId, attempt: task.attempt, review }
    const slot = slotKey(workflowId, owner)
    const rk = `${key(workflowId, taskId)}~r`
    spawnedThisRun.add(slot)
    const spec = task.reviewer
    try {
      const terminalId = await host.spawnWorker(windowId, {
        leadTerminalId: host.leadTerminal(workflow.leadKey),
        brief,
        label: `${task.title} · review ${round.round}`,
        ...(spec?.provider ? { provider: spec.provider } : {}),
        ...(spec?.model ? { model: spec.model } : {}),
        ...(spec?.effort ? { reasoningEffort: spec.effort } : {}),
        worktreePath: task.worktreePath ?? '',
        owner,
      })
      if (terminalId) retryAfter.delete(rk)
      else if (spawnedThisRun.has(slot)) armGrace(workflowId, owner, SPAWN_GRACE_MS)
    } catch (error) {
      const fresh = getWorkflow(workflowId)
      const t = fresh?.tasks.find((x) => x.id === taskId)
      const r = t ? currentRound(t) : undefined
      if (!fresh || !t || !r || t.attempt !== owner.attempt || t.reviewers !== review || r.review !== 'running') return
      // Nothing started: the reviewer doesn't count.
      t.reviewers = previous.reviewers
      if (previous.reviewer === undefined) delete r.reviewer
      else r.reviewer = previous.reviewer
      r.review = 'queued'
      t.note = `Couldn't start a reviewer: ${error instanceof Error ? error.message : String(error)}`
      save(fresh)
      retryAfter.set(rk, Date.now() + SPAWN_RETRY_MS)
      setTimeout(schedule, SPAWN_RETRY_MS).unref?.()
    }
  }

  function armGrace(workflowId: string, slot: TaskSlot, ms: number): void {
    const k = slotKey(workflowId, slot)
    clearTimeout(graceTimers.get(k))
    const timer = setTimeout(() => {
      graceTimers.delete(k)
      abandonIfUnbound(workflowId, slot)
    }, ms)
    timer.unref?.()
    graceTimers.set(k, timer)
  }

  function cancelGrace(k: string): void {
    clearTimeout(graceTimers.get(k))
    graceTimers.delete(k)
  }

  /** A spawn whose handle never came back and whose session never appeared failed. */
  function abandonIfUnbound(workflowId: string, slot: TaskSlot): void {
    const workflow = getWorkflow(workflowId)
    const task = workflow?.tasks.find((t) => t.id === slot.taskId)
    if (!workflow || !task || (task.state !== 'running' && task.state !== 'waiting')) return
    const k = slotKey(workflowId, slot)
    if (!currentSlots(task).some((s) => slotKey(workflowId, s) === k)) return
    if (slotPeer(workflow, slot)) return
    abandoned.add(k)
    if (slot.review !== undefined) {
      host.log(`[Workflows] ${workflowId}/${slot.taskId} reviewer ${slot.review}: no reviewer appeared`)
      reviewerFailed(workflow, task, 'The reviewer session never started or was lost.')
    } else {
      host.log(`[Workflows] ${workflowId}/${slot.taskId} attempt ${slot.attempt}: no worker appeared`)
      fail(workflow, task, 'The worker session never started or was lost.')
    }
    settle(workflow)
    deliverJudgments(workflow)
    save(workflow)
    schedule()
  }

  /** A task was just cancelled while it held sessions: those at work leave as sidebar sessions, a finished reviewer closes. */
  function releaseCancelled(workflow: Workflow, task: WorkflowTask, peers: Map<string, EnginePeer>): void {
    for (const peer of [currentWorker(workflow, task, peers), currentReviewer(workflow, task, peers)]) {
      if (!peer || peer.owner?.kind !== 'workflow') continue
      if (detachedSlot(task, peer.owner)) host.detachWorker(peer.windowId, peer.terminalId)
      else host.disposeWorker(peer.windowId, peer.terminalId)
    }
  }

  /**
   * Sessions the engine has let go of but which are still owned: one that
   * appeared only after its task was cancelled or its spawn abandoned, one a
   * retry or a later reviewer replaced, a reviewer whose worker was lost
   * mid-review, or one whose workflow was dismissed.
   * Detach or close them on sight.
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
      const superseded =
        task !== undefined && (owner.attempt < task.attempt || (owner.review !== undefined && owner.attempt === task.attempt && owner.review < (task.reviewers ?? 0)))
      const lost = task ? currentRound(task) : undefined
      const lostReview = task !== undefined && lost?.workerLost === true && lost.reviewer === owner.review && ownerIsCurrent(task, owner)
      if (!workflow || abandoned.has(slotKey(owner.workflowId, owner)) || superseded || lostReview) {
        host.disposeWorker(peer.windowId, peer.terminalId)
      } else if (task && detachedSlot(task, owner)) {
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

  interface Located {
    workflow: Workflow
    task: WorkflowTask
    peer: EnginePeer
    owner: WorkflowOwner
    role: SessionRole
  }

  function locate(terminalId: string): Located | null {
    const peer = host.peers().find((p) => p.terminalId === terminalId)
    const owner = peer?.owner
    if (!peer || owner?.kind !== 'workflow' || !owner.workflowId || !owner.taskId) return null
    const workflow = getWorkflow(owner.workflowId)
    const task = workflow?.tasks.find((t) => t.id === owner.taskId)
    if (!workflow || !task || !ownerIsCurrent(task, owner)) return null
    return { workflow, task, peer, owner, role: owner.review !== undefined ? 'reviewer' : 'worker' }
  }

  /** The round a reviewer serves, while it is still serving it. */
  function servedRound(found: Located): WorkflowLoopRound | null {
    const round = currentRound(found.task)
    return round && round.reviewer === found.owner.review && (round.review === 'running' || round.review === 'waiting') ? round : null
  }

  function fail(workflow: Workflow, task: WorkflowTask, summary: string): void {
    task.finishedAt = new Date().toISOString()
    const round = task.kind === 'loop' ? currentRound(task) : undefined
    if (round && (round.review === 'queued' || round.review === 'running' || round.review === 'waiting')) {
      // The worker went while its change was in review: that review can't go on, so its reviewer closes.
      const reviewer = round.review !== 'queued' && round.reviewer === task.reviewers ? currentReviewer(workflow, task) : null
      if (reviewer) host.disposeWorker(reviewer.windowId, reviewer.terminalId)
      round.review = 'failed'
      round.workerLost = true
      round.note = `The worker was lost during the review: ${summary}`
      round.finishedAt = task.finishedAt
    }
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

  /**
   * A loop's reviewer failed. Under `onFailure: "retry"` the round gets one
   * fresh reviewer; then the loop fails, keeping its worker for a retry.
   */
  function reviewerFailed(workflow: Workflow, task: WorkflowTask, why: string): 'reviewer-retrying' | 'failed' {
    const round = currentRound(task)
    if (!round) return 'failed'
    const now = new Date().toISOString()
    if (task.onFailure === 'retry' && round.note === undefined) {
      round.review = 'queued'
      round.note = `A reviewer failed: ${why}`
      task.state = 'running'
      task.note = `Retrying the reviewer of round ${round.round}`
      host.log(`[Workflows] Retrying the reviewer of ${workflow.id}/${task.id} after: ${why}`)
      return 'reviewer-retrying'
    }
    round.review = 'failed'
    round.note = why
    round.finishedAt = now
    task.state = 'failed'
    task.note = `The reviewer failed: ${why}`
    task.finishedAt = now
    raise(
      workflow,
      task.id,
      `the reviewer of round ${round.round} failed: ${why} Retry the loop for a fresh reviewer (its worker and change are kept), or cancel it.`,
    )
    return 'failed'
  }

  function failOutcome(task: WorkflowTask): 'retrying' | 'failed' {
    return task.state === 'queued' ? 'retrying' : 'failed'
  }

  function stringList(v: unknown, field: string): string[] | undefined {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new WorkflowValidationError([`${field}: expected a list of strings`])
    return v as string[]
  }

  /** changedFiles is a hint for the lead: a long list is cut, not refused. */
  function fileList(v: unknown): string[] | undefined {
    return stringList(v, 'changedFiles')?.slice(0, MAX_LIST).map((s) => s.slice(0, MAX_ENTRY))
  }

  /** Items and findings are work for others: refused whole rather than cut. */
  function entries(v: unknown, field: string, max: number, distinct = false): string[] | undefined {
    const list = stringList(v, field)
    if (!list) return undefined
    const problems: string[] = []
    if (list.length > max) problems.push(`${field}: at most ${max} entries; you gave ${list.length}`)
    const first = new Map<string, number>()
    list.forEach((s, i) => {
      if (!s.trim()) problems.push(`${field}[${i}]: blank`)
      else if (s.length > MAX_ENTRY) problems.push(`${field}[${i}]: at most ${MAX_ENTRY} characters; it has ${s.length}`)
      else if (distinct && first.has(s)) problems.push(`${field}[${i}]: the same as ${field}[${first.get(s)}]`)
      if (!first.has(s)) first.set(s, i)
    })
    if (problems.length > 0) throw new WorkflowValidationError(problems)
    return list
  }

  function reportAsReviewer(found: Located, terminalId: string, status: WorkflowTaskResult['status'], summary: string, raw: Record<string, unknown>): ReportOutcome {
    const { workflow, task } = found
    const round = servedRound(found)
    if (!round) throw new WorkflowValidationError([`the review round you served in task ${task.id} is over; you can stop here`])
    const now = new Date().toISOString()
    if (status === 'failed') {
      round.reviewerSummary = summary
      return reviewerFailed(workflow, task, summary)
    }
    if (status === 'needs_lead') {
      round.review = 'waiting'
      round.reviewerSummary = summary
      task.state = 'waiting'
      task.note = `The reviewer asks the lead: ${summary}`
      raise(workflow, task.id, `the reviewer of round ${round.round} asks (reviewer session ${terminalId}): ${summary}${round.reviewerSteered ? ' (the user stepped into this reviewer)' : ''}`)
      return 'asked-lead'
    }
    const verdict = raw['verdict']
    if (verdict !== 'clean' && verdict !== 'findings') throw new WorkflowValidationError(['verdict: a reviewer reports "clean" or "findings" with status "done"'])
    const findings = entries(raw['findings'], 'findings', WORKFLOW_MAX_FINDINGS)
    if (verdict === 'findings' && (!findings || findings.length === 0)) {
      throw new WorkflowValidationError(['findings: with verdict "findings", list what should change, one or two lines each with file:line'])
    }
    round.verdict = verdict
    round.reviewerSummary = summary
    if (verdict === 'findings') round.findings = findings
    round.review = 'done'
    round.finishedAt = now
    workflow.judgments = workflow.judgments.filter((j) => j.taskId !== task.id)
    const work = round.work
    const steered = task.steered || (task.rounds ?? []).some((r) => r.reviewerSteered === true)
    if (verdict === 'clean') {
      task.state = 'done'
      task.finishedAt = now
      delete task.note
      task.result = {
        status: 'done',
        summary: `Clean after ${round.round} round${round.round === 1 ? '' : 's'}: ${work?.summary ?? summary}`.slice(0, WORKFLOW_MAX_SUMMARY),
        ...(work?.branch ? { branch: work.branch } : {}),
        ...(work?.changedFiles ? { changedFiles: work.changedFiles } : {}),
        ...(loopItems(task) ? { items: loopItems(task) } : {}),
        verdict: 'clean',
        steered,
        at: now,
        rounds: round.round,
      }
      return 'clean'
    }
    const maxRounds = task.maxRounds ?? WORKFLOW_LOOP_ROUNDS_DEFAULT
    if (round.round < maxRounds) return sendFindings(workflow, task, round) ? 'findings-sent' : failOutcome(task)
    task.state = 'waiting'
    task.note = `Didn't converge in ${round.round} round${round.round === 1 ? '' : 's'}`
    const listed = round.findings!.slice(0, JUDGMENT_FINDINGS).map((f, i) => `${i + 1}) ${f}`).join(' ')
    const more = round.findings!.length > JUDGMENT_FINDINGS ? ` (first ${JUDGMENT_FINDINGS} of ${round.findings!.length}; get_workflow has the rest)` : ''
    const worker = currentWorker(workflow, task)
    raise(
      workflow,
      task.id,
      `review loop did not converge after ${round.round} round${round.round === 1 ? '' : 's'}. Open findings: ${listed}${more}. Answer with patch_workflow extend (more rounds), accept (take it as is), or cancel; or message the worker${worker ? ` (session ${worker.terminalId})` : ''}.`,
    )
    return 'not-converged'
  }

  function reportAsLoopWorker(found: Located, terminalId: string, result: WorkflowTaskResult): ReportOutcome {
    const { workflow, task } = found
    const round = currentRound(task)
    const notConverged = task.state === 'waiting' && loopPhase(task) === 'not-converged'
    if (round && round.review !== 'pending' && !notConverged) {
      throw new WorkflowValidationError([`your change is in review (round ${round.round}); its findings, if any, arrive in your inbox`])
    }
    if (result.status === 'failed') {
      fail(workflow, task, result.summary)
      return failOutcome(task)
    }
    if (result.status === 'needs_lead') {
      task.state = 'waiting'
      task.note = `Asks the lead: ${result.summary}`
      raise(workflow, task.id, `asks (worker session ${terminalId}): ${result.summary}${task.steered ? ' (the user stepped into this worker)' : ''}`)
      return 'asked-lead'
    }
    const work: NonNullable<WorkflowLoopRound['work']> = {
      summary: result.summary,
      ...(result.branch ? { branch: result.branch } : {}),
      ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
      ...(result.items ? { items: result.items } : {}),
      steered: task.steered,
      at: result.at,
    }
    let next: WorkflowLoopRound
    if (round && round.review === 'pending') {
      round.work = work
      round.review = 'queued'
      next = round
    } else {
      // A report after non-convergence (the lead or the user messaged the worker) opens another round.
      next = { round: (round?.round ?? 0) + 1, work, review: 'queued', startedAt: result.at }
      task.rounds = [...(task.rounds ?? []), next]
    }
    task.state = 'running'
    task.note = `In review (round ${next.round})`
    workflow.judgments = workflow.judgments.filter((j) => j.taskId !== task.id)
    return 'in-review'
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
        if (task.detached && old && !old.detached) releaseCancelled(workflow, task, peers)
      }
      const resumed = new Set<string>()
      for (const op of ops) {
        if (op.op === 'add' || resumed.has(op.id)) continue
        const task = workflow.tasks.find((t) => t.id === op.id)
        if (task?.kind !== 'loop') continue
        resumed.add(task.id)
        if (op.op === 'extend' && task.state === 'waiting' && loopPhase(task) === 'not-converged') {
          const round = currentRound(task)
          if (round) sendFindings(workflow, task, round)
        } else if (op.op === 'retry' && task.state === 'running' && currentRound(task)?.review === 'queued') {
          const slot: TaskSlot = { taskId: task.id, attempt: task.attempt }
          const worker = currentWorker(workflow, task, peers)
          if (worker) {
            // It may have been resumed after a restart: losing it from now on fails the loop.
            seen.set(seenKey(workflow.id, slot), { terminalId: worker.terminalId, windowId: worker.windowId, slot: slotKey(workflow.id, slot) })
          } else {
            // The kept worker is gone too: start the loop over with a fresh one.
            task.state = 'queued'
            archiveAttempt(task)
          }
        }
      }
      settle(workflow)
      deliverJudgments(workflow)
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
        const held = task.kind !== 'map' && (task.state === 'running' || task.state === 'waiting' || currentSlots(task).length > 0)
        // A failed loop still holding its worker (only its reviewer failed) lets that worker go too.
        if (task.state === 'done' || task.state === 'cancelled' || (task.state === 'failed' && !held)) continue
        task.state = 'cancelled'
        task.finishedAt = now
        if (held) {
          task.detached = true
          releaseCancelled(workflow, task, peers)
        }
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
        if (task && detachedSlot(task, owner)) {
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
      const { workflow, task, role } = found
      if (task.state !== 'running' && task.state !== 'waiting') {
        throw new WorkflowValidationError([`task ${task.id} is ${task.state}; its result can't change now`])
      }
      const status = raw['status']
      if (status !== 'done' && status !== 'failed' && status !== 'needs_lead') throw new WorkflowValidationError(['status: "done", "failed" or "needs_lead"'])
      const summary = typeof raw['summary'] === 'string' ? raw['summary'].trim().slice(0, WORKFLOW_MAX_SUMMARY) : ''
      if (!summary) throw new WorkflowValidationError(['summary: say in a few lines what you did or what you need'])
      const verdict = raw['verdict']
      if (verdict !== undefined && verdict !== 'clean' && verdict !== 'findings') throw new WorkflowValidationError(['verdict: "clean" or "findings"'])
      if (role === 'worker' && task.kind === 'loop' && (verdict !== undefined || raw['findings'] !== undefined)) {
        throw new WorkflowValidationError(['you are the worker of a review loop; the reviewer gives the verdict and findings'])
      }
      if (role === 'reviewer' && raw['items'] !== undefined) {
        throw new WorkflowValidationError(["you are the reviewer of a review loop; items are the worker's to report"])
      }
      let outcome: ReportOutcome
      if (role === 'reviewer') {
        outcome = reportAsReviewer(found, terminalId, status, summary, raw)
      } else {
        const branch = typeof raw['branch'] === 'string' && raw['branch'] ? raw['branch'].slice(0, 200) : undefined
        const changedFiles = fileList(raw['changedFiles'])
        const items = entries(raw['items'], 'items', MAX_LIST, true)
        const findings = entries(raw['findings'], 'findings', MAX_LIST)
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
        if (task.kind === 'loop') {
          outcome = reportAsLoopWorker(found, terminalId, result)
        } else {
          task.result = result
          if (status === 'done') {
            task.state = 'done'
            task.finishedAt = result.at
            delete task.note
            workflow.judgments = workflow.judgments.filter((j) => j.taskId !== task.id)
            outcome = 'done'
          } else if (status === 'failed') {
            fail(workflow, task, summary)
            outcome = failOutcome(task)
          } else {
            task.state = 'waiting'
            task.note = `Asks the lead: ${summary}`
            raise(workflow, task.id, `asks (worker session ${terminalId}): ${summary}${task.steered ? ' (the user stepped into this worker)' : ''}`)
            outcome = 'asked-lead'
          }
        }
      }
      settle(workflow)
      deliverJudgments(workflow)
      save(workflow)
      host.log(`[Workflows] ${workflow.id}/${task.id} ${role} reported ${status}: ${outcome}`)
      schedule()
      return { workflowId: workflow.id, taskId: task.id, state: task.state, role, outcome }
    },

    workerOf(terminalId) {
      const found = locate(terminalId)
      return found ? { workflowId: found.workflow.id, taskId: found.task.id } : null
    },

    isLead(terminalId, workflow) {
      return host.leadTerminal(workflow.leadKey) === terminalId
    },

    leadWindowOf: leadWindow,

    onPeersChanged() {
      sweepStrays()
      const peers = workerPeers()
      for (const workflow of listLiveWorkflows()) {
        let changed = false
        for (const task of workflow.tasks) {
          if (task.state !== 'running' && task.state !== 'waiting') continue
          for (const slot of currentSlots(task)) {
            const sk = slotKey(workflow.id, slot)
            const k = seenKey(workflow.id, slot)
            const peer = peers.get(sk) ?? null
            const before = seen.get(k)
            if (peer) {
              seen.set(k, { terminalId: peer.terminalId, windowId: peer.windowId, slot: sk })
              if (spawnedThisRun.has(sk)) continue
              if (before?.terminalId !== peer.terminalId) host.log(`[Workflows] Re-attached ${sk} to ${peer.terminalId}`)
              const nudge = `${sk}@${peer.terminalId}`
              const round = currentRound(task)
              const reviewer = slot.review !== undefined
              const itsTurn = reviewer ? round?.review === 'running' : task.kind !== 'loop' || round?.review === 'pending'
              if (task.state === 'running' && itsTurn && !nudged.has(nudge)) {
                const sent = host.sendMail(
                  peer.terminalId,
                  reviewer
                    ? `SimpleEdit restarted while you reviewed round ${round?.round} of workflow task "${task.id}". Check where you left off, continue, and finish with report_result (status "done" with verdict "clean" or "findings").`
                    : `SimpleEdit restarted while you worked on workflow task "${task.id}". Check where you left off, continue, and finish with report_result.`,
                )
                if (sent) nudged.add(nudge)
              }
              continue
            }
            // A session this run saw is gone from a window that is still open: it was
            // closed or it exited. A closing window drops its hosts first (`onWindowClosed`).
            if (before && before.slot === sk && hostsWindow(before.windowId)) {
              seen.delete(k)
              if (slot.review !== undefined) reviewerFailed(workflow, task, NOTE_REVIEWER_CLOSED)
              else fail(workflow, task, NOTE_CLOSED)
              changed = true
              break
            }
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
      // After a restart a running task's sessions come back only if they were saved.
      for (const workflow of listLiveWorkflows()) {
        if (leadWindow(workflow) !== windowId) continue
        for (const task of workflow.tasks) {
          if (task.state !== 'running' && task.state !== 'waiting') continue
          for (const slot of currentSlots(task)) {
            const sk = slotKey(workflow.id, slot)
            if (spawnedThisRun.has(sk) || orphanChecks.has(sk)) continue
            orphanChecks.add(sk)
            armGrace(workflow.id, slot, RESTORE_GRACE_MS)
          }
        }
      }
      tickAll()
    },

    onWindowClosed(windowId) {
      // The window's bridge stops with it, so its workers could never report.
      // Like a restart: they end now, and the reopened window resumes and
      // nudges them, or they fail after a fresh grace. Any check already
      // running would fail them early, so those go too.
      const forget = (sk: string): void => {
        spawnedThisRun.delete(sk)
        orphanChecks.delete(sk)
        cancelGrace(sk)
      }
      for (const workflow of listLiveWorkflows()) {
        if (leadWindow(workflow) !== windowId) continue
        for (const task of workflow.tasks) {
          if (task.state === 'running' || task.state === 'waiting') for (const slot of currentSlots(task)) forget(slotKey(workflow.id, slot))
        }
      }
      hosts.delete(windowId)
      for (const peer of host.peers()) {
        const owner = peer.owner
        if (peer.windowId !== windowId || owner?.kind !== 'workflow' || released.has(peer.terminalId)) continue
        const task = getWorkflow(owner.workflowId)?.tasks.find((t) => t.id === owner.taskId)
        if (task && detachedSlot(task, owner)) continue
        forget(slotKey(owner.workflowId, owner))
        host.killWorker(peer.terminalId)
      }
      for (const [k, s] of seen) {
        if (s.windowId !== windowId) continue
        seen.delete(k)
        forget(s.slot)
      }
      for (const workflow of listLiveWorkflows()) publish(workflow)
    },

    onTurnEnded(terminalId) {
      const found = locate(terminalId)
      if (!found || found.task.state !== 'running') return
      const { task } = found
      if (found.role === 'reviewer') {
        const round = servedRound(found)
        if (round?.review !== 'running') return
        round.review = 'waiting'
        task.state = 'waiting'
        task.note = NOTE_REVIEWER_STOPPED
      } else {
        // A loop's worker is idle while its change is in review.
        if (task.kind === 'loop' && currentRound(task)?.review !== 'pending') return
        task.state = 'waiting'
        task.note = NOTE_STOPPED
      }
      save(found.workflow)
    },

    onTurnStarted(terminalId) {
      const found = locate(terminalId)
      if (!found || found.task.state !== 'waiting') return
      const { task, workflow } = found
      // A new turn is the user's or the lead's answer arriving.
      if (found.role === 'reviewer') {
        const round = servedRound(found)
        if (round?.review !== 'waiting') return
        round.review = 'running'
        task.note = `In review (round ${round.round})`
      } else {
        if (waitingSlot(task) !== 'worker') return
        delete task.note
      }
      task.state = 'running'
      workflow.judgments = workflow.judgments.filter((j) => j.taskId !== task.id)
      save(workflow)
    },

    onUserInput(terminalId) {
      const found = locate(terminalId)
      if (!found || (found.task.state !== 'running' && found.task.state !== 'waiting')) return
      if (found.role === 'reviewer') {
        const round = servedRound(found)
        if (!round || round.reviewerSteered) return
        round.reviewerSteered = true
      } else {
        if (found.task.steered) return
        found.task.steered = true
      }
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
