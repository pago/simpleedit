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
export type WorkflowTaskKind = 'agent' | 'integrate' | 'loop' | 'map'
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
/** A loop's cap once the lead extended it. */
export const WORKFLOW_MAX_LOOP_ROUNDS = 10
/** What a loop's spec may ask for; `extend` grants more. */
export const WORKFLOW_LOOP_ROUNDS_SPEC_MAX = 5
export const WORKFLOW_LOOP_ROUNDS_DEFAULT = 3
export const WORKFLOW_MAX_MAP_ITEMS = 20
/** Kept per review; the findings mail packs them under the bus's size cap. */
export const WORKFLOW_MAX_FINDINGS = 20

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export interface WorkflowWorktreeSpec {
  /** Created next to the bare repo if it doesn't exist yet. */
  branch: string
  /** Where a new branch starts. Absent: the repo's HEAD. */
  base?: string
}

/** A review loop's reviewer: a fresh session per round. */
export interface WorkflowReviewerSpec {
  /** What to check; templates as in a task's brief. */
  brief: string
  provider?: WorkflowProvider
  model?: string
  effort?: string
}

/**
 * A task as the lead writes it. A loop's own fields are its worker's, a map's
 * are the template each child is made from.
 */
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
  /** `loop` only, required there. */
  reviewer?: WorkflowReviewerSpec
  /** `loop` only: rounds before the lead is asked; the parser fills the default. */
  maxRounds?: number
  /** `map` only: `"<taskId>.result.items"`, the list it fans out over. */
  over?: string
  /** `map` only: more items than this is a judgment, never a cut. */
  maxItems?: number
}

export interface WorkflowLoopRound {
  /** 1-based. */
  round: number
  /** The worker's report that opened this round's review; absent while the worker works. */
  work?: { summary: string; branch?: string; changedFiles?: string[]; items?: string[]; steered: boolean; at: string }
  /** pending: the worker is still working; queued: waiting for a slot; then the reviewer's own life. */
  review: 'pending' | 'queued' | 'running' | 'waiting' | 'done' | 'failed'
  /** Number of the reviewer session serving this round (`owner.review`). */
  reviewer?: number
  verdict?: 'clean' | 'findings'
  findings?: string[]
  reviewerSummary?: string
  reviewerSteered?: boolean
  /** Why the reviewer stopped or failed, in a line. */
  note?: string
  /** The round ended because the worker's session was lost, not the reviewer. */
  workerLost?: true
  startedAt?: string
  finishedAt?: string
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
  /** loop: rounds it took. */
  rounds?: number
}

/** What an earlier attempt left behind, so a retry doesn't erase why it was needed. */
export interface WorkflowAttemptRecord {
  attempt: number
  result?: WorkflowTaskResult
  note?: string
  finishedAt?: string
  /** loop: rounds that attempt reached. */
  rounds?: number
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
  /** loop: the current attempt's rounds, oldest first. */
  rounds?: WorkflowLoopRound[]
  /** loop: reviewer sessions started in this attempt; the next one's `owner.review` is this + 1. */
  reviewers?: number
  /** Map child: its map's id. Children exist only at runtime, as `<map>.<index>`. */
  parent?: string
  /** Map child: 1-based. */
  index?: number
  /** Map child: the item it handles. */
  item?: string
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
  reviewer?: WorkflowReviewerSpec
  maxRounds?: number
  over?: string
  maxItems?: number
}

export type WorkflowOp =
  | { op: 'add'; task: WorkflowTaskSpec }
  /** Only a `queued` task can be changed. */
  | { op: 'update'; id: string; patch: WorkflowTaskPatch }
  /** A running task's worker is detached, not stopped. */
  | { op: 'cancel'; id: string }
  /** A `failed` task is queued again with a fresh worker, optionally with a new brief. */
  | { op: 'retry'; id: string; brief?: string }
  /** A loop: grant more rounds. */
  | { op: 'extend'; id: string; rounds: number }
  /** A loop that didn't converge: done as it is. */
  | { op: 'accept'; id: string; summary?: string }

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
  /** Live terminal id of each loop's current reviewer, by loop task id. */
  reviewers: Record<string, string>
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
const CHILD_TASK_ID = /^([a-z0-9][a-z0-9_-]{0,39})\.[1-9]\d?$/
const OVER = /^([a-z0-9][a-z0-9_-]{0,39})\.result\.items$/
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,120}(?<![./])$/
const BRANCH_TOKEN = /\{\{(item|index)\}\}/g
const MODEL = /^[A-Za-z0-9._:/-]{1,120}$/

export function isWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_ID.test(value)
}

/** A task id as stored: one the lead wrote, or a map child's `<map>.<n>`. */
export function isWorkflowTaskId(value: unknown): value is string {
  return typeof value === 'string' && (TASK_ID.test(value) || CHILD_TASK_ID.test(value))
}

/** A task id a lead may write: never a child's, which exist only at runtime. */
export function isSpecTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID.test(value)
}

/** The task a map's `over` names. */
export function overSource(over: string): string | undefined {
  return OVER.exec(over)?.[1]
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

function wholeNumber(v: unknown, at: string, min: number, max: number, problems: string[]): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    problems.push(`${at}: a whole number from ${min} to ${max}`)
    return undefined
  }
  return v
}

function hasBranchToken(branch: string): boolean {
  return /\{\{(item|index)\}\}/.test(branch)
}

/** `{{item}}`/`{{index}}` are accepted here; `kindProblems` refuses them outside a map. */
function parseWorktree(v: unknown, at: string, problems: string[]): WorkflowWorktreeSpec | undefined {
  if (!isObject(v)) {
    problems.push(`${at}: must be {branch, base?}`)
    return undefined
  }
  if (typeof v.branch !== 'string' || !BRANCH.test(v.branch.replace(BRANCH_TOKEN, (_m, t: string) => (t === 'item' ? 'item' : '1')))) {
    problems.push(`${at}.branch: not a valid branch name`)
    return undefined
  }
  if (v.base !== undefined && (typeof v.base !== 'string' || !BRANCH.test(v.base))) {
    problems.push(`${at}.base: not a valid branch name`)
    return undefined
  }
  return { branch: v.branch, ...(typeof v.base === 'string' ? { base: v.base } : {}) }
}

function parseAfter(v: unknown, at: string, problems: string[]): string[] | undefined {
  if (!Array.isArray(v) || !v.every(isWorkflowTaskId)) {
    problems.push(`${at}: a list of task ids`)
    return undefined
  }
  const child = v.find((id) => !isSpecTaskId(id))
  if (child !== undefined) {
    const map = CHILD_TASK_ID.exec(child)![1]
    problems.push(`${at}: "${child}" is a map's child; depend on the map "${map}" (its children exist only at runtime)`)
    return undefined
  }
  return [...new Set(v)]
}

/** provider/model/effort, shared by a task and its reviewer. */
function parseAgentFields(raw: Record<string, unknown>, at: string, problems: string[]): Pick<WorkflowTaskSpec, 'provider' | 'model' | 'effort'> {
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
  return {
    ...(provider === 'claude' || provider === 'codex' ? { provider } : {}),
    ...(typeof raw.model === 'string' && MODEL.test(raw.model) ? { model: raw.model } : {}),
    ...(typeof effort === 'string' && (REASONING_EFFORTS as readonly string[]).includes(effort) ? { effort } : {}),
  }
}

function parseReviewerSpec(v: unknown, at: string, problems: string[]): WorkflowReviewerSpec | undefined {
  if (!isObject(v)) {
    problems.push(`${at}: must be {brief, provider?, model?, effort?}`)
    return undefined
  }
  const before = problems.length
  const brief = text(v.brief, `${at}.brief`, WORKFLOW_MAX_BRIEF, problems)
  const agent = parseAgentFields(v, at, problems)
  return problems.length > before ? undefined : { brief: brief!, ...agent }
}

function parseOver(v: unknown, at: string, problems: string[]): string | undefined {
  if (typeof v !== 'string' || !OVER.test(v)) {
    problems.push(`${at}: "<taskId>.result.items", the task whose items the map fans out over`)
    return undefined
  }
  return v
}

const TEMPLATE = /\{\{([^}]*)\}\}/g
const TEMPLATE_REF = /^\s*task\.([a-z0-9][a-z0-9_-]{0,39})\.result\.(summary|branch|changedFiles|items)\s*$/
const MAP_TOKEN = /^\s*(item|index)\s*$/

function mapOnly(token: string): string {
  return `{{${token}}} only works in a map's brief, acceptance and worktree.branch`
}

/**
 * The task ids a brief's `{{task.<id>.result.<field>}}` lookups name, or
 * problems. `{{item}}` and `{{index}}` are allowed only in a map's template.
 */
export function templateRefs(brief: string, at: string, problems: string[], options: { mapTemplate?: boolean } = {}): string[] {
  const refs: string[] = []
  for (const match of brief.matchAll(TEMPLATE)) {
    const token = MAP_TOKEN.exec(match[1])
    if (token) {
      if (!options.mapTemplate) problems.push(`${at}: ${mapOnly(token[1])}`)
      continue
    }
    const ref = TEMPLATE_REF.exec(match[1])
    if (!ref) {
      problems.push(
        `${at}: unknown template {{${match[1]}}}; only {{task.<id>.result.summary|branch|changedFiles|items}}${options.mapTemplate ? ', {{item}} and {{index}}' : ''}`,
      )
      continue
    }
    refs.push(ref[1])
  }
  return refs
}

type KindFields = Pick<WorkflowTaskSpec, 'kind' | 'after' | 'provider' | 'effort' | 'worktree' | 'shape' | 'reviewer' | 'maxRounds' | 'over' | 'maxItems'>

/**
 * The rules that tie a task's fields to its kind. The parser runs them on a
 * new task; the store runs them again on a task an update patched.
 */
export function kindProblems(task: KindFields, at: string, problems: string[]): void {
  const { kind } = task
  if (kind === 'integrate') {
    if (!task.shape) problems.push(`${at}.shape: "single", "stack" or "separate"`)
    if (task.after.length === 0) problems.push(`${at}.after: an integrate task combines the tasks it runs after; name at least one`)
  } else if (task.shape !== undefined) {
    problems.push(`${at}.shape: only for kind "integrate"`)
  }
  if (task.effort !== undefined && (task.provider ?? 'claude') === 'claude') problems.push(`${at}.effort: only for provider "codex"`)
  if (kind === 'loop') {
    if (task.reviewer === undefined) problems.push(`${at}.reviewer: a review loop needs a reviewer {brief, provider?, model?, effort?}`)
    if (!task.worktree) problems.push(`${at}.worktree: a review loop needs its own branch: the reviewer reviews that branch's diff`)
  } else {
    if (task.reviewer !== undefined) problems.push(`${at}.reviewer: only for kind "loop"`)
    if (task.maxRounds !== undefined) problems.push(`${at}.maxRounds: only for kind "loop"`)
  }
  if (kind === 'map') {
    if (task.over === undefined) problems.push(`${at}.over: a map fans out over "<taskId>.result.items"; name that task`)
    if (!task.worktree) problems.push(`${at}.worktree: a map needs a branch with {{index}} or {{item}}: its children write in parallel`)
    else if (!hasBranchToken(task.worktree.branch)) {
      problems.push(`${at}.worktree.branch: each child needs its own branch: put {{index}} or {{item}} in it`)
    }
  } else {
    if (task.over !== undefined) problems.push(`${at}.over: only for kind "map"`)
    if (task.maxItems !== undefined) problems.push(`${at}.maxItems: only for kind "map"`)
    if (task.worktree && hasBranchToken(task.worktree.branch)) problems.push(`${at}.worktree.branch: ${mapOnly(task.worktree.branch.includes('{{item}}') ? 'item' : 'index')}`)
  }
}

const KINDS: readonly WorkflowTaskKind[] = ['agent', 'integrate', 'loop', 'map']

/** The plan's nested agent specs: in a workflow they are the task's own fields. */
const NESTED: Record<string, string> = {
  worker: "a loop's own fields are its worker: put brief, provider, model, effort and worktree on the task itself",
  template: "a map's own fields are its template: put brief, acceptance, provider, model, effort and worktree on the task itself",
}

function nestedProblems(raw: Record<string, unknown>, at: string, problems: string[]): void {
  for (const [key, hint] of Object.entries(NESTED)) if (raw[key] !== undefined) problems.push(`${at}.${key}: ${hint}`)
}
const SHAPES: readonly IntegrateShape[] = ['single', 'stack', 'separate']

function parseTaskSpec(raw: unknown, at: string, problems: string[]): WorkflowTaskSpec | null {
  if (!isObject(raw)) {
    problems.push(`${at}: must be an object`)
    return null
  }
  const before = problems.length
  if (!isSpecTaskId(raw.id)) problems.push(`${at}.id: lower-case letters, digits, - and _, at most 40`)
  const title = text(raw.title, `${at}.title`, WORKFLOW_MAX_TITLE, problems)
  const rawKind = raw.kind ?? 'agent'
  const kind = (KINDS as readonly unknown[]).includes(rawKind) ? (rawKind as WorkflowTaskKind) : undefined
  if (!kind) problems.push(`${at}.kind: "agent", "integrate", "loop" or "map"`)
  nestedProblems(raw, at, problems)
  const after = parseAfter(raw.after ?? [], `${at}.after`, problems)
  const brief = text(raw.brief, `${at}.brief`, WORKFLOW_MAX_BRIEF, problems)
  const acceptance = text(raw.acceptance, `${at}.acceptance`, WORKFLOW_MAX_GOAL, problems, false)
  const agent = parseAgentFields(raw, at, problems)
  const worktree = raw.worktree === undefined ? undefined : parseWorktree(raw.worktree, `${at}.worktree`, problems)
  const onFailure = raw.onFailure ?? 'escalate'
  if (onFailure !== 'retry' && onFailure !== 'escalate') problems.push(`${at}.onFailure: "retry" or "escalate"`)
  let shape: IntegrateShape | undefined
  if (raw.shape !== undefined) {
    if ((SHAPES as readonly unknown[]).includes(raw.shape)) shape = raw.shape as IntegrateShape
    else if (kind === 'integrate') problems.push(`${at}.shape: "single", "stack" or "separate"`)
    else problems.push(`${at}.shape: only for kind "integrate"`)
  }
  const reviewer = raw.reviewer === undefined ? undefined : parseReviewerSpec(raw.reviewer, `${at}.reviewer`, problems)
  const maxRounds =
    raw.maxRounds === undefined ? (kind === 'loop' ? WORKFLOW_LOOP_ROUNDS_DEFAULT : undefined) : wholeNumber(raw.maxRounds, `${at}.maxRounds`, 1, WORKFLOW_LOOP_ROUNDS_SPEC_MAX, problems)
  const over = raw.over === undefined ? undefined : parseOver(raw.over, `${at}.over`, problems)
  const maxItems =
    raw.maxItems === undefined ? (kind === 'map' ? WORKFLOW_MAX_MAP_ITEMS : undefined) : wholeNumber(raw.maxItems, `${at}.maxItems`, 1, WORKFLOW_MAX_MAP_ITEMS, problems)
  if (kind) {
    kindProblems(
      {
        kind,
        after: after ?? [],
        ...agent,
        // A worktree already refused for its shape isn't reported missing too.
        worktree: raw.worktree === undefined ? undefined : (worktree ?? { branch: kind === 'map' ? '{{index}}' : 'refused' }),
        shape,
        reviewer: raw.reviewer === undefined ? undefined : (reviewer ?? { brief: '' }),
        maxRounds: raw.maxRounds === undefined ? undefined : (maxRounds ?? 0),
        over: raw.over === undefined ? undefined : (over ?? ''),
        maxItems: raw.maxItems === undefined ? undefined : (maxItems ?? 0),
      },
      at,
      problems,
    )
  }
  // The field checks and the kind rules can both report one mistake.
  const mine = [...new Set(problems.splice(before))]
  problems.push(...mine)
  if (mine.length > 0) return null
  return {
    id: raw.id as string,
    title: title!,
    kind: kind!,
    after: after!,
    brief: brief!,
    ...(acceptance ? { acceptance } : {}),
    ...agent,
    ...(worktree ? { worktree } : {}),
    onFailure: onFailure as OnFailure,
    ...(shape ? { shape } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(over ? { over } : {}),
    ...(maxItems !== undefined ? { maxItems } : {}),
  }
}

type GraphTask = Pick<WorkflowTaskSpec, 'id' | 'after' | 'brief'> & Partial<Pick<WorkflowTask, 'kind' | 'acceptance' | 'reviewer' | 'over' | 'parent'>>

/**
 * Check a graph's edges: every `after` and template names a task that exists,
 * a template or a map's `over` names an ancestor (its result exists by then),
 * and nothing cycles. Map children are skipped: their briefs are resolved
 * text. Pushes problems; returns nothing.
 */
export function checkGraph(all: readonly GraphTask[], problems: string[]): void {
  const tasks = all.filter((t) => !isChild(t))
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
    const ancestors = ancestorsOf(task.id, byId)
    const mapTemplate = task.kind === 'map'
    const checkRefs = (source: string | undefined, field: string, isTemplate: boolean): void => {
      if (!source) return
      const at = `task ${task.id}.${field}`
      for (const ref of templateRefs(source, at, problems, { mapTemplate: isTemplate })) {
        if (!ancestors.has(ref)) problems.push(`${at}: {{task.${ref}…}} must name a task it runs after (directly or not)`)
      }
    }
    checkRefs(task.brief, 'brief', mapTemplate)
    checkRefs(task.reviewer?.brief, 'reviewer.brief', false)
    if (mapTemplate) {
      checkRefs(task.acceptance, 'acceptance', true)
      const source = task.over ? overSource(task.over) : undefined
      if (source && !ancestors.has(source)) problems.push(`task ${task.id}.over: must name a task this map runs after ("${source}" isn't one)`)
    } else if (task.acceptance) {
      // PR 1 never templated an acceptance, so only the map tokens are refused there.
      for (const match of task.acceptance.matchAll(TEMPLATE)) {
        const token = MAP_TOKEN.exec(match[1])
        if (token) problems.push(`task ${task.id}.acceptance: ${mapOnly(token[1])}`)
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

const PATCH_KEYS = ['title', 'after', 'brief', 'acceptance', 'provider', 'model', 'effort', 'worktree', 'onFailure', 'shape', 'reviewer', 'maxRounds', 'over', 'maxItems']

/** Field shapes only: the store checks the patched task with `kindProblems`. */
function parsePatchFields(raw: unknown, at: string, problems: string[]): WorkflowTaskPatch | null {
  if (!isObject(raw)) {
    problems.push(`${at}: must be an object`)
    return null
  }
  const before = problems.length
  const patch: WorkflowTaskPatch = {}
  nestedProblems(raw, at, problems)
  for (const key of Object.keys(raw)) {
    if (!PATCH_KEYS.includes(key) && !(key in NESTED)) problems.push(`${at}.${key}: can't be changed`)
  }
  if (raw.title !== undefined) patch.title = text(raw.title, `${at}.title`, WORKFLOW_MAX_TITLE, problems)
  if (raw.brief !== undefined) patch.brief = text(raw.brief, `${at}.brief`, WORKFLOW_MAX_BRIEF, problems)
  if (raw.after !== undefined) patch.after = parseAfter(raw.after, `${at}.after`, problems)
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
  if (raw.reviewer !== undefined) patch.reviewer = parseReviewerSpec(raw.reviewer, `${at}.reviewer`, problems)
  if (raw.maxRounds !== undefined) patch.maxRounds = wholeNumber(raw.maxRounds, `${at}.maxRounds`, 1, WORKFLOW_LOOP_ROUNDS_SPEC_MAX, problems)
  if (raw.over !== undefined) patch.over = parseOver(raw.over, `${at}.over`, problems)
  if (raw.maxItems !== undefined) patch.maxItems = wholeNumber(raw.maxItems, `${at}.maxItems`, 1, WORKFLOW_MAX_MAP_ITEMS, problems)
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
    } else if (op.op === 'extend') {
      const rounds = wholeNumber(op.rounds, `${at}.rounds`, 1, WORKFLOW_LOOP_ROUNDS_SPEC_MAX, problems)
      if (rounds !== undefined) ops.push({ op: 'extend', id: op.id, rounds })
    } else if (op.op === 'accept') {
      const summary = op.summary === undefined ? undefined : text(op.summary, `${at}.summary`, WORKFLOW_MAX_SUMMARY, problems)
      if (op.summary === undefined || summary) ops.push({ op: 'accept', id: op.id, ...(summary ? { summary } : {}) })
    } else {
      problems.push(`${at}.op: "add", "update", "cancel", "retry", "extend" or "accept"`)
    }
  })
  if (problems.length > 0) throw new WorkflowValidationError(problems)
  return ops
}

// -- Map children -------------------------------------------------

function slug(item: string, index: number): string {
  const s = item
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .slice(0, 40)
    .replace(/[-./]+$/, '')
  return s || `item-${index}`
}

/**
 * A map child's branch: the pattern with `{{index}}` and `{{item}}` (slugged)
 * filled in, made valid and unique among `taken`. Across workflows a branch of
 * the same name reuses its worktree, as any task's does.
 */
export function childBranch(pattern: string, item: string, index: number, taken: ReadonlySet<string>): string {
  let name = pattern.replaceAll('{{index}}', String(index)).replaceAll('{{item}}', slug(item, index))
  if (!BRANCH.test(name)) {
    const bare = pattern
      .replace(BRANCH_TOKEN, '')
      .replace(/\/{2,}/g, '/')
      .replace(/[-./]+$/, '')
      .slice(0, 100)
    name = bare && BRANCH.test(`${bare}-${index}`) ? `${bare}-${index}` : `item-${index}`
  }
  if (!taken.has(name)) return name
  const base = name.slice(0, 110)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base}-${index}` : `${base}-${index}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** A map child's title: its item's first line, fit for a session label. */
export function childTitle(item: string, index: number): string {
  const line = (item.split('\n')[0] ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, 80)
  return line || `Item ${index}`
}

export function isChild(task: Pick<WorkflowTask, 'parent'>): boolean {
  return task.parent !== undefined
}

/** A map's children, by index. Empty until the map expanded. */
export function childrenOf(workflow: Pick<Workflow, 'tasks'>, mapId: string): WorkflowTask[] {
  return workflow.tasks.filter((t) => t.parent === mapId).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
}

// -- Sessions of a task -------------------------------------------

/** A session a task holds: its worker, or with `review` one of a loop's reviewers. */
export interface TaskSlot {
  taskId: string
  attempt: number
  review?: number
}

export function currentRound(task: Pick<WorkflowTask, 'rounds'>): WorkflowLoopRound | undefined {
  return task.rounds?.at(-1)
}

/**
 * The sessions doing a task's work right now: the worker while it runs or
 * waits (a loop's also while only its reviewer failed, so a retry can reuse
 * it) and a loop's reviewer while it runs or waits.
 */
export function currentSlots(task: WorkflowTask): TaskSlot[] {
  if (task.attempt === 0) return []
  const round = currentRound(task)
  const live = task.state === 'running' || task.state === 'waiting'
  const slots: TaskSlot[] = []
  if (live || (task.kind === 'loop' && task.state === 'failed' && round?.review === 'failed' && !round.workerLost)) {
    slots.push({ taskId: task.id, attempt: task.attempt })
  }
  if (live && task.kind === 'loop' && round?.reviewer !== undefined && (round.review === 'running' || round.review === 'waiting')) {
    slots.push({ taskId: task.id, attempt: task.attempt, review: round.reviewer })
  }
  return slots
}

/**
 * Is this owner the task's current worker, or the loop's latest reviewer?
 * Whatever the task's state: a finished task's worker stays its session until
 * Dismiss. An earlier reviewer is superseded (closed when the next starts).
 */
export function ownerIsCurrent(task: WorkflowTask, owner: TaskSlot): boolean {
  if (owner.taskId !== task.id || task.attempt === 0 || owner.attempt !== task.attempt) return false
  if (owner.review === undefined) return true
  return task.kind === 'loop' && owner.review === task.reviewers
}

/**
 * Is this owner a session a cancel detached? Those that held a current slot
 * when the task was cancelled: its worker, and its reviewer only while that
 * was reviewing. A reviewer that had already finished holds no work.
 */
export function detachedSlot(task: WorkflowTask, owner: TaskSlot): boolean {
  if (task.state !== 'cancelled' || !task.detached || !ownerIsCurrent(task, owner)) return false
  if (owner.review === undefined) return true
  const round = currentRound(task)
  return round?.reviewer === owner.review && (round.review === 'running' || round.review === 'waiting')
}

/** A loop's items: those of the latest round whose work reported any. */
export function loopItems(task: Pick<WorkflowTask, 'rounds'>): string[] | undefined {
  return (task.rounds ?? []).findLast((r) => r.work?.items !== undefined)?.work?.items
}

export function slotKey(workflowId: string, slot: TaskSlot): string {
  return `${workflowId}/${slot.taskId}#${slot.attempt}${slot.review !== undefined ? `/r${slot.review}` : ''}`
}

/**
 * Which session a `waiting` task waits on. Null when it isn't waiting, or
 * when a loop that didn't converge waits on the lead.
 */
export function waitingSlot(task: WorkflowTask): 'worker' | 'reviewer' | null {
  if (task.state !== 'waiting') return null
  if (task.kind !== 'loop') return 'worker'
  const round = currentRound(task)
  if (!round || round.review === 'pending') return 'worker'
  return round.review === 'waiting' ? 'reviewer' : null
}

export type LoopPhase = 'working' | 'reviewing' | 'not-converged' | 'reviewer-failed' | 'clean'

/** Where a loop's current round stands; null before its first round. */
export function loopPhase(task: Pick<WorkflowTask, 'rounds'>): LoopPhase | null {
  const round = currentRound(task)
  if (!round) return null
  if (round.review === 'pending') return 'working'
  if (round.review === 'failed') return round.workerLost ? null : 'reviewer-failed'
  if (round.review === 'done') return round.verdict === 'clean' ? 'clean' : 'not-converged'
  return 'reviewing'
}

// -- Attempts -----------------------------------------------------

/** Move the current attempt's result and note into the task's history; a loop starts over at round 1. */
export function archiveAttempt(task: WorkflowTask): void {
  const rounds = task.rounds?.length ?? 0
  if (task.attempt > 0 && (task.result || task.note || rounds > 0)) {
    const record: WorkflowAttemptRecord = {
      attempt: task.attempt,
      ...(task.result ? { result: task.result } : {}),
      ...(task.note ? { note: task.note } : {}),
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(rounds > 0 ? { rounds } : {}),
    }
    task.history = [...(task.history ?? []).filter((h) => h.attempt !== task.attempt), record].slice(-WORKFLOW_MAX_HISTORY)
  }
  delete task.result
  delete task.note
  delete task.rounds
  delete task.reviewers
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
      ...(typeof item.rounds === 'number' && Number.isInteger(item.rounds) && item.rounds > 0 ? { rounds: item.rounds } : {}),
    })
  }
  return out.slice(-WORKFLOW_MAX_HISTORY)
}

const REVIEW_STATES: readonly WorkflowLoopRound['review'][] = ['pending', 'queued', 'running', 'waiting', 'done', 'failed']

function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : undefined
}

/** A stored loop column (`{reviewers, rounds}`), dropping rounds without the right shape (counted in `dropped`). */
export function parseLoopRounds(raw: unknown): { reviewers: number; rounds: WorkflowLoopRound[]; dropped: number } {
  if (!isObject(raw)) return { reviewers: 0, rounds: [], dropped: 0 }
  const reviewers = typeof raw.reviewers === 'number' && Number.isInteger(raw.reviewers) && raw.reviewers > 0 ? raw.reviewers : 0
  const rounds: WorkflowLoopRound[] = []
  const stored: unknown[] = Array.isArray(raw.rounds) ? raw.rounds : []
  for (const r of stored) {
    if (!isObject(r) || typeof r.round !== 'number' || !Number.isInteger(r.round) || r.round < 1) continue
    if (!(REVIEW_STATES as readonly unknown[]).includes(r.review)) continue
    const w = r.work
    const work =
      isObject(w) && typeof w.summary === 'string' && typeof w.at === 'string'
        ? {
            summary: w.summary,
            ...(typeof w.branch === 'string' ? { branch: w.branch } : {}),
            ...(stringList(w.changedFiles) ? { changedFiles: stringList(w.changedFiles) } : {}),
            ...(stringList(w.items) ? { items: stringList(w.items) } : {}),
            steered: w.steered === true,
            at: w.at,
          }
        : undefined
    rounds.push({
      round: r.round,
      ...(work ? { work } : {}),
      review: r.review as WorkflowLoopRound['review'],
      ...(typeof r.reviewer === 'number' && Number.isInteger(r.reviewer) && r.reviewer > 0 ? { reviewer: r.reviewer } : {}),
      ...(r.verdict === 'clean' || r.verdict === 'findings' ? { verdict: r.verdict } : {}),
      ...(stringList(r.findings) ? { findings: stringList(r.findings) } : {}),
      ...(typeof r.reviewerSummary === 'string' ? { reviewerSummary: r.reviewerSummary } : {}),
      ...(r.reviewerSteered === true ? { reviewerSteered: true } : {}),
      ...(typeof r.note === 'string' ? { note: r.note } : {}),
      ...(r.workerLost === true ? { workerLost: true as const } : {}),
      ...(typeof r.startedAt === 'string' ? { startedAt: r.startedAt } : {}),
      ...(typeof r.finishedAt === 'string' ? { finishedAt: r.finishedAt } : {}),
    })
  }
  return { reviewers, rounds, dropped: stored.length - rounds.length }
}

// -- Derived views ------------------------------------------------

/** Dependency depth per task: 0 for roots. Cancelled tasks keep their column. Pass top-level tasks only. */
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

/** Done of total, cancelled left out. An expanded map counts as its children. */
export function workflowProgress(workflow: Pick<Workflow, 'tasks'>): { done: number; total: number } {
  const expanded = new Set(workflow.tasks.flatMap((t) => (t.parent !== undefined ? [t.parent] : [])))
  const counted = workflow.tasks.filter((t) => t.state !== 'cancelled' && !expanded.has(t.id))
  return { done: counted.filter((t) => t.state === 'done').length, total: counted.length }
}

const MAX_DESCRIBED_FINDINGS = 10
const MAX_DESCRIBED_ITEM = 120

function firstLine(s: string): string {
  return s.split('\n')[0] ?? ''
}

function describeAttempts(t: WorkflowTask, sessionId: string | undefined): Record<string, unknown> {
  return {
    ...(t.attempt > 1 ? { attempt: t.attempt } : {}),
    ...(t.note ? { note: t.note } : {}),
    ...(t.worktreePath ? { worktree: t.worktreePath } : {}),
    ...(t.detached ? { detached: true } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  }
}

function describeHistory(t: WorkflowTask): Record<string, unknown> {
  return t.history && t.history.length > 0
    ? {
        earlierAttempts: t.history.map((h) => ({
          attempt: h.attempt,
          ...(h.result ? { status: h.result.status, summary: h.result.summary } : {}),
          ...(h.note ? { note: h.note } : {}),
          ...(h.rounds ? { rounds: h.rounds } : {}),
        })),
      }
    : {}
}

function describeLoop(t: WorkflowTask): Record<string, unknown> {
  const rounds = t.rounds ?? []
  const phase = loopPhase(t)
  const reviewed = [...rounds].reverse().find((r) => r.review === 'done' && r.verdict)
  return {
    round: rounds.length,
    maxRounds: t.maxRounds ?? WORKFLOW_LOOP_ROUNDS_DEFAULT,
    ...(phase ? { phase } : {}),
    ...(reviewed ? { lastVerdict: reviewed.verdict } : {}),
    ...(reviewed?.verdict === 'findings' && reviewed.findings ? { openFindings: reviewed.findings.slice(0, MAX_DESCRIBED_FINDINGS) } : {}),
  }
}

function describeMap(t: WorkflowTask, workflow: Workflow, workers: Record<string, string>): Record<string, unknown> {
  const children = childrenOf(workflow, t.id)
  const items = children.length > 0 ? children.length : t.result?.items ? t.result.items.length : null
  return {
    over: t.over,
    items,
    ...(children.length > 0
      ? {
          children: children.map((c) => ({
            id: c.id,
            item: (c.item ?? '').slice(0, MAX_DESCRIBED_ITEM),
            state: c.state,
            ...describeAttempts(c, workers[c.id]),
            ...(c.result ? { summary: firstLine(c.result.summary) } : {}),
            ...(c.result?.steered ? { steered: true } : {}),
            ...describeHistory(c),
          })),
        }
      : {}),
  }
}

/** `get_workflow`'s answer: what a woken lead needs, no transcripts. Map children nest under their map. */
export function describeWorkflow(snapshot: WorkflowSnapshot): Record<string, unknown> {
  const { workflow } = snapshot
  return {
    workflowId: workflow.id,
    title: workflow.title,
    status: workflow.status,
    version: workflow.version,
    ...(snapshot.paused ? { paused: snapshot.paused } : {}),
    progress: workflowProgress(workflow),
    tasks: workflow.tasks
      .filter((t) => !isChild(t))
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        state: t.state,
        after: t.after,
        ...describeAttempts(t, snapshot.workers[t.id]),
        ...(snapshot.reviewers[t.id] ? { reviewer_session_id: snapshot.reviewers[t.id] } : {}),
        ...(t.kind === 'loop' ? { loop: describeLoop(t) } : {}),
        ...(t.kind === 'map' ? { map: describeMap(t, workflow, snapshot.workers) } : {}),
        ...(t.result
          ? {
              result: {
                status: t.result.status,
                summary: t.result.summary,
                ...(t.result.branch ? { branch: t.result.branch } : {}),
                ...(t.result.changedFiles ? { changedFiles: t.result.changedFiles } : {}),
                ...(t.result.items ? { items: t.result.items } : {}),
                ...(t.result.verdict ? { verdict: t.result.verdict } : {}),
                ...(t.result.findings ? { findings: t.result.findings } : {}),
                ...(t.result.rounds ? { rounds: t.result.rounds } : {}),
                ...(t.result.steered ? { steered: true } : {}),
              },
            }
          : {}),
        ...describeHistory(t),
      })),
    ...(workflow.judgments.length > 0 ? { openQuestions: workflow.judgments.map((j) => ({ task: j.taskId, question: j.question })) } : {}),
  }
}
