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
  SerializedGroup,
  SerializedSession,
  SerializedTab,
} from '../../shared/ipc-types'
import { worktreeList, projectRoot, refreshWorktreesFor } from '../stores/worktrees.svelte'
import { sessionsStore } from '../stores/sessions.svelte'
import { tabsStore, type Tab } from '../stores/tabsStore.svelte'

const SAVE_VERSION = 4

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
    // Crash/spawn-failure entries are ephemeral error surfaces, not
    // resumable work — a claude that never started has no transcript.
    if (session.exited) continue

    // A not-yet-resumed placeholder keeps its resumability across another
    // quit — its uuid lives in pendingResume rather than providerSessionId.
    const sessionId = session.providerSessionId ?? session.pendingResume?.sessionId

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
      ...(session.provider ? { provider: session.provider } : {}),
      // Narrow on 'claude', not on a named native provider: the else branch
      // hard-codes `provider: 'claude'`, so testing for one specific native id
      // silently persists every OTHER native provider as a Claude session — it
      // would come back as the wrong agent on restore.
      ...(session.target
        ? { target: session.target.provider === 'claude'
            ? { provider: 'claude' as const, ...(session.target.model ? { model: { ...session.target.model } } : {}) }
            : { ...session.target } }
        : {}),
      label: session.label,
      ...(session.customLabel ? { customLabel: true as const } : {}),
      ...(sessionId ? { sessionId } : {}),
      launchDir: session.launchDir,
      worktreePath: session.worktreePath,
      ...(session.repoPath ? { repoPath: session.repoPath } : {}),
      // Spread into a plain array: the live value is a Svelte $state proxy,
      // which isn't structured-cloneable across the session:save IPC.
      ...(session.touchedWorktrees.length > 0
        ? { touchedWorktrees: [...session.touchedWorktrees] }
        : {}),
      ...(session.groupId ? { groupId: session.groupId } : {}),
      ...(session.seedPrompt ? { seedPrompt: session.seedPrompt } : {}),
      tabs,
      activeTabId: tabsStore.activeId(session.id),
      unread,
    })
  }

  // Persist only groups that still have a persisted member — terminals (and
  // other unpersisted entries) are skipped above, so a terminals-only group
  // would dangle.
  const persistedGroupIds = new Set(sessions.map((s) => s.groupId).filter(Boolean))
  const groups: SerializedGroup[] = sessionsStore
    .groups()
    .filter((g) => persistedGroupIds.has(g.id))
    .map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed }))

  return {
    version: SAVE_VERSION,
    repoPath,
    savedAt: new Date().toISOString(),
    sessions,
    activeIndex,
    ...(groups.length > 0 ? { groups } : {}),
  }
}

function deserializeTab(t: SerializedTab): Tab | null {
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
    default:
      // Forward-compat: sessions saved by older builds may carry kinds we no
      // longer support (e.g. the removed 'plan' tab). Skip them on restore.
      return null
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

  // Seed group definitions before sessions so addRestoredSession can attach
  // each entry to its group; stub groups are pruned in finalize below.
  sessionsStore.restoreGroups(session.groups ?? [])
  // Non-primary repos any restored session points at — load their worktrees so
  // the trail entries resolve to their repos in the picker (repoKeyForWorktree
  // needs the cache). Fire-and-forget; the pickers fill in reactively.
  const trailRepos = new Set<string>()

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
      ...(s.provider ? { provider: s.provider } : {}),
      ...(s.target ? { target: s.target } : {}),
      label: s.label,
      ...(s.customLabel ? { customLabel: true as const } : {}),
      launchDir: s.launchDir ?? projectRoot() ?? worktreePath,
      worktreePath,
      ...(s.repoPath ? { repoPath: s.repoPath } : {}),
      ...(s.touchedWorktrees ? { touchedWorktrees: s.touchedWorktrees } : {}),
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
      ...(s.groupId ? { groupId: s.groupId } : {}),
      ...(s.seedPrompt ? { seedPrompt: s.seedPrompt } : {}),
    })
    if (s.repoPath) trailRepos.add(s.repoPath)
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
      const tab = deserializeTab(t)
      // Forward-compat: a removed kind (e.g. old 'plan' tab) deserializes to null.
      if (tab) tabsStore.open(newId, tab, { focus: 'background' })
    }
    for (const id of s.unread) {
      tabsStore.markUnread(newId, id)
    }
    if (s.activeTabId) {
      tabsStore.focus(newId, s.activeTabId)
    }

    if (session.activeIndex === index) activeNewId = newId
  })

  // Restore order + drop groups that lost too many members (e.g. all-terminal
  // groups, which aren't persisted).
  sessionsStore.finalizeRestoredGroups()

  if (activeNewId) sessionsStore.select(activeNewId)

  for (const repo of trailRepos) void refreshWorktreesFor(repo)

  return { restoredSessions: restored, droppedSessions: dropped }
}
