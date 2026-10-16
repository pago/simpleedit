/**
 * Mirror of the project's workflows (main owns them, `workflow-store.ts`),
 * plus what only this window can do for them: tell main which leads it holds,
 * resume restored workers, open a new workflow's tab, and detach or close a
 * worker when main asks.
 */
import { isFinished, type WorkflowSnapshot, type WorkflowTask, type Workflow } from '../../shared/workflow'
import type { AgentStatus } from '../../shared/ipc-types'
import { isOwned, workflowOwner } from '../../shared/session-owner'
import { sessionsStore, type Session } from './sessions.svelte'
import { tabsStore, tabIdFor, type WorkflowTab } from './tabsStore.svelte'
import { needsYou } from '../lib/workflow-view'

let _project = $state<string | null>(null)
let _workflows = $state<WorkflowSnapshot[]>([])
let _loaded = $state(false)
/** Ids this window has seen, so a new one opens its tab exactly once. */
const known = new Set<string>()
const resumed = new Set<string>()
/** The session that last led each workflow here, to tell a hand-off from a key upgrade. */
const leadIds = new Map<string, string>()
let sentHosts = ''

/** The identity main keys a lead by: its provider session id survives a restart, its terminal id doesn't. */
export function sessionKey(session: Pick<Session, 'id' | 'providerSessionId' | 'pendingResume'>): string {
  return session.providerSessionId ?? session.pendingResume?.sessionId ?? session.id
}

function receive(snapshot: WorkflowSnapshot): void {
  if (_project !== null && snapshot.workflow.project !== _project) return
  if (snapshot.dismissed) {
    _workflows = _workflows.filter((w) => w.workflow.id !== snapshot.workflow.id)
    leadIds.delete(snapshot.workflow.id)
    // Main closes the live workers it knows of; restored and exited ones are only known here.
    for (const session of sessionsStore.sessions()) {
      if (workflowOwner(session)?.workflowId === snapshot.workflow.id) sessionsStore.close(session.id)
    }
    return
  }
  const index = _workflows.findIndex((w) => w.workflow.id === snapshot.workflow.id)
  if (index === -1) {
    _workflows = [..._workflows, snapshot]
    if (!known.has(snapshot.workflow.id)) {
      known.add(snapshot.workflow.id)
      if (_loaded) openForLead(snapshot.workflow)
    }
  } else {
    _workflows = _workflows.map((w, i) => (i === index ? snapshot : w))
  }
  // A hand-off moves the workflow to a successor session, which has none of its predecessor's tabs.
  const lead = leadSession(snapshot.workflow)
  const previous = leadIds.get(snapshot.workflow.id)
  if (lead) leadIds.set(snapshot.workflow.id, lead.id)
  if (index !== -1 && _loaded && lead && previous !== undefined && lead.id !== previous && !isFinished(snapshot.workflow.status)) {
    openForLead(snapshot.workflow)
  }
}

function leadSession(workflow: Pick<Workflow, 'leadKey'>): Session | undefined {
  return sessionsStore.sessions().find((s) => !isOwned(s) && sessionKey(s) === workflow.leadKey)
}

export function openWorkflowTab(sessionId: string, workflow: Pick<Workflow, 'id' | 'title'>, focus: 'active' | 'background' = 'active'): void {
  const tab: WorkflowTab = {
    kind: 'workflow',
    id: tabIdFor({ kind: 'workflow', workflowId: workflow.id }),
    title: workflow.title,
    workflowId: workflow.id,
  }
  tabsStore.open(sessionId, tab, { focus })
}

function openForLead(workflow: Workflow): void {
  const lead = leadSession(workflow)
  if (lead) openWorkflowTab(lead.id, workflow, tabsStore.activeId(lead.id) === null ? 'active' : 'background')
}

export const workflowsStore = {
  all(): WorkflowSnapshot[] {
    return _workflows
  },
  /** The project's list has arrived: a workflow missing now is really gone. */
  loaded(): boolean {
    return _loaded
  },
  get(id: string): WorkflowSnapshot | undefined {
    return _workflows.find((w) => w.workflow.id === id)
  },
  /** The workflows a session leads, oldest first. */
  forLead(session: Session): WorkflowSnapshot[] {
    if (isOwned(session)) return []
    const key = sessionKey(session)
    return _workflows.filter((w) => w.workflow.leadKey === key)
  },
  /**
   * Bring back a lead's Workflow tab, which the user may have closed: the
   * live workflow with something waiting on the user, else the newest live one.
   */
  showFor(session: Session, statusOf: (terminalId: string) => AgentStatus): void {
    const live = this.forLead(session).filter((w) => w.workflow.status !== 'done' && w.workflow.status !== 'cancelled')
    const pick = live.find((w) => needsYou(w, statusOf).some((i) => i.kind === 'worker')) ?? live.at(-1)
    if (pick) openWorkflowTab(session.id, pick.workflow)
  },
  /** The task a worker session works on, if it is that task's current worker. */
  taskOf(session: Pick<Session, 'owner'>): WorkflowTask | undefined {
    const owner = workflowOwner(session)
    if (!owner) return undefined
    const task = this.get(owner.workflowId)?.workflow.tasks.find((t) => t.id === owner.taskId)
    return task && task.attempt === owner.attempt ? task : undefined
  },
  /**
   * The worker's task is `waiting` on the user: its turn ended without a
   * result. A task waiting on the lead's answer is the lead's to handle.
   */
  waitsOnUser(session: Pick<Session, 'owner'>): boolean {
    const owner = workflowOwner(session)
    const task = this.taskOf(session)
    if (!owner || task?.state !== 'waiting') return false
    return !this.get(owner.workflowId)?.workflow.judgments.some((j) => j.taskId === task.id)
  },
  /**
   * The current workers of unfinished tasks in every workflow this session
   * leads. A finished task's worker or a replaced attempt's stays open until
   * Dismiss but has nothing left to ask.
   */
  workersOf(session: Session): Session[] {
    const ids = new Set(this.forLead(session).map((w) => w.workflow.id))
    if (ids.size === 0) return []
    return sessionsStore.sessions().filter((s) => {
      const owner = workflowOwner(s)
      if (!owner || !ids.has(owner.workflowId)) return false
      const state = this.taskOf(s)?.state
      return state === 'running' || state === 'waiting'
    })
  },
  async load(): Promise<void> {
    try {
      const list = await window.api.invoke('workflow:list')
      _project = list.project
      _workflows = list.workflows
      for (const w of list.workflows) known.add(w.workflow.id)
      _loaded = true
    } catch (err) {
      console.warn('[workflows] loading workflows failed:', err)
    }
  },
  start(id: string): Promise<WorkflowSnapshot> {
    return window.api.invoke('workflow:start', id)
  },
  cancel(id: string): Promise<WorkflowSnapshot> {
    return window.api.invoke('workflow:cancel', id)
  },
  dismiss(id: string): Promise<void> {
    return window.api.invoke('workflow:dismiss', id)
  },
}

/**
 * Restored workers: a running task's comes back on its own; a cancelled
 * task's leaves the workflow, as it would have live; one whose workflow was
 * dismissed meanwhile is closed. The rest wait for a click.
 */
function settleRestoredWorkers(): void {
  for (const session of sessionsStore.sessions()) {
    if (!session.pendingResume || resumed.has(session.id)) continue
    const owner = workflowOwner(session)
    if (!owner) continue
    const snapshot = workflowsStore.get(owner.workflowId)
    if (!snapshot) {
      sessionsStore.close(session.id)
      continue
    }
    const task = workflowsStore.taskOf(session)
    if (task?.state === 'cancelled' && task.detached) {
      sessionsStore.update(session.id, { owner: undefined })
      continue
    }
    if (snapshot?.workflow.status !== 'running' || !task || (task.state !== 'running' && task.state !== 'waiting')) continue
    resumed.add(session.id)
    sessionsStore.resumePlaceholder(session.id)
  }
}

/** Subscribe to main's workflow events. Call once at app start (desktop); returns an unsub. */
export function initWorkflowListeners(): () => void {
  const offChanged = window.api.on('workflow:changed', receive)
  const offWorker = window.api.on('workflow:worker', ({ terminalId, action }) => {
    if (!sessionsStore.get(terminalId)) return
    if (action === 'dispose') sessionsStore.close(terminalId)
    else sessionsStore.update(terminalId, { owner: undefined })
  })
  const stop = $effect.root(() => {
    $effect(() => {
      if (!sessionsStore.hydrated()) return
      const keys = sessionsStore
        .sessions()
        .filter((s) => !isOwned(s) && s.kind === 'agent')
        .map(sessionKey)
      const joined = keys.join('\n')
      if (joined === sentHosts) return
      sentHosts = joined
      void window.api.invoke('workflow:hosts', keys)
    })
    $effect(() => {
      if (!sessionsStore.hydrated() || !_loaded) return
      settleRestoredWorkers()
    })
  })
  return () => {
    offChanged()
    offWorker()
    stop()
  }
}

export function _resetWorkflowsForTests(): void {
  _project = null
  _workflows = []
  _loaded = false
  known.clear()
  resumed.clear()
  leadIds.clear()
  sentHosts = ''
}

export function _receiveForTests(snapshot: WorkflowSnapshot): void {
  receive(snapshot)
}

export function _setLoadedForTests(project: string): void {
  _project = project
  _loaded = true
}
