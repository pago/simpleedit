/**
 * Cross-cutting state that the session save/restore feature needs but that
 * doesn't naturally live in any single component or store.
 *
 *   - `sessionIdsByTerminal`: live capture of `session_id` values from claude's
 *     stream-json init event, used to serialize Claude sessions on quit.
 *   - `claudeTabsByPane`: each `TerminalTabs` publishes its current Claude
 *     tabs here so a global serializer can read them.
 *   - `pendingResumeByPane`: hydrated from disk on launch; each `TerminalTabs`
 *     drains its slice once on mount and renders placeholder tabs.
 *   - `layout`: PaneManager's local split + visited-pane state, mirrored here
 *     so the serializer can read it without prop-drilling.
 */
import type { SerializedClaudeSession } from '../../shared/ipc-types'

export type PaneRole = 'primary' | 'secondary'

function paneKey(role: PaneRole, worktreePath: string): string {
  return `${role}::${worktreePath}`
}

export interface ClaudeTabInfo {
  /** Terminal id used by the PTY in main. */
  terminalId: string
  label: string
}

let _sessionIdsByTerminal = $state<Map<string, string>>(new Map())
let _claudeTabsByPane = $state<Map<string, ClaudeTabInfo[]>>(new Map())
let _pendingResumeByPane = $state<Map<string, SerializedClaudeSession[]>>(new Map())

let _splitRatio = $state(50)
let _visitedPrimaryPaths = $state<string[]>([])
let _visitedSecondaryPaths = $state<string[]>([])

export const sessionRestoreStore = {
  // ── live capture (called from a global IPC listener) ────────────────────
  setSessionIdForTerminal(terminalId: string, sessionId: string): void {
    if (_sessionIdsByTerminal.get(terminalId) === sessionId) return
    const next = new Map(_sessionIdsByTerminal)
    next.set(terminalId, sessionId)
    _sessionIdsByTerminal = next
  },

  clearSessionIdForTerminal(terminalId: string): void {
    if (!_sessionIdsByTerminal.has(terminalId)) return
    const next = new Map(_sessionIdsByTerminal)
    next.delete(terminalId)
    _sessionIdsByTerminal = next
  },

  sessionIdForTerminal(terminalId: string): string | undefined {
    return _sessionIdsByTerminal.get(terminalId)
  },

  // ── per-pane Claude tab list (published by each TerminalTabs) ───────────
  publishClaudeTabs(role: PaneRole, worktreePath: string, tabs: ClaudeTabInfo[]): void {
    const key = paneKey(role, worktreePath)
    const next = new Map(_claudeTabsByPane)
    if (tabs.length === 0) {
      if (!next.has(key)) return
      next.delete(key)
    } else {
      next.set(key, tabs)
    }
    _claudeTabsByPane = next
  },

  claudeTabsForPane(role: PaneRole, worktreePath: string): ClaudeTabInfo[] {
    return _claudeTabsByPane.get(paneKey(role, worktreePath)) ?? []
  },

  allPaneKeys(): string[] {
    return Array.from(_claudeTabsByPane.keys())
  },

  // ── pending restore placeholders ────────────────────────────────────────
  setPendingResume(role: PaneRole, worktreePath: string, sessions: SerializedClaudeSession[]): void {
    const key = paneKey(role, worktreePath)
    const next = new Map(_pendingResumeByPane)
    if (sessions.length === 0) {
      next.delete(key)
    } else {
      next.set(key, sessions)
    }
    _pendingResumeByPane = next
  },

  /** Drain pending resumes for a pane — returns and clears in one shot. */
  drainPendingResume(role: PaneRole, worktreePath: string): SerializedClaudeSession[] {
    const key = paneKey(role, worktreePath)
    const sessions = _pendingResumeByPane.get(key)
    if (!sessions || sessions.length === 0) return []
    const next = new Map(_pendingResumeByPane)
    next.delete(key)
    _pendingResumeByPane = next
    return sessions
  },

  // ── layout ──────────────────────────────────────────────────────────────
  splitRatio(): number {
    return _splitRatio
  },
  setSplitRatio(value: number): void {
    _splitRatio = value
  },

  visitedPrimaryPaths(): string[] {
    return _visitedPrimaryPaths
  },
  setVisitedPrimaryPaths(value: string[]): void {
    _visitedPrimaryPaths = value
  },

  visitedSecondaryPaths(): string[] {
    return _visitedSecondaryPaths
  },
  setVisitedSecondaryPaths(value: string[]): void {
    _visitedSecondaryPaths = value
  },

  /** Reset everything (called when switching repos). */
  reset(): void {
    _sessionIdsByTerminal = new Map()
    _claudeTabsByPane = new Map()
    _pendingResumeByPane = new Map()
    _splitRatio = 50
    _visitedPrimaryPaths = []
    _visitedSecondaryPaths = []
  },
}

/**
 * Subscribe to claude:session-id events and feed them into the store.
 * Call once during app startup.
 */
export function initClaudeSessionIdListener(): () => void {
  return window.api.on('claude:session-id', (data) => {
    sessionRestoreStore.setSessionIdForTerminal(data.terminalId, data.sessionId)
  })
}
