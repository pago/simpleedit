import type { AgentStatus } from '../../shared/ipc-types'
import {
  WORKFLOW_LOOP_ROUNDS_DEFAULT,
  childrenOf,
  currentRound,
  isChild,
  loopPhase,
  overSource,
  taskDepths,
  waitingSlot,
  workflowProgress,
  type LoopPhase,
  type Workflow,
  type WorkflowLoopRound,
  type WorkflowSnapshot,
  type WorkflowTask,
  type WorkflowTaskKind,
} from '../../shared/workflow'

export type CardTone = 'done' | 'running' | 'waiting' | 'queued' | 'failed' | 'cancelled'

export interface TaskCard {
  id: string
  title: string
  kind: WorkflowTaskKind
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
  /** loop, once its first round began. */
  round?: { current: number; max: number; phase: LoopPhase }
  /** map, once expanded. */
  stack?: { total: number; done: number; running: number; waiting: number; failed: number; cancelled: number }
  /** The number of the patch selected in the history, when it changed this card. */
  highlight: number | null
}

/** One session the popup can show: a worker, a loop's reviewer, or a map child's worker. */
export interface PopupSlot {
  /** The task id, `<loop>~r` for a reviewer. */
  key: string
  label: string
  role: 'worker' | 'reviewer'
  /** The loop, or the child. */
  task: WorkflowTask
  /** The reviewer's round. */
  round?: WorkflowLoopRound
  /** Agent and model of this session. */
  agent: string
  tone: CardTone
  status: string
  terminalId: string | null
  placeholderId: string | null
}

export interface NeedsYouItem {
  taskId: string
  title: string
  text: string
  /** Opening the worker's terminal is the way to answer. */
  canOpen: boolean
  kind: 'worker' | 'lead'
  /** The popup slot it opens on. */
  slot: string
}

export function reviewerSlotKey(taskId: string): string {
  return `${taskId}~r`
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

function agentLabel(task: { provider?: WorkflowTask['provider']; model?: string }): string {
  const provider = task.provider === 'codex' ? 'Codex' : 'Claude'
  return task.model ? `${provider} · ${task.model}` : provider
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** What the card shows, from the stored task plus the worker's live status. */
export function taskCard(task: WorkflowTask, depth: number, workerStatus: AgentStatus | null, waitingOnLead = false): TaskCard {
  const base = {
    id: task.id,
    title: task.title,
    kind: task.kind,
    agent: agentLabel(task),
    depth,
    added: task.addedBy !== undefined,
    hasWorker: workerStatus !== null,
    highlight: null,
  }
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

/**
 * A loop's card: the plain card, read through its round. `reviewerStatus` is
 * the live status of the current reviewer, which speaks while it reviews.
 */
export function loopCard(task: WorkflowTask, depth: number, workerStatus: AgentStatus | null, reviewerStatus: AgentStatus | null, waitingOnLead = false): TaskCard {
  const phase = loopPhase(task)
  const round = currentRound(task)
  const reviewing = phase === 'reviewing'
  const card = taskCard(task, depth, reviewing ? reviewerStatus : workerStatus, waitingOnLead)
  if (!phase || !round) return card
  const max = task.maxRounds ?? WORKFLOW_LOOP_ROUNDS_DEFAULT
  const of = `Round ${round.round} of ${max}`
  const withRound = { ...card, round: { current: round.round, max, phase } }
  switch (task.state) {
    case 'running':
      if (card.tone === 'waiting') return { ...withRound, detail: reviewing ? 'The reviewer is asking something' : card.detail }
      if (card.tone === 'failed') return { ...withRound, status: reviewing ? '✕ Reviewer stopped' : card.status }
      return reviewing
        ? { ...withRound, status: `◇ ${of} · in review`, detail: round.review === 'queued' ? 'Waiting for a reviewer slot' : (task.worktree?.branch ?? '') }
        : { ...withRound, status: `▶ ${of} · working`, detail: round.round > 1 ? `Fixing round ${round.round - 1} findings` : card.detail }
    case 'waiting':
      return phase === 'not-converged' ? { ...withRound, status: "◆ Didn't converge · needs the lead" } : withRound
    case 'done':
      return task.result?.verdict === 'findings'
        ? { ...withRound, status: `✓ Accepted · ${plural(task.result.findings?.length ?? 0, 'open finding')}` }
        : { ...withRound, status: `✓ Clean after ${plural(task.result?.rounds ?? round.round, 'round')}` }
    case 'failed':
      return phase === 'reviewer-failed' ? { ...withRound, status: '✕ Reviewer failed' } : withRound
    default:
      return withRound
  }
}

export function progressText(stack: NonNullable<TaskCard['stack']>): string {
  return `${stack.done} of ${stack.total - stack.cancelled} done`
}

const URGENCY: CardTone[] = ['waiting', 'failed', 'running', 'queued', 'done', 'cancelled']

/** A map's card: a plain card until it expands, then a stack of its children's cards. */
export function mapCard(task: WorkflowTask, depth: number, children: readonly TaskCard[], waitingOnLead = false): TaskCard {
  const card = taskCard(task, depth, null, waitingOnLead)
  const source = task.over ? overSource(task.over) : undefined
  if (children.length === 0) {
    return task.state === 'queued' && source && !task.note ? { ...card, detail: `fans out over ${source} items` } : card
  }
  const count = (tone: CardTone): number => children.filter((c) => c.tone === tone).length
  const stack = {
    total: children.length,
    done: count('done'),
    running: count('running'),
    waiting: count('waiting'),
    failed: count('failed'),
    cancelled: count('cancelled'),
  }
  const parts = [`▤ ${progressText(stack)}`]
  if (stack.failed > 0) parts.push(`${stack.failed} failed`)
  if (stack.waiting > 0) parts.push(`${stack.waiting} waiting`)
  const status = parts.join(' · ')
  if (task.state === 'done' || task.state === 'cancelled') return { ...card, stack, status: task.state === 'done' ? status.replace('▤', '✓') : card.status }
  const tone = URGENCY.find((t) => children.some((c) => c.tone === t)) ?? card.tone
  const queued = children.filter((c) => c.tone === 'queued').length
  return { ...card, stack, tone, status, detail: [stack.running > 0 ? `${stack.running} running` : '', queued > 0 ? `${queued} queued` : ''].filter(Boolean).join(' · ') }
}

/**
 * The reviewer serving the current round. `reviewers` lists the latest one,
 * which while a round waits for its reviewer is the previous round's.
 */
function roundReviewer(task: WorkflowTask, reviewers: WorkflowSnapshot['reviewers']): string | undefined {
  const round = currentRound(task)
  const serving = round?.reviewer !== undefined && round.reviewer === task.reviewers && (round.review === 'running' || round.review === 'waiting')
  return serving ? reviewers[task.id] : undefined
}

function cardFor(snapshot: WorkflowSnapshot, task: WorkflowTask, depth: number, statusOf: (terminalId: string) => AgentStatus): TaskCard {
  const { workflow, workers, reviewers } = snapshot
  const onLead = workflow.judgments.some((j) => j.taskId === task.id)
  const live = (terminalId: string | undefined): AgentStatus | null => (terminalId ? statusOf(terminalId) : null)
  if (task.kind === 'loop') return loopCard(task, depth, live(workers[task.id]), live(roundReviewer(task, reviewers)), onLead)
  if (task.kind === 'map') {
    return mapCard(task, depth, childrenOf(workflow, task.id).map((c) => cardFor(snapshot, c, depth, statusOf)), onLead)
  }
  return taskCard(task, depth, live(workers[task.id]), onLead)
}

/** The graph's cards: top-level tasks only, a map's children folded into its card. */
export function taskCards(
  snapshot: WorkflowSnapshot,
  statusOf: (terminalId: string) => AgentStatus,
  highlighted?: { patch: number; taskIds: ReadonlySet<string> },
): TaskCard[] {
  const { workflow } = snapshot
  const top = workflow.tasks.filter((t) => !isChild(t))
  const depths = taskDepths(top)
  return top.map((task) => {
    const card = cardFor(snapshot, task, depths.get(task.id) ?? 0, statusOf)
    const ids = highlighted?.taskIds
    const touched = ids !== undefined && (ids.has(task.id) || (task.kind === 'map' && childrenOf(workflow, task.id).some((c) => ids.has(c.id))))
    return touched && highlighted ? { ...card, highlight: highlighted.patch } : card
  })
}

/** A loop whose reviewer is the one at work, asking, or failed: its worker only waits. */
function reviewerSpeaks(task: WorkflowTask): boolean {
  if (task.kind !== 'loop') return false
  const phase = loopPhase(task)
  if (phase === 'reviewer-failed') return task.state === 'failed'
  return phase === 'reviewing' && (task.state === 'running' || task.state === 'waiting')
}

/** The slot to show for a task: its current reviewer's while that reviewer speaks. */
function slotFor(task: WorkflowTask): string {
  return reviewerSpeaks(task) && currentRound(task)?.reviewer !== undefined ? reviewerSlotKey(task.id) : task.id
}

/** The popup slot a card opens on. */
export function defaultSlot(workflow: Pick<Workflow, 'tasks'>, taskId: string): string {
  const task = workflow.tasks.find((t) => t.id === taskId)
  return task ? slotFor(task) : taskId
}

function reviewerState(round: WorkflowLoopRound, live: AgentStatus | null): { tone: CardTone; status: string } {
  switch (round.review) {
    case 'running':
      if (live === 'waiting') return { tone: 'waiting', status: '● Waiting on you' }
      if (live === 'error' || live === 'exited') return { tone: 'failed', status: '✕ Reviewer stopped' }
      return { tone: 'running', status: '▶ Reviewing' }
    case 'waiting':
      return { tone: 'waiting', status: '● Waiting on you' }
    case 'done':
      return round.verdict === 'clean'
        ? { tone: 'done', status: '✓ Clean' }
        : { tone: 'done', status: `◇ ${plural(round.findings?.length ?? 0, 'finding')}` }
    case 'failed':
      return { tone: 'failed', status: '✕ Failed' }
    default:
      return { tone: 'queued', status: '○ Queued' }
  }
}

/**
 * The sessions a card's popup switches between. `placeholders` maps a slot
 * key to its restored session that hasn't been resumed yet.
 */
export function popupSlots(
  snapshot: WorkflowSnapshot,
  taskId: string,
  statusOf: (terminalId: string) => AgentStatus,
  placeholders: ReadonlyMap<string, string> = new Map(),
): PopupSlot[] {
  const { workflow, workers, reviewers } = snapshot
  const task = workflow.tasks.find((t) => t.id === taskId)
  if (!task) return []
  const workerSlot = (t: WorkflowTask, label: string, card: TaskCard): PopupSlot => ({
    key: t.id,
    label,
    role: 'worker',
    task: t,
    agent: card.agent,
    tone: card.tone,
    status: card.status,
    terminalId: workers[t.id] ?? null,
    placeholderId: placeholders.get(t.id) ?? null,
  })
  if (task.kind === 'map') {
    return childrenOf(workflow, task.id).map((child) =>
      workerSlot(child, `${child.index ?? ''} · ${child.title}`, cardFor(snapshot, child, 0, statusOf)),
    )
  }
  const card = cardFor(snapshot, task, 0, statusOf)
  if (task.kind !== 'loop') return [workerSlot(task, 'Worker', card)]
  const worker = workerSlot(task, 'Worker', card)
  const slots = [
    reviewerSpeaks(task)
      ? { ...worker, tone: 'queued' as const, status: loopPhase(task) === 'reviewer-failed' ? '◇ Its reviewer failed' : '◇ Waiting for the review' }
      : worker,
  ]
  const round = task.rounds?.find((r) => r.reviewer !== undefined && r.reviewer === task.reviewers)
  if (round) {
    const terminalId = reviewers[task.id] ?? null
    slots.push({
      key: reviewerSlotKey(task.id),
      label: `Reviewer · round ${round.round}`,
      role: 'reviewer',
      task,
      round,
      agent: agentLabel(task.reviewer ?? {}),
      ...reviewerState(round, terminalId ? statusOf(terminalId) : null),
      terminalId,
      placeholderId: placeholders.get(reviewerSlotKey(task.id)) ?? null,
    })
  }
  return slots
}

/**
 * Everything that waits on the user or the lead, most urgent first.
 * `restored` names the slots (`PopupSlot.key`) whose session is a restored
 * placeholder: main lists no terminal for it, but the popup can resume it.
 */
export function needsYou(
  snapshot: WorkflowSnapshot,
  statusOf: (terminalId: string) => AgentStatus,
  restored: ReadonlySet<string> = new Set(),
): NeedsYouItem[] {
  const { workflow, workers, reviewers } = snapshot
  const items: NeedsYouItem[] = []
  const titleOf = (task: WorkflowTask): string => {
    const map = task.parent !== undefined ? workflow.tasks.find((t) => t.id === task.parent) : undefined
    return map ? `${map.title} · ${task.title}` : task.title
  }
  const canOpen = (slot: string, terminalId: string | undefined): boolean => terminalId !== undefined || restored.has(slot)
  for (const task of workflow.tasks) {
    const onReviewer = task.kind === 'loop' && (task.state === 'running' ? loopPhase(task) === 'reviewing' : waitingSlot(task) === 'reviewer')
    const slot = onReviewer ? reviewerSlotKey(task.id) : task.id
    const terminalId = onReviewer ? roundReviewer(task, reviewers) : workers[task.id]
    const live = terminalId ? statusOf(terminalId) : null
    const who = onReviewer ? 'reviewer' : 'worker'
    if (task.state === 'running' && live === 'waiting') {
      items.push({ taskId: task.id, title: titleOf(task), text: `The ${who} is asking for permission or input.`, canOpen: true, kind: 'worker', slot })
    } else if (task.state === 'waiting' && !workflow.judgments.some((j) => j.taskId === task.id)) {
      const text = onReviewer ? 'The reviewer stopped without a verdict.' : (task.note ?? 'The worker stopped without a result.')
      items.push({ taskId: task.id, title: titleOf(task), text, canOpen: canOpen(slot, terminalId), kind: 'worker', slot })
    }
  }
  for (const judgment of workflow.judgments) {
    const task = workflow.tasks.find((t) => t.id === judgment.taskId)
    const slot = task ? slotFor(task) : judgment.taskId
    const onReviewer = slot !== judgment.taskId
    items.push({
      taskId: judgment.taskId,
      title: task ? titleOf(task) : judgment.taskId,
      text: `${judgment.delivered ? 'The lead was asked' : 'Waiting to ask the lead'}: ${firstLine(judgment.question)}`,
      canOpen: canOpen(slot, onReviewer ? reviewers[judgment.taskId] : workers[judgment.taskId]),
      kind: 'lead',
      slot,
    })
  }
  return items
}

/** The card a popup opens from: a child's slot lives on its map's card. */
export function cardIdOf(workflow: Pick<Workflow, 'tasks'>, slot: string): string {
  const taskId = slot.endsWith('~r') ? slot.slice(0, -2) : slot
  return workflow.tasks.find((t) => t.id === taskId)?.parent ?? taskId
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
