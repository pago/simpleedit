/**
 * The phone's mirror of the project's workflows (main owns them).
 *
 * Not the desk's `stores/workflows.svelte.ts`: that one also holds what only a
 * window does (lead hosts, worker resume, tabs) and reads desktop stores. This
 * one only loads `workflow:list` on every connection identity (`main.ts`: a
 * reconnect may be a switch of project, and a broadcast sent while the socket
 * was down never arrives) and applies `workflow:changed` for the project that
 * list named. Main sends phones slim snapshots.
 *
 * Statuses: the phone tracks no owned sessions, so main puts each worker's,
 * reviewer's and the lead's status on the snapshot (`statuses`). An
 * `agent:status` this socket receives is newer than any snapshot, so it wins
 * until the next load.
 */
import type { AgentStatus, AgentStatusEvent } from '../../shared/ipc-types'
import type { WorkflowSnapshot } from '../../shared/workflow'

let project = $state<string | null>(null)
let workflows = $state.raw<WorkflowSnapshot[]>([])
let loaded = $state(false)
/** The last load failed: a push tap waiting on the list is told so rather than left waiting. */
let failed = $state(false)
/** The window the mirror's list is for; another one's list is never shown in its place. */
let loadedFor: number | null = null
let live = $state.raw<ReadonlyMap<string, AgentStatus>>(new Map())
/** Guards against a slow earlier load landing on top of a newer one. */
let loadToken = 0

function receive(snapshot: WorkflowSnapshot): void {
  // Before the list, the project is unknown: whatever arrives is in the list.
  if (!loaded || snapshot.workflow.project !== project) return
  const id = snapshot.workflow.id
  if (snapshot.dismissed) {
    workflows = workflows.filter((w) => w.workflow.id !== id)
    // A detached worker never exits, so its status would otherwise stay for good.
    const kept = new Map([...live].filter(([terminalId]) => named(terminalId)))
    if (kept.size !== live.size) live = kept
    return
  }
  const index = workflows.findIndex((w) => w.workflow.id === id)
  workflows = index === -1 ? [...workflows, snapshot] : workflows.map((w, i) => (i === index ? snapshot : w))
}

/** Whether some workflow names this terminal: only those statuses are worth keeping. */
function named(terminalId: string): boolean {
  return workflows.some(
    (w) =>
      w.leadTerminalId === terminalId ||
      Object.values(w.workers).includes(terminalId) ||
      Object.values(w.reviewers).includes(terminalId),
  )
}

function noteStatus(event: AgentStatusEvent): void {
  const gone = event.status === 'exited'
  if (gone ? !live.has(event.terminalId) : !named(event.terminalId)) return
  const next = new Map(live)
  if (gone) next.delete(event.terminalId)
  else next.set(event.terminalId, event.status)
  live = next
}

export const phoneWorkflows = {
  all(): WorkflowSnapshot[] {
    return workflows
  },
  /** The project's list has arrived: a workflow missing now is really gone. */
  loaded(): boolean {
    return loaded
  },
  /** The last load failed, and none has succeeded since. */
  failed(): boolean {
    return failed
  },
  /** The phone is leaving this window: nothing may resolve against its list until the next load. */
  unload(): void {
    loaded = false
  },
  get(id: string): WorkflowSnapshot | undefined {
    return workflows.find((w) => w.workflow.id === id)
  },
  statusOf(terminalId: string): AgentStatus {
    const heard = live.get(terminalId)
    if (heard) return heard
    for (const w of workflows) {
      const status = w.statuses?.[terminalId]
      if (status) return status
    }
    return 'idle'
  },
  /**
   * On every connection identity. Until the answer is in, `loaded` is false,
   * so nothing (a push tap above all) resolves against a list that may be
   * stale; a different window's list is dropped at once.
   */
  async load(windowId: number | null = null): Promise<void> {
    const mine = ++loadToken
    loaded = false
    failed = false
    if (windowId !== loadedFor) {
      loadedFor = windowId
      project = null
      workflows = []
      live = new Map()
    }
    try {
      const list = await window.api.invoke('workflow:list')
      if (mine !== loadToken) return
      project = list.project
      workflows = list.workflows.filter((w) => !w.dismissed)
      live = new Map()
      loaded = true
    } catch (err) {
      if (mine === loadToken) failed = true
      console.warn('[workflows] loading workflows failed:', err)
    }
  },
  /** Tests only. */
  _reset(): void {
    project = null
    workflows = []
    loaded = false
    failed = false
    loadedFor = null
    live = new Map()
    loadToken++
  },
}

/** Subscribed for the life of the page, like the other mirrors. */
export function initWorkflowListeners(): void {
  window.api.on('workflow:changed', receive)
  window.api.on('agent:status', noteStatus)
}
