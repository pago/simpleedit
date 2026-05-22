/**
 * Renderer-side serializer + hydrator for the save/restore session feature.
 *
 * `serializeSession` snapshots the relevant stores into a `SerializedSession`
 * blob; `hydrateSession` writes that blob back into the stores so the next
 * launch looks identical (modulo Claude PTYs, which restore as click-to-resume
 * placeholders).
 */
import type {
  SerializedClaudeSession,
  SerializedSession,
  SerializedTab,
  SerializedWorktreeState,
} from '../../shared/ipc-types'
import {
  activeWorktree,
  secondPaneWorktree,
  focusedPane,
  setActiveWorktree,
  setSecondaryWorktree,
  setFocusedPane,
  worktreeList,
} from '../stores/worktrees.svelte'
import { tabsStore, type Tab } from '../stores/tabsStore.svelte'
import { sessionRestoreStore } from '../stores/sessionRestore.svelte'

const SAVE_VERSION = 1

function serializeTab(tab: Tab): SerializedTab | null {
  switch (tab.kind) {
    case 'file':
      return { kind: 'file', id: tab.id, path: tab.path }
    case 'diff':
      return {
        kind: 'diff',
        id: tab.id,
        commitHash: tab.commitHash,
        commitMessage: tab.commitMessage,
      }
    case 'tour':
      return {
        kind: 'tour',
        id: tab.id,
        commitHash: tab.commitHash,
        commitMessage: tab.commitMessage,
      }
    case 'plan':
      return {
        kind: 'plan',
        id: tab.id,
        planHash: tab.planHash,
        label: tab.label,
        claudeTerminalId: tab.claudeTerminalId,
      }
    case 'composed':
      // Agent-composed panels are tied to a live Claude tool call; restoring
      // them would dangle. Drop on save.
      return null
  }
}

function claudeSessionsForPane(role: 'primary' | 'secondary', worktreePath: string): SerializedClaudeSession[] {
  const tabs = sessionRestoreStore.claudeTabsForPane(role, worktreePath)
  return tabs.map((t) => {
    const stickyLabel = t.customLabel ? { customLabel: true as const } : {}
    if (t.isAgentView) {
      // Agent View tabs have no session-id by design; restore is respawn-based.
      return { label: t.label, isAgentView: true, ...stickyLabel }
    }
    const sessionId = sessionRestoreStore.sessionIdForTerminal(t.terminalId)
    return sessionId
      ? { label: t.label, sessionId, ...stickyLabel }
      : { label: t.label, ...stickyLabel }
  })
}

/**
 * Build a snapshot of all current state. Returns null when there's nothing
 * meaningful to save (no repo, no worktrees opened) so the caller can skip
 * the IPC roundtrip.
 */
export function serializeSession(repoPath: string): SerializedSession {
  const visitedPrimary = sessionRestoreStore.visitedPrimaryPaths()
  const visitedSecondary = sessionRestoreStore.visitedSecondaryPaths()

  // Union of all worktrees that ever held tabs or terminals, so we don't
  // forget worktrees the user has visited but isn't viewing right now.
  const involvedPaths = new Set<string>([
    ...visitedPrimary,
    ...visitedSecondary,
  ])
  for (const key of sessionRestoreStore.allPaneKeys()) {
    const sep = key.indexOf('::')
    if (sep > 0) involvedPaths.add(key.slice(sep + 2))
  }

  const worktreeStates: SerializedWorktreeState[] = []
  for (const path of involvedPaths) {
    const tabs = tabsStore
      .list(path)
      .map(serializeTab)
      .filter((t): t is SerializedTab => t !== null)
    const activeTabId = tabsStore.activeId(path)
    // The internal MRU isn't exposed by tabsStore; reconstruct from the
    // active id (good enough — close-focus uses MRU live, not at restore).
    const mru = activeTabId ? [activeTabId] : []
    const unread = tabs
      .filter((t) => tabsStore.isUnread(path, t.id))
      .map((t) => t.id)
    const primaryClaudeSessions = claudeSessionsForPane('primary', path)
    const secondaryClaudeSessions = claudeSessionsForPane('secondary', path)

    if (
      tabs.length === 0 &&
      primaryClaudeSessions.length === 0 &&
      secondaryClaudeSessions.length === 0
    ) {
      continue
    }

    worktreeStates.push({
      worktreePath: path,
      tabs,
      activeTabId,
      mru,
      unread,
      primaryClaudeSessions,
      secondaryClaudeSessions,
    })
  }

  return {
    version: SAVE_VERSION,
    repoPath,
    savedAt: new Date().toISOString(),
    layout: {
      primaryWorktreePath: activeWorktree()?.path ?? null,
      secondaryWorktreePath: secondPaneWorktree()?.path ?? null,
      focusedPane: focusedPane(),
      splitRatio: sessionRestoreStore.splitRatio(),
      // Copy out of the Svelte 5 reactive proxy arrays — structuredClone
      // (used by Electron IPC) errors on proxies, which would otherwise
      // throw on every save once any worktree has been visited.
      visitedPrimary: [...visitedPrimary],
      visitedSecondary: [...visitedSecondary],
    },
    worktreeStates,
  }
}

function deserializeTab(t: SerializedTab): Tab {
  switch (t.kind) {
    case 'file':
      return { kind: 'file', id: t.id, path: t.path, modified: false }
    case 'diff':
      return { kind: 'diff', id: t.id, commitHash: t.commitHash, commitMessage: t.commitMessage }
    case 'tour':
      return { kind: 'tour', id: t.id, commitHash: t.commitHash, commitMessage: t.commitMessage }
    case 'plan':
      return {
        kind: 'plan',
        id: t.id,
        planHash: t.planHash,
        label: t.label,
        claudeTerminalId: t.claudeTerminalId,
      }
  }
}

/**
 * Apply a previously-saved session. Worktrees that no longer exist on disk
 * are silently dropped. Returns the list of restored worktree paths so the
 * caller can decide what to focus next.
 */
export function hydrateSession(session: SerializedSession): {
  restoredWorktrees: string[]
  droppedWorktrees: string[]
} {
  const knownPaths = new Set(worktreeList().map((w) => w.path))
  const restoredWorktrees: string[] = []
  const droppedWorktrees: string[] = []

  // Hydrate per-worktree tab state (skip deleted worktrees).
  for (const ws of session.worktreeStates) {
    if (!knownPaths.has(ws.worktreePath)) {
      droppedWorktrees.push(ws.worktreePath)
      continue
    }
    restoredWorktrees.push(ws.worktreePath)

    // Re-open each tab in background so we don't disturb MRU. Then explicitly
    // focus the previously-active tab (if any) at the end so MRU is correct.
    for (const t of ws.tabs) {
      tabsStore.open(ws.worktreePath, deserializeTab(t), { focus: 'background' })
    }
    for (const id of ws.unread) {
      tabsStore.markUnread(ws.worktreePath, id)
    }
    if (ws.activeTabId) {
      tabsStore.focus(ws.worktreePath, ws.activeTabId)
    }

    // Stage Claude session placeholders for each pane to pick up on mount.
    sessionRestoreStore.setPendingResume('primary', ws.worktreePath, ws.primaryClaudeSessions)
    sessionRestoreStore.setPendingResume('secondary', ws.worktreePath, ws.secondaryClaudeSessions)
  }

  // Layout — apply only paths that still exist.
  const layout = session.layout
  const visitedPrimary = layout.visitedPrimary.filter((p) => knownPaths.has(p))
  const visitedSecondary = layout.visitedSecondary.filter((p) => knownPaths.has(p))
  // The active worktree must be in `visitedPrimary` for PaneManager to render
  // its WorktreePane — otherwise the {#each visitedPrimaryPaths} body skips it
  // and the pane is invisible. PaneManager's add-on-change effect only fires
  // when primaryPath transitions, so once hydrate runs after refreshWorktrees
  // (which already set the active path), clearing visited here would silently
  // strand the user with no editor pane. The first save after this regression
  // freezes `visitedPrimary: []`, so every subsequent launch reproduces it.
  if (
    layout.primaryWorktreePath &&
    knownPaths.has(layout.primaryWorktreePath) &&
    !visitedPrimary.includes(layout.primaryWorktreePath)
  ) {
    visitedPrimary.push(layout.primaryWorktreePath)
  }
  if (
    layout.secondaryWorktreePath &&
    knownPaths.has(layout.secondaryWorktreePath) &&
    !visitedSecondary.includes(layout.secondaryWorktreePath)
  ) {
    visitedSecondary.push(layout.secondaryWorktreePath)
  }
  sessionRestoreStore.setVisitedPrimaryPaths(visitedPrimary)
  sessionRestoreStore.setVisitedSecondaryPaths(visitedSecondary)
  sessionRestoreStore.setSplitRatio(layout.splitRatio)

  if (layout.primaryWorktreePath && knownPaths.has(layout.primaryWorktreePath)) {
    const wt = worktreeList().find((w) => w.path === layout.primaryWorktreePath)
    if (wt) setActiveWorktree(wt)
  }
  if (layout.secondaryWorktreePath && knownPaths.has(layout.secondaryWorktreePath)) {
    const wt = worktreeList().find((w) => w.path === layout.secondaryWorktreePath)
    if (wt) setSecondaryWorktree(wt)
  }
  setFocusedPane(layout.focusedPane)

  return { restoredWorktrees, droppedWorktrees }
}
