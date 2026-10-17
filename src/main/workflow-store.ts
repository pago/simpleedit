/**
 * Workflows, persisted in the app database (`workflows`, `workflow_tasks`,
 * `workflow_patches`).
 *
 * A workflow is small (at most WORKFLOW_MAX_TASKS tasks), so it is read and
 * written whole: callers load it, change the object and save it, all
 * synchronously, so nothing else in main runs in between. What the lead may
 * change goes through `applyOps`, which checks it against the graph; what only
 * the engine may change (task state, results) is written by the engine through
 * `saveWorkflow`.
 */
import { getDb, transaction } from './db'
import {
  WorkflowValidationError,
  archiveAttempt,
  checkGraph,
  isFinished,
  newWorkflowId,
  parseAttemptHistory,
  type NewWorkflowInput,
  type Workflow,
  type WorkflowJudgment,
  type WorkflowOp,
  type WorkflowPatch,
  type WorkflowStatus,
  type WorkflowTask,
  type WorkflowTaskResult,
  type WorkflowTaskSpec,
  type WorkflowTaskState,
  WORKFLOW_MAX_TASKS,
} from '../shared/workflow'

interface WorkflowRow {
  id: string
  project: string
  lead_key: string
  lead_label: string
  title: string
  goal: string
  version: number
  status: string
  judgments: string
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface TaskRow {
  id: string
  spec: string
  state: string
  attempt: number
  result: string | null
  note: string | null
  worktree_path: string | null
  steered: number
  started_at: string | null
  finished_at: string | null
  added_by: number | null
  cancelled_by: number | null
  detached: number
  history: string | null
}

function toTask(r: TaskRow): WorkflowTask {
  const spec = JSON.parse(r.spec) as WorkflowTaskSpec
  const history = r.history ? parseAttemptHistory(JSON.parse(r.history)) : []
  return {
    ...spec,
    id: r.id,
    state: r.state as WorkflowTaskState,
    attempt: r.attempt,
    steered: r.steered === 1,
    ...(r.result ? { result: JSON.parse(r.result) as WorkflowTaskResult } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.worktree_path ? { worktreePath: r.worktree_path } : {}),
    ...(r.started_at ? { startedAt: r.started_at } : {}),
    ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
    ...(r.added_by !== null ? { addedBy: r.added_by } : {}),
    ...(r.cancelled_by !== null ? { cancelledBy: r.cancelled_by } : {}),
    ...(r.detached === 1 ? { detached: true } : {}),
    ...(history.length > 0 ? { history } : {}),
  }
}

function specOf(task: WorkflowTask): WorkflowTaskSpec {
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    after: task.after,
    brief: task.brief,
    ...(task.acceptance ? { acceptance: task.acceptance } : {}),
    ...(task.provider ? { provider: task.provider } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.effort ? { effort: task.effort } : {}),
    ...(task.worktree ? { worktree: task.worktree } : {}),
    onFailure: task.onFailure,
    ...(task.shape ? { shape: task.shape } : {}),
  }
}

function load(row: WorkflowRow): Workflow {
  const d = getDb()
  const tasks = (d.prepare('SELECT * FROM workflow_tasks WHERE workflow_id = ? ORDER BY position').all(row.id) as unknown as TaskRow[]).map(toTask)
  const patches = (
    d.prepare('SELECT version, at, ops FROM workflow_patches WHERE workflow_id = ? ORDER BY version').all(row.id) as Array<{
      version: number
      at: string
      ops: string
    }>
  ).map((p): WorkflowPatch => ({ version: p.version, at: p.at, ops: JSON.parse(p.ops) as WorkflowOp[] }))
  return {
    id: row.id,
    project: row.project,
    leadKey: row.lead_key,
    leadLabel: row.lead_label,
    title: row.title,
    goal: row.goal,
    version: row.version,
    status: row.status as WorkflowStatus,
    tasks,
    patches,
    judgments: JSON.parse(row.judgments) as WorkflowJudgment[],
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  }
}

export function getWorkflow(id: string): Workflow | null {
  const row = getDb().prepare('SELECT * FROM workflows WHERE id = ? AND archived_at IS NULL').get(id) as WorkflowRow | undefined
  return row ? load(row) : null
}

/** A project's workflows that weren't dismissed, oldest first. */
export function listWorkflows(project: string): Workflow[] {
  const rows = getDb()
    .prepare('SELECT * FROM workflows WHERE project = ? AND archived_at IS NULL ORDER BY created_at, id')
    .all(project) as unknown as WorkflowRow[]
  return rows.map(load)
}

/** Every workflow the engine may still have to drive. */
export function listLiveWorkflows(): Workflow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM workflows WHERE archived_at IS NULL AND status IN ('running', 'failed') ORDER BY created_at, id`)
    .all() as unknown as WorkflowRow[]
  return rows.map(load)
}

/** Writes the workflow row and every task row. Patches are appended by `applyOps`. */
export function saveWorkflow(workflow: Workflow): void {
  const d = getDb()
  transaction(d, () => {
    d.prepare(
      `INSERT INTO workflows (id, project, lead_key, lead_label, title, goal, version, status, judgments, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET lead_key = excluded.lead_key, lead_label = excluded.lead_label, title = excluded.title,
         goal = excluded.goal, version = excluded.version, status = excluded.status, judgments = excluded.judgments,
         started_at = excluded.started_at, finished_at = excluded.finished_at`,
    ).run(
      workflow.id,
      workflow.project,
      workflow.leadKey,
      workflow.leadLabel,
      workflow.title,
      workflow.goal,
      workflow.version,
      workflow.status,
      JSON.stringify(workflow.judgments),
      workflow.createdAt,
      workflow.startedAt ?? null,
      workflow.finishedAt ?? null,
    )
    const upsert = d.prepare(
      `INSERT INTO workflow_tasks (workflow_id, id, position, spec, state, attempt, result, note, worktree_path, steered,
         started_at, finished_at, added_by, cancelled_by, detached, history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, id) DO UPDATE SET position = excluded.position, spec = excluded.spec, state = excluded.state,
         attempt = excluded.attempt, result = excluded.result, note = excluded.note, worktree_path = excluded.worktree_path,
         steered = excluded.steered, started_at = excluded.started_at, finished_at = excluded.finished_at,
         added_by = excluded.added_by, cancelled_by = excluded.cancelled_by, detached = excluded.detached, history = excluded.history`,
    )
    workflow.tasks.forEach((task, i) =>
      upsert.run(
        workflow.id,
        task.id,
        i,
        JSON.stringify(specOf(task)),
        task.state,
        task.attempt,
        task.result ? JSON.stringify(task.result) : null,
        task.note ?? null,
        task.worktreePath ?? null,
        task.steered ? 1 : 0,
        task.startedAt ?? null,
        task.finishedAt ?? null,
        task.addedBy ?? null,
        task.cancelledBy ?? null,
        task.detached ? 1 : 0,
        task.history && task.history.length > 0 ? JSON.stringify(task.history) : null,
      ),
    )
  })
}

export function createWorkflow(
  project: string,
  lead: { key: string; label: string },
  input: NewWorkflowInput,
  now = new Date(),
): Workflow {
  const workflow: Workflow = {
    id: newWorkflowId(),
    project,
    leadKey: lead.key,
    leadLabel: lead.label,
    title: input.title,
    goal: input.goal,
    version: 1,
    status: 'draft',
    tasks: input.tasks.map((spec) => ({ ...spec, state: 'queued', attempt: 0, steered: false })),
    patches: [],
    judgments: [],
    createdAt: now.toISOString(),
  }
  saveWorkflow(workflow)
  return workflow
}

/** The workflows a lead key leads, finished ones included. */
export function listLeadWorkflowIds(leadKey: string): string[] {
  return (getDb().prepare('SELECT id FROM workflows WHERE lead_key = ? AND archived_at IS NULL').all(leadKey) as Array<{ id: string }>).map((r) => r.id)
}

/** A lead handed off to a successor: every workflow it leads follows. Returns their ids. */
export function rekeyLead(fromKey: string, toKey: string): string[] {
  if (fromKey === toKey) return []
  const ids = listLeadWorkflowIds(fromKey)
  if (ids.length > 0) getDb().prepare('UPDATE workflows SET lead_key = ? WHERE lead_key = ? AND archived_at IS NULL').run(toKey, fromKey)
  return ids
}

/** Dismiss: the record leaves every list but stays in the database. */
export function archiveWorkflow(id: string, now = new Date()): boolean {
  return getDb().prepare('UPDATE workflows SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(now.toISOString(), id).changes > 0
}

export type ApplyOpsResult = { ok: true; workflow: Workflow } | { ok: false; conflict: { version: number } }

/**
 * Apply a lead's patch against `baseVersion`, all or nothing. A stale version
 * is a conflict (the lead re-reads with `get_workflow`); an op the graph
 * refuses throws `WorkflowValidationError`, and nothing is written.
 */
export function applyOps(id: string, baseVersion: number, ops: WorkflowOp[], now = new Date()): ApplyOpsResult {
  const workflow = getWorkflow(id)
  if (!workflow) throw new WorkflowValidationError([`no workflow ${id}`])
  if (workflow.version !== baseVersion) return { ok: false, conflict: { version: workflow.version } }
  const next = applyOpsTo(workflow, ops, now)
  const d = getDb()
  transaction(d, () => {
    saveWorkflow(next)
    d.prepare('INSERT INTO workflow_patches (workflow_id, version, at, ops) VALUES (?, ?, ?, ?)').run(
      next.id,
      next.version,
      now.toISOString(),
      JSON.stringify(ops),
    )
  })
  return { ok: true, workflow: getWorkflow(id)! }
}

/** The patched workflow, or a `WorkflowValidationError` naming every refused op. Pure. */
export function applyOpsTo(workflow: Workflow, ops: readonly WorkflowOp[], now = new Date()): Workflow {
  if (isFinished(workflow.status) && workflow.status !== 'failed') {
    throw new WorkflowValidationError([`workflow ${workflow.id} is ${workflow.status}; it can't be patched`])
  }
  const version = workflow.version + 1
  const tasks = workflow.tasks.map((t) => ({ ...t }))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const touched = new Set<string>()
  const problems: string[] = []
  ops.forEach((op, i) => {
    const at = `ops[${i}]`
    if (op.op === 'add') {
      if (byId.has(op.task.id)) {
        problems.push(`${at}: task "${op.task.id}" already exists`)
        return
      }
      const task: WorkflowTask = { ...op.task, state: 'queued', attempt: 0, steered: false, addedBy: version }
      tasks.push(task)
      byId.set(task.id, task)
      return
    }
    const task = byId.get(op.id)
    if (!task) {
      problems.push(`${at}: no task "${op.id}"`)
      return
    }
    touched.add(task.id)
    if (op.op === 'update') {
      if (task.state !== 'queued') {
        problems.push(`${at}: task "${task.id}" is ${task.state}; only a queued task can be updated`)
        return
      }
      const { patch } = op
      for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
        const value = patch[key]
        if (value === null) delete (task as unknown as Record<string, unknown>)[key]
        else if (value !== undefined) (task as unknown as Record<string, unknown>)[key] = value
      }
      if (task.kind === 'integrate' && task.after.length === 0) problems.push(`${at}: an integrate task needs at least one task in after`)
      if (task.kind !== 'integrate' && task.shape) problems.push(`${at}: shape is only for integrate tasks`)
      if (task.effort && (task.provider ?? 'claude') === 'claude') problems.push(`${at}: effort is only for provider "codex"`)
    } else if (op.op === 'cancel') {
      if (task.state === 'done' || task.state === 'cancelled') {
        problems.push(`${at}: task "${task.id}" is already ${task.state}`)
        return
      }
      if (task.state === 'running' || task.state === 'waiting') task.detached = true
      task.state = 'cancelled'
      task.cancelledBy = version
      task.finishedAt = now.toISOString()
    } else if (op.op === 'retry') {
      if (task.state !== 'failed') {
        problems.push(`${at}: task "${task.id}" is ${task.state}; only a failed task can be retried`)
        return
      }
      task.state = 'queued'
      if (op.brief) task.brief = op.brief
      archiveAttempt(task)
      delete task.finishedAt
    } else {
      problems.push(`${at}: ${op.op} isn't supported yet`)
    }
  })
  if (tasks.length > WORKFLOW_MAX_TASKS) problems.push(`a workflow has at most ${WORKFLOW_MAX_TASKS} tasks`)
  if (problems.length === 0) checkGraph(tasks, problems)
  if (problems.length > 0) throw new WorkflowValidationError(problems)
  return {
    ...workflow,
    version,
    tasks,
    // A patch is the lead's answer: the questions about what it touched are settled.
    judgments: workflow.judgments.filter((j) => !touched.has(j.taskId)),
    status: workflow.status === 'failed' ? 'running' : workflow.status,
    ...(workflow.status === 'failed' ? { finishedAt: undefined } : {}),
    patches: [...workflow.patches, { version, at: now.toISOString(), ops: [...ops] }],
  }
}

export function _resetWorkflowsForTests(): void {
  const d = getDb()
  d.exec('DELETE FROM workflow_patches; DELETE FROM workflow_tasks; DELETE FROM workflows;')
}
