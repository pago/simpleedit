import type { PlanStatus, PlanTask, PlanReaction, PlanDiscussionMessage, Plan } from '../../shared/ipc-types'

export interface PlanState {
  status: PlanStatus
  overview: string
  tasks: PlanTask[]
  error?: string
}

export function planKey(worktreePath: string, commitHash: string | null): string {
  return `${worktreePath}:${commitHash ?? 'staging'}`
}

let _plans = $state<Map<string, PlanState>>(new Map())

function update(key: string, updater: (existing: PlanState) => PlanState): void {
  const existing = _plans.get(key)
  if (!existing) return
  const next = new Map(_plans)
  next.set(key, updater(existing))
  _plans = next
}

export const planStore = {
  get(key: string): PlanState | undefined {
    return _plans.get(key)
  },

  setStatus(key: string, status: PlanStatus, error?: string): void {
    const existing = _plans.get(key)
    const next = new Map(_plans)
    next.set(key, {
      status,
      overview: existing?.overview ?? '',
      tasks: existing?.tasks ?? [],
      error,
    })
    _plans = next
  },

  /** Clear tasks and overview so a fresh generation replaces them cleanly. */
  resetForGeneration(key: string, status: PlanStatus): void {
    const next = new Map(_plans)
    next.set(key, { status, overview: '', tasks: [] })
    _plans = next
  },

  setOverview(key: string, overview: string): void {
    update(key, (s) => ({ ...s, overview }))
  },

  addTask(key: string, task: PlanTask): void {
    update(key, (s) => ({ ...s, tasks: [...s.tasks, task] }))
  },

  updateTaskStatus(key: string, taskId: string, status: PlanTask['status']): void {
    update(key, (s) => ({
      ...s,
      tasks: s.tasks.map((t) => t.id === taskId ? { ...t, status } : t),
    }))
  },

  addReaction(key: string, taskId: string, reaction: PlanReaction): void {
    update(key, (s) => ({
      ...s,
      tasks: s.tasks.map((t) => {
        if (t.id !== taskId) return t
        if (t.reactions.includes(reaction)) return t
        return { ...t, reactions: [...t.reactions, reaction] }
      }),
    }))
  },

  removeReaction(key: string, taskId: string, reaction: PlanReaction): void {
    update(key, (s) => ({
      ...s,
      tasks: s.tasks.map((t) => {
        if (t.id !== taskId) return t
        return { ...t, reactions: t.reactions.filter((r) => r !== reaction) }
      }),
    }))
  },

  addDiscussionMessage(key: string, taskId: string, message: PlanDiscussionMessage): void {
    update(key, (s) => ({
      ...s,
      tasks: s.tasks.map((t) => {
        if (t.id !== taskId) return t
        return { ...t, discussion: [...t.discussion, message] }
      }),
    }))
  },

  loadFromCache(key: string, plan: Plan): void {
    const next = new Map(_plans)
    next.set(key, {
      status: 'done' as PlanStatus,
      overview: plan.overview,
      tasks: plan.tasks,
    })
    _plans = next
  },

  toPlan(key: string): Plan | null {
    const state = _plans.get(key)
    if (!state) return null
    return { overview: state.overview, tasks: state.tasks }
  },

  clear(key: string): void {
    const next = new Map(_plans)
    next.delete(key)
    _plans = next
  },
}

export async function triggerPlan(
  worktreePath: string,
  commitHash: string | null
): Promise<void> {
  const key = planKey(worktreePath, commitHash)
  planStore.resetForGeneration(key, 'running')
  await window.api.invoke('plan:start', worktreePath, commitHash)
}

export async function triggerPlanFromDescription(
  worktreePath: string,
  description: string
): Promise<void> {
  const key = planKey(worktreePath, 'user-plan')
  planStore.resetForGeneration(key, 'running')
  await window.api.invoke('plan:start-from-description', worktreePath, description)
}

export async function revisePlan(
  worktreePath: string,
  commitHash: string | null,
  feedback: string
): Promise<void> {
  const key = planKey(worktreePath, commitHash)
  // Save current state before revising so main process can read it
  const plan = planStore.toPlan(key)
  if (plan) {
    await window.api.invoke('plan:save', worktreePath, commitHash, plan)
  }
  planStore.resetForGeneration(key, 'revising')
  await window.api.invoke('plan:revise', worktreePath, commitHash, feedback)
}

export async function loadCachedPlan(
  worktreePath: string,
  commitHash: string | null
): Promise<boolean> {
  const key = planKey(worktreePath, commitHash)
  const cached = await window.api.invoke('plan:load', worktreePath, commitHash)
  if (cached) {
    planStore.loadFromCache(key, cached)
    return true
  }
  return false
}
