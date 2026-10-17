/**
 * The phone's Workflow screen, as pure functions of a snapshot.
 *
 * Cards, Needs you and the status line are the desk's
 * (`renderer/lib/workflow-view.ts`), so the two can't drift. What is only the
 * phone's lives here: stages as sections, a map's children as rows, which
 * terminal a row opens, and the session object that terminal is shown with.
 *
 * Workers are never in `session:list` (owned sessions are filtered from every
 * listing), so the session a worker's screen shows is synthesized from the
 * workflow. That lets it ride the Sessions stack as an ordinary session entry,
 * under the same `bringToFront` / `leaveWindow` / one-PTY rules.
 */
import type { AgentStatus, WindowSession } from '../../shared/ipc-types'
import { childrenOf, isFinished, type WorkflowSnapshot, type WorkflowTask } from '../../shared/workflow'
import { defaultSlot, needsYou, taskCard, type TaskCard } from '../../renderer/lib/workflow-view'

export type StatusOf = (terminalId: string) => AgentStatus

export interface Stage {
  depth: number
  cards: TaskCard[]
}

/** The desk's columns, top to bottom: one section per dependency depth. */
export function stagesOf(cards: readonly TaskCard[]): Stage[] {
  const byDepth = new Map<number, TaskCard[]>()
  for (const card of cards) byDepth.set(card.depth, [...(byDepth.get(card.depth) ?? []), card])
  return [...byDepth.entries()].sort(([a], [b]) => a - b).map(([depth, members]) => ({ depth, cards: members }))
}

/** A map's children as cards of their own, in item order. */
export function childCards(snapshot: WorkflowSnapshot, mapId: string, statusOf: StatusOf): TaskCard[] {
  const { workflow, workers } = snapshot
  return childrenOf(workflow, mapId).map((child) => {
    const terminalId = workers[child.id]
    const onLead = workflow.judgments.some((j) => j.taskId === child.id)
    return taskCard(child, 0, terminalId ? statusOf(terminalId) : null, onLead)
  })
}

/** The live terminal behind a slot (`PopupSlot.key`: a task id, `<loop>~r` for its reviewer). */
export function slotTerminal(snapshot: WorkflowSnapshot, slot: string): string | null {
  if (slot.endsWith('~r')) return snapshot.reviewers[slot.slice(0, -2)] ?? null
  return snapshot.workers[slot] ?? null
}

/** The terminal a row opens: its worker, or its reviewer while the reviewer speaks. */
export function taskTerminal(snapshot: WorkflowSnapshot, taskId: string): string | null {
  return slotTerminal(snapshot, defaultSlot(snapshot.workflow, taskId))
}

function sessionFor(
  snapshot: WorkflowSnapshot,
  task: WorkflowTask,
  role: 'worker' | 'reviewer',
  terminalId: string,
  statusOf: StatusOf,
): WindowSession {
  const provider = (role === 'reviewer' ? task.reviewer?.provider : task.provider) ?? 'claude'
  const worktreePath = task.worktreePath ?? ''
  return {
    terminalId,
    label: `${task.title} · ${role === 'reviewer' ? 'Reviewer' : 'Worker'}`,
    kind: 'agent',
    provider,
    worktreePath,
    status: statusOf(terminalId),
    statusSince: 0,
    trail: worktreePath ? [{ repoPath: snapshot.workflow.project, worktrees: [worktreePath] }] : [],
    owner: {
      kind: 'workflow',
      workflowId: snapshot.workflow.id,
      taskId: task.id,
      attempt: task.attempt,
      ...(role === 'reviewer' && task.reviewers !== undefined ? { review: task.reviewers } : {}),
    },
  }
}

/** Every live worker and reviewer terminal of these workflows, as the session its screen shows. */
export function workerSessions(snapshots: readonly WorkflowSnapshot[], statusOf: StatusOf): Record<string, WindowSession> {
  const out: Record<string, WindowSession> = {}
  for (const snapshot of snapshots) {
    for (const task of snapshot.workflow.tasks) {
      const worker = snapshot.workers[task.id]
      if (worker) out[worker] = sessionFor(snapshot, task, 'worker', worker, statusOf)
      const reviewer = snapshot.reviewers[task.id]
      if (reviewer) out[reviewer] = sessionFor(snapshot, task, 'reviewer', reviewer, statusOf)
    }
  }
  return out
}

/** The workflows a live terminal leads, oldest first. */
export function ledBy(snapshots: readonly WorkflowSnapshot[], terminalId: string): WorkflowSnapshot[] {
  return snapshots.filter((s) => s.leadTerminalId === terminalId)
}

/**
 * The one of a lead's workflows to open: an unfinished one with something
 * waiting on the user, else the newest unfinished one, else the newest.
 */
export function pickForLead(snapshots: readonly WorkflowSnapshot[], statusOf: StatusOf): WorkflowSnapshot | undefined {
  const newestFirst = [...snapshots].sort((a, b) => b.workflow.createdAt.localeCompare(a.workflow.createdAt))
  const live = newestFirst.filter((s) => !isFinished(s.workflow.status))
  return live.find((s) => needsYou(s, statusOf).some((i) => i.kind === 'worker')) ?? live[0] ?? newestFirst[0]
}

/**
 * Why this phone can't open the workflow's terminals, or null. A phone's
 * socket joins one window, and workers are PTYs of the lead's window.
 */
export function windowBlocker(
  snapshot: Pick<WorkflowSnapshot, 'leadWindowId'>,
  attachedWindow: number | null,
  names: { lead?: string; here?: string } = {},
): string | null {
  if (snapshot.leadWindowId === null || snapshot.leadWindowId === undefined) {
    return 'The lead’s window isn’t open on the Mac, so its workers’ terminals can’t be opened.'
  }
  if (snapshot.leadWindowId !== attachedWindow) {
    return `This workflow runs in ${names.lead ?? 'another SimpleEdit window'}, and this phone is showing ${names.here ?? 'a different one'}. Switch project to open its terminals.`
  }
  return null
}
