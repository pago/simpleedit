import type { PlanStatus, PlanTask, PlanReaction, PlanDiscussionMessage, Plan } from '../../shared/ipc-types'

export interface PlanState {
  status: PlanStatus
  overview: string
  tasks: PlanTask[]
  error?: string
  /** When set, this plan originated from a Claude session and feedback should route back to it. */
  sourceTerminalId: string | null
}

export function planKey(worktreePath: string, commitHash: string | null): string {
  return `${worktreePath}:${commitHash ?? 'staging'}`
}

let _plans = $state<Map<string, PlanState>>(new Map())
/** Tracks the most recent Claude plan terminal ID per worktree path. */
let _latestClaudePlan = $state<Map<string, string>>(new Map())

function update(key: string, updater: (existing: PlanState) => PlanState): void {
  const existing = _plans.get(key)
  if (!existing) return
  const next = new Map(_plans)
  next.set(key, updater(existing))
  _plans = next
}

const REACTION_EMOJI: Record<string, string> = {
  'thumbs-up': '\u{1F44D}',
  'thumbs-down': '\u{1F44E}',
  'question': '\u{2753}',
  'rocket': '\u{1F680}',
  'eyes': '\u{1F440}',
}

function formatTaskFeedback(state: PlanState): string {
  const parts: string[] = []
  for (const task of state.tasks) {
    const reactions = task.reactions.map((r) => REACTION_EMOJI[r] ?? r).join(' ')
    const msgs = task.discussion
      .filter((m) => m.role === 'user')
      .map((m) => `  Comment: ${m.text}`)
      .join('\n')
    const hasInfo = reactions || msgs || task.status === 'rejected'
    if (hasInfo) {
      parts.push(`- "${task.title}" [${task.status}]${reactions ? ` ${reactions}` : ''}`)
      if (msgs) parts.push(msgs)
    }
  }
  return parts.join('\n')
}

export const planStore = {
  get(key: string): PlanState | undefined {
    return _plans.get(key)
  },

  /** Returns the terminal ID of the most recent Claude-originated plan for this worktree, or null. */
  getLatestClaudePlanTerminalId(worktreePath: string): string | null {
    return _latestClaudePlan.get(worktreePath) ?? null
  },

  /** Load the latest Claude plan pointer from disk (for after app restart). */
  async loadLatestClaudePlanTerminalId(worktreePath: string): Promise<string | null> {
    // Check in-memory first
    const cached = _latestClaudePlan.get(worktreePath)
    if (cached) return cached
    // Load from disk via main process
    const terminalId = await window.api.invoke('plan:latest-claude', worktreePath)
    if (terminalId) {
      _latestClaudePlan = new Map(_latestClaudePlan)
      _latestClaudePlan.set(worktreePath, terminalId)
    }
    return terminalId
  },

  setStatus(key: string, status: PlanStatus, error?: string): void {
    const existing = _plans.get(key)
    const next = new Map(_plans)
    next.set(key, {
      status,
      overview: existing?.overview ?? '',
      tasks: existing?.tasks ?? [],
      error,
      sourceTerminalId: existing?.sourceTerminalId ?? null,
    })
    _plans = next
  },

  /** Clear tasks and overview so a fresh generation replaces them cleanly. */
  resetForGeneration(key: string, status: PlanStatus): void {
    const next = new Map(_plans)
    next.set(key, { status, overview: '', tasks: [], sourceTerminalId: null })
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

  loadFromCache(key: string, plan: Plan, sourceTerminalId?: string | null): void {
    const next = new Map(_plans)
    next.set(key, {
      status: 'done' as PlanStatus,
      overview: plan.overview,
      tasks: plan.tasks,
      sourceTerminalId: sourceTerminalId ?? null,
    })
    _plans = next
  },

  toPlan(key: string): Plan | null {
    const state = _plans.get(key)
    if (!state) return null
    return { overview: state.overview, tasks: state.tasks }
  },

  /** Receive a plan from a Claude session (via MCP bridge). Merges with existing state if present. */
  receivePlanFromClaude(key: string, terminalId: string, plan: Plan): void {
    const existing = _plans.get(key)
    const next = new Map(_plans)

    // Normalize incoming tasks — MCP Zod schema strips id/reactions/discussion
    let taskCounter = 0
    function normalizeTask(t: Partial<PlanTask> & { title: string; description: string }): PlanTask {
      return {
        id: t.id ?? `${key}:claude-${taskCounter++}`,
        title: t.title,
        description: t.description,
        affectedFiles: t.affectedFiles,
        status: t.status ?? 'todo',
        reactions: t.reactions ?? [],
        discussion: t.discussion ?? [],
      }
    }

    // If a plan already exists for this key, merge: preserve user reactions/discussion where tasks match by title
    let mergedTasks: PlanTask[]
    if (existing && existing.tasks.length > 0) {
      const existingByTitle = new Map(existing.tasks.map((t) => [t.title, t]))
      mergedTasks = plan.tasks.map((incoming) => {
        const normalized = normalizeTask(incoming)
        const prev = existingByTitle.get(incoming.title)
        if (prev) {
          return {
            ...normalized,
            id: prev.id,
            reactions: prev.reactions,
            discussion: prev.discussion,
            status: prev.status,
          }
        }
        return normalized
      })
    } else {
      mergedTasks = plan.tasks.map((t) => normalizeTask(t))
    }

    next.set(key, {
      status: 'done',
      overview: plan.overview,
      tasks: mergedTasks,
      sourceTerminalId: terminalId,
    })
    _plans = next

    // Track this as the latest Claude plan for the worktree
    // Key format: `${worktreePath}:claude-${terminalId}`
    const colonIdx = key.indexOf(':claude-')
    if (colonIdx !== -1) {
      const worktreePath = key.slice(0, colonIdx)
      _latestClaudePlan = new Map(_latestClaudePlan)
      _latestClaudePlan.set(worktreePath, terminalId)
    }
  },

  /** Send structured feedback to the originating Claude session. */
  sendFeedbackToSession(key: string, message: string): void {
    const state = _plans.get(key)
    if (!state?.sourceTerminalId) return

    const parts: string[] = []
    parts.push(message)

    // Append per-task feedback summary
    const taskSummary = formatTaskFeedback(state)
    if (taskSummary) {
      parts.push('\n--- Task feedback ---')
      parts.push(taskSummary)
    }

    const formatted = parts.join('\n')
    window.api.invoke('pty:write', state.sourceTerminalId, formatted + '\r')
  },

  clear(key: string): void {
    const next = new Map(_plans)
    next.delete(key)
    _plans = next
  },
}

/** Subscribe to plan:from-claude IPC events. Call once during app init. */
export function initPlanFromClaudeListener(): () => void {
  return window.api.on('plan:from-claude', (data) => {
    planStore.receivePlanFromClaude(data.key, data.terminalId, data.plan)
  })
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
    // Detect Claude plans by commitHash prefix and restore sourceTerminalId
    const terminalId = commitHash?.startsWith('claude-') ? commitHash.slice('claude-'.length) : null
    planStore.loadFromCache(key, cached, terminalId)
    return true
  }
  return false
}
