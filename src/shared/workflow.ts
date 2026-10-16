/**
 * Workflows: a task graph a lead session prepares and SimpleEdit executes.
 *
 * Main owns every workflow (`main/workflow-store.ts`, `main/workflow-engine.ts`);
 * windows mirror them through `workflow:changed`. A workflow is data, never
 * code: everything an agent sends is validated here before it reaches the
 * store, so a workflow can be drawn before it runs and is safe to execute.
 */

export type WorkflowStatus = 'draft' | 'running' | 'done' | 'failed' | 'cancelled'
export type WorkflowTaskState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
export type WorkflowTaskKind = 'agent' | 'integrate'
export type WorkflowProvider = 'claude' | 'codex'
export type IntegrateShape = 'single' | 'stack' | 'separate'
export type OnFailure = 'retry' | 'escalate'

export const WORKFLOW_MAX_TASKS = 40
export const WORKFLOW_MAX_OPS = 40
export const WORKFLOW_MAX_BRIEF = 16_000
export const WORKFLOW_MAX_TITLE = 120
export const WORKFLOW_MAX_GOAL = 4_000
export const WORKFLOW_MAX_SUMMARY = 4_000
/** `onFailure: "retry"` starts one fresh worker; a second failure escalates. */
export const WORKFLOW_MAX_ATTEMPTS_ON_RETRY = 2
/** Earlier attempts kept per task; a lead's retries can go past the automatic one. */
export const WORKFLOW_MAX_HISTORY = 5

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export interface WorkflowWorktreeSpec {
  /** Created next to the bare repo if it doesn't exist yet. */
  branch: string
  /** Where a new branch starts. Absent: the repo's HEAD. */
  base?: string
}

/** A task as the lead writes it. */
export interface WorkflowTaskSpec {
  id: string
  title: string
  kind: WorkflowTaskKind
  /** Ids of the tasks that must be `done` first. */
  after: string[]
  brief: string
  /** What `done` means; added to the brief's footer. */
  acceptance?: string
  provider?: WorkflowProvider
  model?: string
  effort?: string
  /** Absent: the worker runs in the lead's worktree. */
  worktree?: WorkflowWorktreeSpec
  onFailure: OnFailure
  /** `integrate` only: the PR shape to combine the `after` branches into. */
  shape?: IntegrateShape
}

export interface WorkflowTaskResult {
  status: 'done' | 'failed' | 'needs_lead'
  summary: string
  branch?: string
  changedFiles?: string[]
  items?: string[]
  verdict?: 'clean' | 'findings'
  findings?: string[]
  /** The user typed into this worker while it ran: the outcome isn't the worker's alone. */
  steered: boolean
  at: string
}

/** What an earlier attempt left behind, so a retry doesn't erase why it was needed. */
export interface WorkflowAttemptRecord {
  attempt: number
  result?: WorkflowTaskResult
  note?: string
  finishedAt?: string
}

export interface WorkflowTask extends WorkflowTaskSpec {
  state: WorkflowTaskState
  /** 1 for the first worker; a retry starts the next. 0 while never started. */
  attempt: number
  result?: WorkflowTaskResult
  /** Why the task is `waiting`/`failed`, or what the engine is waiting on, in a line. */
  note?: string
  /** The worktree the worker was started in. */
  worktreePath?: string
  /** The user typed into the current worker. */
  steered: boolean
  startedAt?: string
  finishedAt?: string
  /** The patch `version` that added this task. */
  addedBy?: number
  /** The patch `version` that cancelled it. */
  cancelledBy?: number
  /** Cancelled while running: its worker left the workflow and is a normal session now. */
  detached?: boolean
  /** Earlier attempts, oldest first, at most WORKFLOW_MAX_HISTORY. */
  history?: WorkflowAttemptRecord[]
}

/** `null` clears an optional field. */
export interface WorkflowTaskPatch {
  title?: string
  after?: string[]
  brief?: string
  acceptance?: string | null
  provider?: WorkflowProvider
  model?: string | null
  effort?: string | null
  worktree?: WorkflowWorktreeSpec | null
  onFailure?: OnFailure
  shape?: IntegrateShape
}

export type WorkflowOp =
  | { op: 'add'; task: WorkflowTaskSpec }
  /** Only a `queued` task can be changed. */
  | { op: 'update'; id: string; patch: WorkflowTaskPatch }
  /** A running task's worker is detached, not stopped. */
  | { op: 'cancel'; id: string }
  /** A `failed` task is queued again with a fresh worker, optionally with a new brief. */
  | { op: 'retry'; id: string; brief?: string }

export interface WorkflowPatch {
  /** The workflow's version this patch produced. */
  version: number
  at: string
  ops: WorkflowOp[]
}

/** A question the engine can't answer alone, for the lead. */
export interface WorkflowJudgment {
  taskId: string
  question: string
  at: string
  /** Handed to the lead's mailbox. False while the lead isn't running. */
  delivered: boolean
}

export interface Workflow {
  id: string
  /** The bare repo of the window the lead lives in. */
  project: string
  /**
   * The lead's stable identity: its provider session id, which survives a
   * restart (terminal ids don't). The lead's terminal id when it had none.
   */
  leadKey: string
  leadLabel: string
  title: string
  goal: string
  /** Bumped by every applied patch; `patch_workflow` names the one it read. */
  version: number
  status: WorkflowStatus
  tasks: WorkflowTask[]
  patches: WorkflowPatch[]
  judgments: WorkflowJudgment[]
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

/** What a window shows next to a workflow: facts only main can know. */
export interface WorkflowSnapshot {
  workflow: Workflow
  /** The lead's window is closed or its renderer hasn't listed it: nothing new starts. */
  paused: 'window-closed' | null
  /** Live terminal id of each task's current worker. */
  workers: Record<string, string>
  /** Dismissed: clients drop it. */
  dismissed?: boolean
}

export interface WorkflowList {
  project: string
  workflows: WorkflowSnapshot[]
}

export interface WorkflowSettings {
  /** The lead may call `start_workflow`; otherwise only the user's Start does. */
  leadMayStart: boolean
}

// -- Ids ----------------------------------------------------------

const WORKFLOW_ID = /^wf_[A-Za-z0-9_-]{6,64}$/
const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,120}(?<![./])$/
const MODEL = /^[A-Za-z0-9._:/-]{1,120}$/

export function isWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_ID.test(value)
}

export function isWorkflowTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID.test(value)
}

export function newWorkflowId(): string {
  return `wf_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export function isFinished(status: WorkflowStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

// -- Validation ---------------------------------------------------

/**
 * Thrown with every problem found, worded for the agent that sent the
 * input: it reads `problems` and fixes them in one go.
 */
export class WorkflowValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'))
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown, at: string, max: number, problems: string[], required = true): string | undefined {
  if (v === undefined && !required) return undefined
  if (typeof v !== 'string' || !v.trim()) {
    problems.push(`${at}: must be a non-empty string`)
    return undefined
  }
  if (v.length > max) {
    problems.push(`${at}: at most ${max} characters`)
    return undefined
  }
  return v.trim()
}

function parseWorktree(v: unknown, at: string, problems: string[]): WorkflowWorktreeSpec | undefined {
  if (!isObject(v)) {
    problems.push(`${at}: must be {branch, base?}`)
    return undefined
  }
  if (typeof v.branch !== 'string' || !BRANCH.test(v.branch)) {
    problems.push(`${at}.branch: not a valid branch name`)
    return undefined
  }
  if (v.base !== undefined && (typeof v.base !== 'string' || !BRANCH.test(v.base))) {
    problems.push(`${at}.base: not a valid branch name`)
    return undefined
  }
  return { branch: v.branch, ...(typeof v.base === 'string' ? { base: v.base } : {}) }
}

const TEMPLATE = /\{\{([^}]*)\}\}/g
const TEMPLATE_REF = /^\s*task\.([a-z0-9][a-z0-9_-]{0,39})\.result\.(summary|branch|changedFiles|items)\s*$/

/** The task ids a brief's `{{task.<id>.result.<field>}}` lookups name, or problems. */
export function templateRefs(brief: string, at: string, problems: string[]): string[] {
  const refs: string[] = []
  for (const match of brief.matchAll(TEMPLATE)) {
    const ref = TEMPLATE_REF.exec(match[1])
    if (!ref) {
      problems.push(`${at}: unknown template {{${match[1]}}}; only {{task.<id>.result.summary|branch|changedFiles|items}}`)
      continue
    }
    refs.push(ref[1])
  }
  return refs
}

function parseTaskSpec(raw: unknown, at: string, problems: string[]): WorkflowTaskSpec | null {
  if (!isObject(raw)) {
    problems.push(`${at}: must be an object`)
    return null
  }
  const before = problems.length
  if (!isWorkflowTaskId(raw.id)) problems.push(`${at}.id: lower-case letters, digits, - and _, at most 40`)
  const title = text(raw.title, `${at}.title`, WORKFLOW_MAX_TITLE, problems)
  const kind = raw.kind ?? 'agent'
  if (kind !== 'agent' && kind !== 'integrate') problems.push(`${at}.kind: "agent" or "integrate" (loop and map are not available yet)`)
  const after = raw.after ?? []
  if (!Array.isArray(after) || !after.every(isWorkflowTaskId)) problems.push(`${at}.after: a list of task ids`)
  const brief = text(raw.brief, `${at}.brief`, WORKFLOW_MAX_BRIEF, problems)
  const acceptance = text(raw.acceptance, `${at}.acceptance`, WORKFLOW_MAX_GOAL, problems, false)
  const provider = raw.provider
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex') problems.push(`${at}.provider: "claude" or "codex"`)
  if (raw.model !== undefined && (typeof raw.model !== 'string' || !MODEL.test(raw.model))) problems.push(`${at}.model: not a valid model id`)
  const effort = raw.effort
  if (effort !== undefined) {
    if (typeof effort !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
      problems.push(`${at}.effort: one of ${REASONING_EFFORTS.join(', ')}`)
    } else if ((provider ?? 'claude') === 'claude') {
      problems.push(`${at}.effort: only for provider "codex"`)
    }
  }
  const worktree = raw.worktree === undefined ? undefined : parseWorktree(raw.worktree, `${at}.worktree`, problems)
  const onFailure = raw.onFailure ?? 'escalate'
  if (onFailure !== 'retry' && onFailure !== 'escalate') problems.push(`${at}.onFailure: "retry" or "escalate"`)
  const shape = raw.shape
  if (kind === 'integrate') {
    if (shape !== 'single' && shape !== 'stack' && shape !== 'separate') problems.push(`${at}.shape: "single", "stack" or "separate"`)
    if (Array.isArray(after) && after.length === 0) problems.push(`${at}.after: an integrate task combines the tasks it runs after; name at least one`)
  } else if (shape !== undefined) {
    problems.push(`${at}.shape: only for kind "integrate"`)
  }
  if (problems.length > before) return null
  return {
    id: raw.id as string,
    title: title!,
    kind: kind as WorkflowTaskKind,
    after: [...new Set(after as string[])],
    brief: brief!,
    ...(acceptance ? { acceptance } : {}),
    ...(provider ? { provider: provider as WorkflowProvider } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(typeof effort === 'string' ? { effort } : {}),
    ...(worktree ? { worktree } : {}),
    onFailure: onFailure as OnFailure,
    ...(kind === 'integrate' ? { shape: shape as IntegrateShape } : {}),
  }
}

/**
 * Check a graph's edges: every `after` and template names a task that exists,
 * a template names an ancestor (its result exists by then), and nothing
 * cycles. Pushes problems; returns nothing.
 */
export function checkGraph(tasks: readonly Pick<WorkflowTaskSpec, 'id' | 'after' | 'brief'>[], problems: string[]): void {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const task of tasks) {
    for (const dep of task.after) {
      if (dep === task.id) problems.push(`task ${task.id}: can't run after itself`)
      else if (!byId.has(dep)) problems.push(`task ${task.id}: after names unknown task "${dep}"`)
    }
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const cycle: string[] = []
  const visit = (id: string, path: string[]): boolean => {
    const mark = state.get(id)
    if (mark === 'done') return false
    if (mark === 'visiting') {
      cycle.push(...path.slice(path.indexOf(id)), id)
      return true
    }
    state.set(id, 'visiting')
    for (const dep of byId.get(id)?.after ?? []) {
      if (byId.has(dep) && visit(dep, [...path, id])) return true
    }
    state.set(id, 'done')
    return false
  }
  for (const task of tasks) {
    if (visit(task.id, [])) {
      problems.push(`the tasks form a cycle: ${cycle.join(' → ')}`)
      break
    }
  }
  if (cycle.length > 0) return
  for (const task of tasks) {
    const refs = templateRefs(task.brief, `task ${task.id}.brief`, problems)
    for (const ref of refs) {
      if (!ancestorsOf(task.id, byId).has(ref)) {
        problems.push(`task ${task.id}.brief: {{task.${ref}…}} must name a task it runs after (directly or not)`)
      }
    }
  }
}

function ancestorsOf(id: string, byId: Map<string, Pick<WorkflowTaskSpec, 'after'>>): Set<string> {
  const seen = new Set<string>()
  const stack = [...(byId.get(id)?.after ?? [])]
  while (stack.length > 0) {
    const next = stack.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    stack.push(...(byId.get(next)?.after ?? []))
  }
  return seen
}

export interface NewWorkflowInput {
  title: string
  goal: string
  tasks: WorkflowTaskSpec[]
}

/** `create_workflow`'s input. Throws `WorkflowValidationError` listing every problem. */
export function parseNewWorkflow(raw: unknown): NewWorkflowInput {
  const problems: string[] = []
  if (!isObject(raw)) throw new WorkflowValidationError(['expected {title, goal, tasks}'])
  const title = text(raw.title, 'title', WORKFLOW_MAX_TITLE, problems)
  const goal = text(raw.goal, 'goal', WORKFLOW_MAX_GOAL, problems)
  const tasks: WorkflowTaskSpec[] = []
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    problems.push('tasks: a non-empty list')
  } else if (raw.tasks.length > WORKFLOW_MAX_TASKS) {
    problems.push(`tasks: at most ${WORKFLOW_MAX_TASKS}`)
  } else {
    raw.tasks.forEach((t, i) => {
      const spec = parseTaskSpec(t, `tasks[${i}]`, problems)
      if (spec) tasks.push(spec)
    })
    const seen = new Set<string>()
    for (const task of tasks) {
      if (seen.has(task.id)) problems.push(`tasks: id "${task.id}" is used twice`)
      seen.add(task.id)
    }
    if (problems.length === 0) checkGraph(tasks, problems)
  }
  if (problems.length > 0) throw new WorkflowValidationError(problems)
  return { title: title!, goal: goal!, tasks }
}

function parsePatchFields(raw: unknown, at: string, problems: string[]): WorkflowTaskPatch | null {
  if (!isObject(raw)) {
    problems.push(`${at}: must be an object`)
    return null
  }
  const before = problems.length
  const patch: WorkflowTaskPatch = {}
  for (const key of Object.keys(raw)) {
    if (!['title', 'after', 'brief', 'acceptance', 'provider', 'model', 'effort', 'worktree', 'onFailure', 'shape'].includes(key)) {
      problems.push(`${at}.${key}: can't be changed`)
    }
  }
  if (raw.title !== undefined) patch.title = text(raw.title, `${at}.title`, WORKFLOW_MAX_TITLE, problems)
  if (raw.brief !== undefined) patch.brief = text(raw.brief, `${at}.brief`, WORKFLOW_MAX_BRIEF, problems)
  if (raw.after !== undefined) {
    if (!Array.isArray(raw.after) || !raw.after.every(isWorkflowTaskId)) problems.push(`${at}.after: a list of task ids`)
    else patch.after = [...new Set(raw.after)]
  }
  if (raw.acceptance === null) patch.acceptance = null
  else if (raw.acceptance !== undefined) patch.acceptance = text(raw.acceptance, `${at}.acceptance`, WORKFLOW_MAX_GOAL, problems)
  if (raw.provider !== undefined) {
    if (raw.provider !== 'claude' && raw.provider !== 'codex') problems.push(`${at}.provider: "claude" or "codex"`)
    else patch.provider = raw.provider
  }
  if (raw.model === null) patch.model = null
  else if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !MODEL.test(raw.model)) problems.push(`${at}.model: not a valid model id`)
    else patch.model = raw.model
  }
  if (raw.effort === null) patch.effort = null
  else if (raw.effort !== undefined) {
    if (typeof raw.effort !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(raw.effort)) {
      problems.push(`${at}.effort: one of ${REASONING_EFFORTS.join(', ')}`)
    } else patch.effort = raw.effort
  }
  if (raw.worktree === null) patch.worktree = null
  else if (raw.worktree !== undefined) patch.worktree = parseWorktree(raw.worktree, `${at}.worktree`, problems)
  if (raw.onFailure !== undefined) {
    if (raw.onFailure !== 'retry' && raw.onFailure !== 'escalate') problems.push(`${at}.onFailure: "retry" or "escalate"`)
    else patch.onFailure = raw.onFailure
  }
  if (raw.shape !== undefined) {
    if (raw.shape !== 'single' && raw.shape !== 'stack' && raw.shape !== 'separate') problems.push(`${at}.shape: "single", "stack" or "separate"`)
    else patch.shape = raw.shape
  }
  return problems.length > before ? null : patch
}

/** `patch_workflow`'s ops, checked for shape only; the store checks them against the graph. */
export function parseWorkflowOps(raw: unknown): WorkflowOp[] {
  const problems: string[] = []
  if (!Array.isArray(raw) || raw.length === 0) throw new WorkflowValidationError(['ops: a non-empty list'])
  if (raw.length > WORKFLOW_MAX_OPS) throw new WorkflowValidationError([`ops: at most ${WORKFLOW_MAX_OPS}`])
  const ops: WorkflowOp[] = []
  raw.forEach((op, i) => {
    const at = `ops[${i}]`
    if (!isObject(op)) {
      problems.push(`${at}: must be an object`)
      return
    }
    if (op.op === 'add') {
      const task = parseTaskSpec(op.task, `${at}.task`, problems)
      if (task) ops.push({ op: 'add', task })
      return
    }
    if (!isWorkflowTaskId(op.id)) {
      problems.push(`${at}.id: a task id`)
      return
    }
    if (op.op === 'update') {
      const patch = parsePatchFields(op.patch, `${at}.patch`, problems)
      if (patch) ops.push({ op: 'update', id: op.id, patch })
    } else if (op.op === 'cancel') {
      ops.push({ op: 'cancel', id: op.id })
    } else if (op.op === 'retry') {
      const brief = op.brief === undefined ? undefined : text(op.brief, `${at}.brief`, WORKFLOW_MAX_BRIEF, problems)
      if (op.brief === undefined || brief) ops.push({ op: 'retry', id: op.id, ...(brief ? { brief } : {}) })
    } else {
      problems.push(`${at}.op: "add", "update", "cancel" or "retry"`)
    }
  })
  if (problems.length > 0) throw new WorkflowValidationError(problems)
  return ops
}

// -- Attempts -----------------------------------------------------

/** Move the current attempt's result and note into the task's history. */
export function archiveAttempt(task: WorkflowTask): void {
  if (task.attempt > 0 && (task.result || task.note)) {
    const record: WorkflowAttemptRecord = {
      attempt: task.attempt,
      ...(task.result ? { result: task.result } : {}),
      ...(task.note ? { note: task.note } : {}),
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    }
    task.history = [...(task.history ?? []).filter((h) => h.attempt !== task.attempt), record].slice(-WORKFLOW_MAX_HISTORY)
  }
  delete task.result
  delete task.note
}

/** A stored history column, dropping whatever doesn't have the record's shape. */
export function parseAttemptHistory(raw: unknown): WorkflowAttemptRecord[] {
  if (!Array.isArray(raw)) return []
  const out: WorkflowAttemptRecord[] = []
  for (const item of raw) {
    if (!isObject(item) || typeof item.attempt !== 'number' || !Number.isInteger(item.attempt)) continue
    const result = item.result
    const validResult =
      isObject(result) && (result.status === 'done' || result.status === 'failed' || result.status === 'needs_lead') && typeof result.summary === 'string'
    out.push({
      attempt: item.attempt,
      ...(validResult ? { result: result as unknown as WorkflowTaskResult } : {}),
      ...(typeof item.note === 'string' ? { note: item.note } : {}),
      ...(typeof item.finishedAt === 'string' ? { finishedAt: item.finishedAt } : {}),
    })
  }
  return out.slice(-WORKFLOW_MAX_HISTORY)
}

// -- Derived views ------------------------------------------------

/** Dependency depth per task: 0 for roots. Cancelled tasks keep their column. */
export function taskDepths(tasks: readonly Pick<WorkflowTask, 'id' | 'after'>[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const depth = new Map<string, number>()
  const depthOf = (id: string, guard: Set<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (guard.has(id)) return 0
    guard.add(id)
    const deps = (byId.get(id)?.after ?? []).filter((d) => byId.has(d))
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, guard)))
    depth.set(id, d)
    return d
  }
  for (const task of tasks) depthOf(task.id, new Set())
  return depth
}

export function workflowProgress(workflow: Pick<Workflow, 'tasks'>): { done: number; total: number } {
  const live = workflow.tasks.filter((t) => t.state !== 'cancelled')
  return { done: live.filter((t) => t.state === 'done').length, total: live.length }
}

/** `get_workflow`'s answer: what a woken lead needs, no transcripts. */
export function describeWorkflow(snapshot: WorkflowSnapshot): Record<string, unknown> {
  const { workflow } = snapshot
  return {
    workflowId: workflow.id,
    title: workflow.title,
    status: workflow.status,
    version: workflow.version,
    ...(snapshot.paused ? { paused: snapshot.paused } : {}),
    progress: workflowProgress(workflow),
    tasks: workflow.tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      state: t.state,
      after: t.after,
      ...(t.attempt > 1 ? { attempt: t.attempt } : {}),
      ...(t.note ? { note: t.note } : {}),
      ...(t.worktreePath ? { worktree: t.worktreePath } : {}),
      ...(t.detached ? { detached: true } : {}),
      ...(t.result
        ? {
            result: {
              status: t.result.status,
              summary: t.result.summary,
              ...(t.result.branch ? { branch: t.result.branch } : {}),
              ...(t.result.changedFiles ? { changedFiles: t.result.changedFiles } : {}),
              ...(t.result.items ? { items: t.result.items } : {}),
              ...(t.result.steered ? { steered: true } : {}),
            },
          }
        : {}),
      ...(t.history && t.history.length > 0
        ? {
            earlierAttempts: t.history.map((h) => ({
              attempt: h.attempt,
              ...(h.result ? { status: h.result.status, summary: h.result.summary } : {}),
              ...(h.note ? { note: h.note } : {}),
            })),
          }
        : {}),
    })),
    ...(workflow.judgments.length > 0 ? { openQuestions: workflow.judgments.map((j) => ({ task: j.taskId, question: j.question })) } : {}),
  }
}
