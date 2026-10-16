import type { AgentStatus } from '../../shared/ipc-types'
import { taskDepths, workflowProgress, type Workflow, type WorkflowSnapshot, type WorkflowTask } from '../../shared/workflow'

export type CardTone = 'done' | 'running' | 'waiting' | 'queued' | 'failed' | 'cancelled'

export interface TaskCard {
  id: string
  title: string
  tone: CardTone
  /** e.g. "✓ Done", "● Waiting on you" */
  status: string
  /** Agent and model, e.g. "Codex · gpt-5" */
  agent: string
  /** One line of what is going on. */
  detail: string
  depth: number
  added: boolean
  hasWorker: boolean
}

export interface NeedsYouItem {
  taskId: string
  title: string
  text: string
  /** Opening the worker's terminal is the way to answer. */
  canOpen: boolean
  kind: 'worker' | 'lead'
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

function agentLabel(task: WorkflowTask): string {
  const provider = task.provider === 'codex' ? 'Codex' : 'Claude'
  return task.model ? `${provider} · ${task.model}` : provider
}

/** What the card shows, from the stored task plus the worker's live status. */
export function taskCard(task: WorkflowTask, depth: number, workerStatus: AgentStatus | null, waitingOnLead = false): TaskCard {
  const base = { id: task.id, title: task.title, agent: agentLabel(task), depth, added: task.addedBy !== undefined, hasWorker: workerStatus !== null }
  switch (task.state) {
    case 'done':
      return { ...base, tone: 'done', status: '✓ Done', detail: task.result ? firstLine(task.result.summary) : '' }
    case 'failed':
      return { ...base, tone: 'failed', status: '✕ Failed', detail: firstLine(task.note ?? task.result?.summary ?? '') }
    case 'cancelled':
      return {
        ...base,
        tone: 'cancelled',
        status: task.cancelledBy !== undefined ? `✕ Cancelled by patch ${task.cancelledBy - 1}` : '✕ Cancelled',
        detail: task.detached ? 'Its worker moved to the sidebar' : '',
      }
    case 'waiting':
      return waitingOnLead
        ? { ...base, tone: 'running', status: '◆ Waiting on the lead', detail: firstLine(task.note ?? '') }
        : { ...base, tone: 'waiting', status: '● Waiting on you', detail: firstLine(task.note ?? '') }
    case 'running':
      if (workerStatus === 'waiting') return { ...base, tone: 'waiting', status: '● Waiting on you', detail: 'The worker is asking something' }
      if (workerStatus === 'error' || workerStatus === 'exited') return { ...base, tone: 'failed', status: '✕ Worker stopped', detail: '' }
      return {
        ...base,
        tone: 'running',
        status: task.attempt > 1 ? `▶ Running · attempt ${task.attempt}` : '▶ Running',
        detail: task.worktree ? task.worktree.branch : '',
      }
    case 'queued':
      return {
        ...base,
        tone: 'queued',
        status: task.addedBy !== undefined ? `＋ Added by patch ${task.addedBy - 1} · queued` : '○ Queued',
        detail: task.note ? firstLine(task.note) : task.after.length > 0 ? `after: ${task.after.join(', ')}` : '',
      }
  }
}

export function taskCards(snapshot: WorkflowSnapshot, statusOf: (terminalId: string) => AgentStatus): TaskCard[] {
  const depths = taskDepths(snapshot.workflow.tasks)
  return snapshot.workflow.tasks.map((task) => {
    const worker = snapshot.workers[task.id]
    const onLead = snapshot.workflow.judgments.some((j) => j.taskId === task.id)
    return taskCard(task, depths.get(task.id) ?? 0, worker ? statusOf(worker) : null, onLead)
  })
}

/**
 * Everything that waits on the user or the lead, most urgent first.
 * `restored` names the tasks whose worker is a restored placeholder: main
 * lists no terminal for it, but the popup can resume it.
 */
export function needsYou(
  snapshot: WorkflowSnapshot,
  statusOf: (terminalId: string) => AgentStatus,
  restored: ReadonlySet<string> = new Set(),
): NeedsYouItem[] {
  const { workflow, workers } = snapshot
  const items: NeedsYouItem[] = []
  for (const task of workflow.tasks) {
    const worker = workers[task.id]
    const live = worker ? statusOf(worker) : null
    if (task.state === 'running' && live === 'waiting') {
      items.push({ taskId: task.id, title: task.title, text: 'The worker is asking for permission or input.', canOpen: true, kind: 'worker' })
    } else if (task.state === 'waiting' && !workflow.judgments.some((j) => j.taskId === task.id)) {
      items.push({ taskId: task.id, title: task.title, text: task.note ?? 'The worker stopped without a result.', canOpen: worker !== undefined || restored.has(task.id), kind: 'worker' })
    }
  }
  for (const judgment of workflow.judgments) {
    const task = workflow.tasks.find((t) => t.id === judgment.taskId)
    items.push({
      taskId: judgment.taskId,
      title: task?.title ?? judgment.taskId,
      text: `${judgment.delivered ? 'The lead was asked' : 'Waiting to ask the lead'}: ${firstLine(judgment.question)}`,
      canOpen: workers[judgment.taskId] !== undefined || restored.has(judgment.taskId),
      kind: 'lead',
    })
  }
  return items
}

export function statusLine(snapshot: WorkflowSnapshot): string {
  const { workflow } = snapshot
  const { done, total } = workflowProgress(workflow)
  const patched = workflow.patches.length
  const parts: string[] = []
  switch (workflow.status) {
    case 'draft':
      parts.push(`Draft · ${total} task${total === 1 ? '' : 's'} · review the graph, then Start`)
      break
    case 'running':
      parts.push(snapshot.paused === 'window-closed' ? 'Paused: the lead\'s window is closed' : 'Running', `${done} of ${total} done`)
      break
    case 'done':
      parts.push('Done', `${done} of ${total} tasks`)
      break
    case 'failed':
      parts.push('Stuck: the lead or you must decide', `${done} of ${total} done`)
      break
    case 'cancelled':
      parts.push('Cancelled', `${done} of ${total} done`)
      break
  }
  if (patched > 0) parts.push(`patched ${patched === 1 ? 'once' : `${patched} times`} by the lead`)
  return parts.join(' · ')
}

/** The sidebar's line under a lead: "4/9 · 1 needs you". Null when it leads nothing live. */
export function leadProgress(workflows: readonly WorkflowSnapshot[], statusOf: (terminalId: string) => AgentStatus): { text: string; needsYou: number } | null {
  const live = workflows.filter((w) => w.workflow.status === 'running' || w.workflow.status === 'failed' || w.workflow.status === 'draft')
  if (live.length === 0) return null
  let done = 0
  let total = 0
  let needs = 0
  for (const snapshot of live) {
    const p = workflowProgress(snapshot.workflow)
    done += p.done
    total += p.total
    needs += needsYou(snapshot, statusOf).filter((i) => i.kind === 'worker').length
  }
  const drafts = live.every((w) => w.workflow.status === 'draft')
  return { text: drafts ? 'workflow draft' : `${done}/${total}`, needsYou: needs }
}

export function canStart(workflow: Pick<Workflow, 'status'>): boolean {
  return workflow.status === 'draft'
}

export function canCancel(workflow: Pick<Workflow, 'status'>): boolean {
  return workflow.status === 'running' || workflow.status === 'failed'
}

export function canDismiss(workflow: Pick<Workflow, 'status'>): boolean {
  return workflow.status !== 'running'
}
