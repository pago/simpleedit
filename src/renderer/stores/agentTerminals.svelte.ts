/**
 * Shape of a "Discuss with Agent" target — a live Claude session the editor,
 * diff review, and popover components can send messages to. Derived from the
 * sessions registry (see SessionWorkspace's `agentTargets`).
 */
export interface AgentTabInfo {
  /** Session id (= PTY terminal id in main). */
  id: string
  label: string
}
