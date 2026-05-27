/**
 * Cross-cutting state that the session save/restore feature needs but that
 * doesn't naturally live in any single component or store.
 *
 *   - `sessionIdsByTerminal`: `session_id` values for live Claude PTYs,
 *     emitted by the main process via `claude:session-id` and used to
 *     serialize Claude sessions on quit. (Main pins the id at spawn time
 *     via `claude --session-id <uuid>`; see #95 and pty.ts.)
 *   - `claudeTabsByPane`: each `TerminalTabs` publishes its current Claude
 *     tabs here so a global serializer can read them.
 *   - `pendingResumeByPane`: hydrated from disk on launch; each `TerminalTabs`
 *     drains its slice once on mount and renders placeholder tabs.
 *   - `layout`: PaneManager's local split + visited-pane state, mirrored here
 *     so the serializer can read it without prop-drilling.
 */
import { untrack } from 'svelte'
import type { SerializedClaudeSession } from '../../shared/ipc-types'

export type PaneRole = 'primary' | 'secondary'

function paneKey(role: PaneRole, worktreePath: string): string {
  return `${role}::${worktreePath}`
}

export interface ClaudeTabInfo {
  /** Terminal id used by the PTY in main. */
  terminalId: string
  label: string
  /** True for `claude agents` (Agent View) tabs — they restore via respawn,
   * not --resume, because the TUI doesn't emit a session-id. */
  isAgentView?: boolean
  /** True when the user explicitly renamed the tab — label is sticky. */
  customLabel?: boolean
}

let _sessionIdsByTerminal = $state<Map<string, string>>(new Map())
let _claudeTabsByPane = $state<Map<string, ClaudeTabInfo[]>>(new Map())
let _pendingResumeByPane = $state<Map<string, SerializedClaudeSession[]>>(new Map())

let _splitRatio = $state(50)
let _visitedPrimaryPaths = $state<string[]>([])
let _visitedSecondaryPaths = $state<string[]>([])

export const sessionRestoreStore = {
  // ── live capture (called from a global IPC listener) ────────────────────
  // NOTE: every writer below reads its own state to clone-then-assign. Wrap
  // the read in `untrack` so callers that live inside an `$effect` (e.g.
  // TerminalTabs.publishClaude) don't end up depending on the state they're
  // about to write — that pattern infinite-loops in Svelte 5.
  setSessionIdForTerminal(terminalId: string, sessionId: string): void {
    untrack(() => {
      if (_sessionIdsByTerminal.get(terminalId) === sessionId) return
      const next = new Map(_sessionIdsByTerminal)
      next.set(terminalId, sessionId)
      _sessionIdsByTerminal = next
    })
  },

  clearSessionIdForTerminal(terminalId: string): void {
    untrack(() => {
      if (!_sessionIdsByTerminal.has(terminalId)) return
      const next = new Map(_sessionIdsByTerminal)
      next.delete(terminalId)
      _sessionIdsByTerminal = next
    })
  },

  sessionIdForTerminal(terminalId: string): string | undefined {
    return _sessionIdsByTerminal.get(terminalId)
  },

  // ── per-pane Claude tab list (published by each TerminalTabs) ───────────
  publishClaudeTabs(role: PaneRole, worktreePath: string, tabs: ClaudeTabInfo[]): void {
    const key = paneKey(role, worktreePath)
    untrack(() => {
      const next = new Map(_claudeTabsByPane)
      if (tabs.length === 0) {
        if (!next.has(key)) return
        next.delete(key)
      } else {
        next.set(key, tabs)
      }
      _claudeTabsByPane = next
    })
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
    untrack(() => {
      const next = new Map(_pendingResumeByPane)
      if (sessions.length === 0) {
        next.delete(key)
      } else {
        next.set(key, sessions)
      }
      _pendingResumeByPane = next
    })
  },

  /**
   * Reactively peek at how many pending resumes are staged for a pane WITHOUT
   * clearing them. Reads `_pendingResumeByPane` tracked, so an `$effect` that
   * calls this re-runs when hydrateSession stages resumes after the effect
   * first ran — closing the mount-vs-hydrate race where a TerminalTabs that
   * mounted before hydration would drain nothing and lose the placeholders.
   */
  pendingResumeCount(role: PaneRole, worktreePath: string): number {
    const key = paneKey(role, worktreePath)
    return _pendingResumeByPane.get(key)?.length ?? 0
  },

  /** Drain pending resumes for a pane — returns and clears in one shot. */
  drainPendingResume(role: PaneRole, worktreePath: string): SerializedClaudeSession[] {
    const key = paneKey(role, worktreePath)
    return untrack(() => {
      const sessions = _pendingResumeByPane.get(key)
      if (!sessions || sessions.length === 0) return []
      const next = new Map(_pendingResumeByPane)
      next.delete(key)
      _pendingResumeByPane = next
      return sessions
    })
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
