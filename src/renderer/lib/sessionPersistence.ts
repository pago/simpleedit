/**
 * Renderer-side serializer + hydrator for the save/restore session feature.
 *
 * `serializeSession` snapshots the sessions registry plus each session's
 * workspace tabs into a `SerializedSession` blob; `hydrateSession` writes that
 * blob back so the next launch shows the same sessions as click-to-resume
 * entries. Plain terminals are not persisted.
 */
import type {
  SerializedAgentSession,
  SerializedSession,
  SerializedTab,
} from '../../shared/ipc-types'
import { worktreeList, projectRoot } from '../stores/worktrees.svelte'
import { sessionsStore } from '../stores/sessions.svelte'
import { tabsStore, type Tab } from '../stores/tabsStore.svelte'

const SAVE_VERSION = 2

function serializeTab(tab: Tab): SerializedTab | null {
  switch (tab.kind) {
    case 'file':
      return { kind: 'file', id: tab.id, path: tab.path }
    case 'diff':
      return {
        kind: 'diff',
        id: tab.id,
        worktreePath: tab.worktreePath,
        commitHash: tab.commitHash,
        commitMessage: tab.commitMessage,
      }
    case 'tour':
      return {
        kind: 'tour',
        id: tab.id,
        worktreePath: tab.worktreePath,
        commitHash: tab.commitHash,
        commitMessage: tab.commitMessage,
      }
    case 'plan':
      return {
        kind: 'plan',
        id: tab.id,
        worktreePath: tab.worktreePath,
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

/** Build a snapshot of all persistable sessions and their workspaces. */
export function serializeSession(repoPath: string): SerializedSession {
  const sessions: SerializedAgentSession[] = []
  let activeIndex: number | null = null
  const activeId = sessionsStore.activeSessionId()

  for (const session of sessionsStore.sessions()) {
    if (session.kind === 'terminal') continue
    if (session.forking || session.forkError) continue
    // Crash/spawn-failure entries are ephemeral error surfaces, not
    // resumable work — a claude that never started has no transcript.
    if (session.exited) continue

    // A not-yet-resumed placeholder keeps its resumability across another
    // quit — its uuid lives in pendingResume rather than claudeSessionId.
    const sessionId = session.claudeSessionId ?? session.pendingResume?.sessionId

    const tabs = tabsStore
      .list(session.id)
      .map(serializeTab)
      .filter((t): t is SerializedTab => t !== null)
    const unread = tabs
      .filter((t) => tabsStore.isUnread(session.id, t.id))
      .map((t) => t.id)

    if (session.id === activeId) activeIndex = sessions.length
    sessions.push({
      kind: session.kind,
      label: session.label,
      ...(session.customLabel ? { customLabel: true as const } : {}),
      ...(sessionId ? { sessionId } : {}),
      launchDir: session.launchDir,
      worktreePath: session.worktreePath,
      ...(session.repoPath ? { repoPath: session.repoPath } : {}),
      tabs,
      activeTabId: tabsStore.activeId(session.id),
      unread,
    })
  }

  return {
    version: SAVE_VERSION,
    repoPath,
    savedAt: new Date().toISOString(),
    sessions,
    activeIndex,
  }
}

function deserializeTab(t: SerializedTab): Tab {
  switch (t.kind) {
    case 'file':
      return { kind: 'file', id: t.id, path: t.path, modified: false }
    case 'diff':
      return {
        kind: 'diff',
        id: t.id,
        worktreePath: t.worktreePath,
        commitHash: t.commitHash,
        commitMessage: t.commitMessage,
      }
    case 'tour':
      return {
        kind: 'tour',
        id: t.id,
        worktreePath: t.worktreePath,
        commitHash: t.commitHash,
        commitMessage: t.commitMessage,
      }
    case 'plan':
      return {
        kind: 'plan',
        id: t.id,
        worktreePath: t.worktreePath,
        planHash: t.planHash,
        label: t.label,
        claudeTerminalId: t.claudeTerminalId,
      }
  }
}

/**
 * Apply a previously-saved session blob. Sessions pointing at worktrees that
 * no longer exist are remapped to the main worktree; tabs scoped to a deleted
 * worktree are dropped.
 */
export function hydrateSession(session: SerializedSession): {
  restoredSessions: number
  droppedSessions: number
} {
  const knownPaths = new Set(worktreeList().map((w) => w.path))
  const mainPath = worktreeList()[0]?.path ?? null
  let restored = 0
  let dropped = 0
  let activeNewId: string | null = null

  session.sessions.forEach((s, index) => {
    // A session pointed at a non-primary repo keeps its remembered worktree
    // (that repo isn't loaded yet, so knownPaths can't validate it — the
    // workspace loads the repo lazily on activation). Primary-repo sessions
    // remap a vanished worktree to the primary main, as before.
    const worktreePath = s.repoPath
      ? s.worktreePath
      : knownPaths.has(s.worktreePath)
        ? s.worktreePath
        : mainPath
    if (!worktreePath) {
      dropped++
      return
    }

    const newId = sessionsStore.addRestoredSession({
      kind: s.kind,
      label: s.label,
      ...(s.customLabel ? { customLabel: true as const } : {}),
      launchDir: s.launchDir ?? projectRoot() ?? worktreePath,
      worktreePath,
      ...(s.repoPath ? { repoPath: s.repoPath } : {}),
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
    })
    if (!newId) {
      // Claude session without a captured uuid — nothing to resume.
      dropped++
      return
    }
    restored++

    for (const t of s.tabs) {
      // Tabs pinned to a deleted worktree would error on load — drop them.
      if (t.kind !== 'file' && !knownPaths.has(t.worktreePath)) continue
      if (t.kind === 'file' && !t.path.startsWith(worktreePath) && ![...knownPaths].some((p) => t.path.startsWith(p))) continue
      tabsStore.open(newId, deserializeTab(t), { focus: 'background' })
    }
    for (const id of s.unread) {
      tabsStore.markUnread(newId, id)
    }
    if (s.activeTabId) {
      tabsStore.focus(newId, s.activeTabId)
    }

    if (session.activeIndex === index) activeNewId = newId
  })

  if (activeNewId) sessionsStore.select(activeNewId)

  return { restoredSessions: restored, droppedSessions: dropped }
}
