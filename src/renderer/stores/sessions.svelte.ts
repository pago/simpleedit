/**
 * Global session registry — the primary navigation entity of the agent-first
 * UI. A session is one PTY (Claude, Agent View, or plain terminal) plus the
 * workspace state that hangs off it (tabs in tabsStore keyed by session id,
 * worktree selection, editor layout in SessionWorkspace).
 *
 * The session id doubles as the PTY terminal id in main, so all existing
 * `pty:*` / `claude:*` IPC routes work unchanged.
 */
import { untrack } from 'svelte'
import type { ModelRef } from '../../shared/ipc-types'
import { clearClaudeStatusForTerminal } from './claude-status.svelte'
import { tabsStore } from './tabsStore.svelte'
import {
  repoForWorktree,
  repoKeyForWorktree,
  worktreeListFor,
  refreshWorktreesFor,
  primaryRepo,
} from './worktrees.svelte'

export type SessionKind = 'claude' | 'agents' | 'terminal'

/** Which interactive-agent provider backs this session. Only Claude Code today
 * (see src/main/agents/); other providers will extend this union. */
export type AgentProviderId = 'claude'

export interface Session {
  /** PTY terminal id in main ('claude-…', 'agents-…', 'term-…'). */
  id: string
  kind: SessionKind
  /**
   * The agent provider backing this session (harness axis, orthogonal to
   * `kind`). Set on agent-backed sessions; absent for plain terminals. Defaults
   * to 'claude' — the only provider today. The `claude:spawn` invoke isn't yet
   * routed by this (YAGNI for one provider).
   */
  provider?: AgentProviderId
  label: string
  /** True when the user renamed the session — OSC titles no longer apply. */
  customLabel?: boolean
  /**
   * Directory the PTY spawned in (and respawns in on resume). For Claude
   * sessions this is the PROJECT ROOT (beside the bare repo) so all sessions
   * share one Claude memory; for terminals it's a worktree.
   */
  launchDir: string
  /**
   * The worktree this session's WORKSPACE is pointed at (file tree root,
   * git log scope, diff targets) — deliberately separate from launchDir.
   * Defaults to the main worktree; the user repoints via the workspace
   * dropdown, and Stage 2 will follow the agent's tracked cwd.
   */
  worktreePath: string
  /**
   * The BARE REPO this session's worktree belongs to (Stage 4 multi-repo).
   * Undefined means the window's primary repo — the single-repo default, so
   * existing sessions and persistence are unaffected. Set when a session is
   * pointed at another bare repo, so worktree:* calls and the workspace's
   * worktree popover target the right repo.
   */
  repoPath?: string
  /**
   * Worktrees this session has worked in, most-recently-touched first — the
   * agent's location trail, fed by `session:cwd`. Drives the repo picker
   * (distinct repos in touch order) and the worktree picker's "touched" group.
   * Seeded with the initial worktree so the current location shows before the
   * agent moves.
   */
  touchedWorktrees: string[]
  /**
   * Whether this session's viewer chrome (tabs/file tree/git log) is open.
   * Lifted from the workspace component so the global cwd listener can read it:
   * the agent's moves only auto-repoint the view while the viewer is CLOSED
   * (the user isn't reviewing). Open = freeze the view, surface the move in the
   * picker instead. Undefined is treated as closed (progressive-disclosure
   * default).
   */
  viewerOpen?: boolean
  /** Claude session uuid (pinned at spawn) — required for fork/resume. */
  claudeSessionId?: string
  /**
   * The brain this session was launched against (cloud Claude or local Ollama).
   * Absent = cloud default. Resume/fork re-applying this is a deferred follow-up.
   */
  model?: ModelRef
  /** Restored-from-disk placeholder: no live PTY until the user clicks Resume. */
  pendingResume?: { sessionId: string }
  /** Fork-in-flight placeholder until the new PTY emits its first byte. */
  forking?: { sourceLabel: string }
  /** Fork failed: short-lived error chip; auto-cleared after ~6s. */
  forkError?: string
  /**
   * The PTY exited with a non-zero code (spawn failure or crash). The entry
   * stays in the inbox with the terminal buffer intact so the user can read
   * what happened; only zero-code (graceful) exits auto-close.
   */
  exited?: { exitCode: number }
  /**
   * The group this session belongs to (a `SessionGroup.id`), or undefined when
   * standalone. The sidebar keeps every group's members CONTIGUOUS in
   * `_sessions`, so grouping is purely an ordering invariant — see
   * `normalizeGroups`.
   */
  groupId?: string
}

/**
 * A named, colored, collapsible container over a contiguous run of sessions —
 * modelled on browser tab groups (Edge). Single level: groups never nest.
 */
export interface SessionGroup {
  id: string
  name: string
  /** Tailwind-ish color token; one of GROUP_COLORS. */
  color: string
  collapsed: boolean
}

/** Auto-assigned to new groups, cycled by group count. */
const GROUP_COLORS = ['sky', 'violet', 'emerald', 'amber', 'rose', 'cyan'] as const

let _sessions = $state<Session[]>([])
let _activeId = $state<string | null>(null)
let _groups = $state<SessionGroup[]>([])
/** Session whose terminal should grab focus once it mounts (keyboard new-session). */
let _pendingFocusId = $state<string | null>(null)
/** Sessions whose workspace has been mounted — kept alive across switches. */
let _visitedIds = $state<string[]>([])

let nextClaudeIndex = 1
let nextAgentsIndex = 1
let nextTerminalIndex = 1

const forkErrorDismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

function defaultLabel(kind: SessionKind): string {
  switch (kind) {
    case 'claude':
      return nextClaudeIndex++ === 1 ? 'Claude' : `Claude ${nextClaudeIndex - 1}`
    case 'agents':
      return nextAgentsIndex++ === 1 ? 'Agents' : `Agents ${nextAgentsIndex - 1}`
    case 'terminal':
      return `Terminal ${nextTerminalIndex++}`
  }
}

function select(id: string | null): void {
  _activeId = id
  if (id && !_visitedIds.includes(id)) {
    _visitedIds = [..._visitedIds, id]
  }
}

function findSession(id: string): Session | undefined {
  return _sessions.find((s) => s.id === id)
}

/**
 * Re-cluster every group's members so they form one contiguous run, anchored at
 * the index of the group's earliest current member. Stable for everything else.
 * The safety net that lets each mutating op set `groupId` + splice naively and
 * trust the contiguity invariant is restored here.
 */
function normalizeGroups(): void {
  if (!_sessions.some((s) => s.groupId)) return

  const result: Session[] = []
  const emitted = new Set<string>()
  for (const s of _sessions) {
    if (!s.groupId) {
      result.push(s)
      continue
    }
    // At a group's anchor (first member seen in array order), emit every member
    // of that group in their current relative order; skip later stragglers.
    if (emitted.has(s.groupId)) continue
    emitted.add(s.groupId)
    for (const m of _sessions) if (m.groupId === s.groupId) result.push(m)
  }
  _sessions = result
}

/** Drop a group when it has <2 members, clearing the lone member's groupId. */
function dissolveIfOrphaned(groupId: string | undefined): void {
  if (!groupId) return
  if (!_groups.some((g) => g.id === groupId)) return
  const members = _sessions.filter((s) => s.groupId === groupId)
  if (members.length >= 2) return
  for (const m of members) {
    const idx = _sessions.findIndex((s) => s.id === m.id)
    if (idx >= 0) {
      const next = _sessions.slice()
      next[idx] = { ...next[idx], groupId: undefined }
      _sessions = next
    }
  }
  _groups = _groups.filter((g) => g.id !== groupId)
}

export const sessionsStore = {
  sessions(): Session[] {
    return _sessions
  },

  activeSessionId(): string | null {
    return _activeId
  },

  activeSession(): Session | null {
    return _activeId ? (findSession(_activeId) ?? null) : null
  },

  visitedIds(): string[] {
    return _visitedIds
  },

  groups(): SessionGroup[] {
    return _groups
  },

  group(id: string): SessionGroup | undefined {
    return _groups.find((g) => g.id === id)
  },

  get(id: string): Session | undefined {
    return findSession(id)
  },

  select(id: string): void {
    if (!findSession(id)) return
    select(id)
  },

  // ── creation ─────────────────────────────────────────────────────────────

  createClaude(
    launchDir: string,
    worktreePath: string,
    opts: { resumeSessionId?: string; model?: ModelRef; initialPrompt?: string; label?: string } = {},
  ): string {
    const id = `claude-${crypto.randomUUID()}`
    const model = opts.model
    _sessions = [
      {
        id,
        kind: 'claude',
        provider: 'claude',
        // An explicit label (e.g. "review ui-pack#42") or a picked model names the
        // session and pins the label so OSC titles don't overwrite it; the plain
        // cloud default keeps "Claude N".
        label: opts.label ?? (model ? model.model : defaultLabel('claude')),
        ...(opts.label || model ? { customLabel: true as const } : {}),
        ...(model ? { model } : {}),
        launchDir,
        worktreePath,
        touchedWorktrees: [worktreePath],
      },
      ..._sessions,
    ]
    select(id)
    void window.api.invoke('claude:spawn', {
      id,
      worktreePath: launchDir,
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
      // $state.snapshot: `model` may be a Svelte proxy (e.g. an element of a
      // $state model list) — Electron IPC structured-clone rejects proxies.
      ...(model ? { model: $state.snapshot(model) } : {}),
      ...(opts.initialPrompt ? { initialPrompt: opts.initialPrompt } : {}),
    })
    // For cloud Claude, upgrade the raw model id to its human display name once
    // the (static) catalog resolves — best-effort, leaves the id if not found.
    if (model?.provider === 'anthropic') {
      const anthropicModel = model.model
      void window.api
        .invoke('models:claude')
        .then((catalog) => {
          const match = catalog.find((m) => m.model === anthropicModel)
          if (match) sessionsStore.update(id, { label: match.displayName })
        })
        .catch(() => {})
    }
    return id
  },

  createAgents(launchDir: string, worktreePath: string): string {
    const id = `agents-${crypto.randomUUID()}`
    // The `claude agents` TUI sets noisy OSC titles — customLabel keeps
    // "Agents N" sticky (same rule as the old TerminalTabs).
    _sessions = [
      { id, kind: 'agents', provider: 'claude', label: defaultLabel('agents'), customLabel: true, launchDir, worktreePath, touchedWorktrees: [worktreePath] },
      ..._sessions,
    ]
    select(id)
    void window.api.invoke('claude:spawn-agents', { id, worktreePath: launchDir })
    return id
  },

  createTerminal(launchDir: string, worktreePath: string = launchDir): string {
    const id = `term-${crypto.randomUUID()}`
    _sessions = [
      ..._sessions,
      { id, kind: 'terminal', label: defaultLabel('terminal'), launchDir, worktreePath, touchedWorktrees: [worktreePath] },
    ]
    select(id)
    void window.api.invoke('pty:spawn', { id, worktreePath: launchDir })
    return id
  },

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Close a session: kill its PTY (if live) and remove the entry plus all
   * workspace state. Also the target of pty:exit auto-close, where the PTY is
   * already gone.
   */
  close(id: string, opts: { ptyAlreadyDead?: boolean } = {}): void {
    const session = findSession(id)
    if (!session) return

    const dismiss = forkErrorDismissTimers.get(id)
    if (dismiss !== undefined) {
      clearTimeout(dismiss)
      forkErrorDismissTimers.delete(id)
    }

    const hasLivePty =
      !session.pendingResume && !session.forking && !session.exited && !opts.ptyAlreadyDead
    if (hasLivePty) {
      if (session.kind === 'claude') {
        void window.api.invoke('claude:detach', id)
      }
      void window.api.invoke('pty:kill', id)
    }

    const idx = _sessions.findIndex((s) => s.id === id)
    const closedGroup = session.groupId
    _sessions = _sessions.filter((s) => s.id !== id)
    _visitedIds = _visitedIds.filter((v) => v !== id)
    clearClaudeStatusForTerminal(id)
    tabsStore.closeAll(id)
    dissolveIfOrphaned(closedGroup)

    if (_activeId === id) {
      const next = _sessions[Math.min(idx, _sessions.length - 1)]
      select(next?.id ?? null)
    }
  },

  resumePlaceholder(id: string): void {
    const session = findSession(id)
    if (!session?.pendingResume) return
    const resumeSessionId = session.pendingResume.sessionId
    this.update(id, { pendingResume: undefined })
    select(id)
    void window.api.invoke('claude:spawn', {
      id,
      worktreePath: session.launchDir,
      resumeSessionId,
    })
  },

  rename(id: string, label: string): void {
    this.update(id, { label: label.trim(), customLabel: true })
  },

  /**
   * Repoint a session's workspace at a worktree. `repoPath` is the bare repo
   * that worktree belongs to — pass it (undefined = the window's primary repo)
   * whenever the worktree may be in a non-primary repo, so the file tree, git
   * log, and worktree popover all scope to the right repo. Omitting the
   * argument leaves the session's current repo untouched (the common
   * same-repo case, e.g. cwd tracking within the launched repo).
   */
  setWorktree(id: string, worktreePath: string, repoPath?: string): void {
    const patch: Partial<Session> = { worktreePath }
    if (arguments.length >= 3) patch.repoPath = repoPath
    this.update(id, patch)
  },

  /** Repoint the ACTIVE session's workspace (sidebar / popover / repo-picker
   * clicks). Pass repoPath (undefined = primary) when the worktree may be in a
   * non-primary repo; omit to leave the session's current repo untouched. */
  setActiveSessionWorktree(worktreePath: string, repoPath?: string): void {
    if (!_activeId) return
    if (arguments.length >= 2) this.setWorktree(_activeId, worktreePath, repoPath)
    else this.setWorktree(_activeId, worktreePath)
  },

  /**
   * Record that the session worked in `worktreePath` — move-to-front on its
   * trail (dedup). Drives the repo + worktree pickers; deliberately separate
   * from `setWorktree` so the trail updates even when we don't move the view
   * (viewer open / user reviewing).
   */
  recordTouch(id: string, worktreePath: string): void {
    const session = findSession(id)
    if (!session) return
    const rest = session.touchedWorktrees.filter((p) => p !== worktreePath)
    if (rest.length === session.touchedWorktrees.length - 1 && session.touchedWorktrees[0] === worktreePath) {
      return // already at front — no state churn
    }
    this.update(id, { touchedWorktrees: [worktreePath, ...rest] })
  },

  setViewerOpen(id: string, open: boolean): void {
    const session = findSession(id)
    if (!session || !!session.viewerOpen === open) return
    this.update(id, { viewerOpen: open })
  },

  /**
   * Apply an OSC title from the PTY. User-renamed sessions are sticky.
   * Strips Claude Code's status prefix (✳ U+2733 or braille spinner
   * U+2800–U+28FF), which is always followed by a space.
   */
  applyOscTitle(id: string, rawTitle: string): void {
    const session = findSession(id)
    if (!session || session.customLabel) return
    const firstCp = rawTitle.codePointAt(0) ?? 0
    const hasPrefix = firstCp === 0x2733 || (firstCp >= 0x2800 && firstCp <= 0x28ff)
    const label = hasPrefix
      ? rawTitle.slice(String.fromCodePoint(firstCp).length).trimStart()
      : rawTitle
    this.update(id, { label })
  },

  update(id: string, patch: Partial<Session>): void {
    untrack(() => {
      const idx = _sessions.findIndex((s) => s.id === id)
      if (idx < 0) return
      const next = _sessions.slice()
      next[idx] = { ...next[idx], ...patch }
      _sessions = next
    })
  },

  // ── grouping & reorder ─────────────────────────────────────────────────────

  /**
   * Move a session within the list. `target` encodes the drop intent:
   *  • `{ mode: 'before' | 'after', refId }` — place next to `refId`, inheriting
   *    refId's group (so dropping next to a standalone session ungroups, and
   *    dropping next to a grouped one joins that group).
   *  • `{ mode: 'intoGroup', groupId }` — append to a group's run.
   *  • `{ mode: 'toEnd' }` — move to the end of the list as a standalone session.
   * Contiguity is restored by `normalizeGroups` afterwards, so the splice index
   * only needs to be approximately right.
   */
  moveSession(
    draggedId: string,
    target:
      | { mode: 'before' | 'after'; refId: string }
      | { mode: 'intoGroup'; groupId: string }
      | { mode: 'toEnd' },
  ): void {
    const dragged = findSession(draggedId)
    if (!dragged) return
    const prevGroup = dragged.groupId
    const without = _sessions.filter((s) => s.id !== draggedId)

    let nextGroupId: string | undefined
    let insertAt: number
    if (target.mode === 'toEnd') {
      nextGroupId = undefined
      insertAt = without.length
    } else if (target.mode === 'intoGroup') {
      nextGroupId = target.groupId
      const members = without.filter((s) => s.groupId === target.groupId)
      const last = members[members.length - 1]
      insertAt = last ? without.findIndex((s) => s.id === last.id) + 1 : without.length
    } else {
      if (target.refId === draggedId) return
      const refIdx = without.findIndex((s) => s.id === target.refId)
      if (refIdx < 0) return
      nextGroupId = findSession(target.refId)?.groupId
      insertAt = target.mode === 'after' ? refIdx + 1 : refIdx
    }

    const moved: Session = { ...dragged, groupId: nextGroupId }
    _sessions = [...without.slice(0, insertAt), moved, ...without.slice(insertAt)]

    normalizeGroups()
    if (prevGroup !== nextGroupId) dissolveIfOrphaned(prevGroup)
  },

  /**
   * Create a group from existing sessions (gesture or context menu). Members
   * become contiguous at the earliest member's position. Returns the group id.
   */
  createGroup(memberIds: string[], name = 'New group', color?: string): string | null {
    const members = memberIds.filter((id) => findSession(id))
    if (members.length < 2) return null
    const id = `group-${crypto.randomUUID()}`
    _groups = [
      ..._groups,
      { id, name, color: color ?? GROUP_COLORS[_groups.length % GROUP_COLORS.length], collapsed: false },
    ]
    const memberSet = new Set(members)
    _sessions = _sessions.map((s) => (memberSet.has(s.id) ? { ...s, groupId: id } : s))
    normalizeGroups()
    return id
  },

  renameGroup(id: string, name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    _groups = _groups.map((g) => (g.id === id ? { ...g, name: trimmed } : g))
  },

  setGroupColor(id: string, color: string): void {
    _groups = _groups.map((g) => (g.id === id ? { ...g, color } : g))
  },

  toggleGroupCollapsed(id: string): void {
    _groups = _groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g))
  },

  /** Remove a session from its group (context menu), dissolving a stub group. */
  removeFromGroup(sessionId: string): void {
    const session = findSession(sessionId)
    if (!session?.groupId) return
    const groupId = session.groupId
    this.update(sessionId, { groupId: undefined })
    normalizeGroups()
    dissolveIfOrphaned(groupId)
  },

  /** Disband a whole group, leaving its members in place as standalone. */
  ungroup(groupId: string): void {
    _sessions = _sessions.map((s) => (s.groupId === groupId ? { ...s, groupId: undefined } : s))
    _groups = _groups.filter((g) => g.id !== groupId)
  },

  // ── terminal focus signal ──────────────────────────────────────────────────

  /** Ask the named session's terminal to grab focus once it mounts. */
  requestTerminalFocus(id: string): void {
    _pendingFocusId = id
  },

  pendingFocusId(): string | null {
    return _pendingFocusId
  },

  /** Clear the focus request if it targets `id` (called once focus is applied). */
  consumeFocusRequest(id: string): void {
    if (_pendingFocusId === id) _pendingFocusId = null
  },

  // ── fork ─────────────────────────────────────────────────────────────────

  /**
   * Insert a fork placeholder session. Returns the placeholder id the caller
   * passes to `claude:fork` as placeholderTabId so fork-result routes back.
   */
  addForkPlaceholder(sourceLabel: string, targetWorktreePath: string): string {
    const id = `claude-fork-${crypto.randomUUID()}`
    _sessions = [
      {
        id,
        kind: 'claude',
        provider: 'claude',
        label: defaultLabel('claude'),
        // Forks are explicitly "into worktree": the fork lives there, so it
        // launches there too (not at the project root).
        launchDir: targetWorktreePath,
        worktreePath: targetWorktreePath,
        touchedWorktrees: [targetWorktreePath],
        forking: { sourceLabel },
      },
      ..._sessions,
    ]
    select(id)
    return id
  },

  /**
   * Mark a fork as failed: error chip on the placeholder, auto-dismissed
   * (session closed) after ~6s unless the user closes it first.
   */
  failFork(placeholderId: string, message: string): void {
    const session = findSession(placeholderId)
    if (!session) return
    this.update(placeholderId, { forking: undefined, forkError: message })
    const existing = forkErrorDismissTimers.get(placeholderId)
    if (existing !== undefined) clearTimeout(existing)
    const t = setTimeout(() => {
      forkErrorDismissTimers.delete(placeholderId)
      const still = findSession(placeholderId)
      if (still?.forkError) this.close(placeholderId)
    }, 6_000)
    forkErrorDismissTimers.set(placeholderId, t)
  },

  // ── persistence hooks ────────────────────────────────────────────────────

  /** Stage a restored session as a click-to-resume placeholder. */
  addRestoredSession(input: {
    kind: 'claude' | 'agents'
    label: string
    customLabel?: boolean
    launchDir: string
    worktreePath: string
    repoPath?: string
    touchedWorktrees?: string[]
    sessionId?: string
    groupId?: string
  }): string | null {
    // Restore the persisted trail; fall back to the workspace worktree so the
    // current location still shows in the pickers for pre-trail blobs.
    const touchedWorktrees =
      input.touchedWorktrees && input.touchedWorktrees.length > 0
        ? input.touchedWorktrees
        : [input.worktreePath]
    if (input.kind === 'agents') {
      // Agent View can't resume (no session-id) — respawn fresh, same slot.
      const id = `agents-${crypto.randomUUID()}`
      _sessions = [
        ..._sessions,
        {
          id,
          kind: 'agents',
          provider: 'claude',
          label: input.label || defaultLabel('agents'),
          customLabel: true,
          launchDir: input.launchDir,
          worktreePath: input.worktreePath,
          ...(input.repoPath ? { repoPath: input.repoPath } : {}),
          touchedWorktrees,
          ...(input.groupId ? { groupId: input.groupId } : {}),
        },
      ]
      void window.api.invoke('claude:spawn-agents', { id, worktreePath: input.launchDir })
      return id
    }
    if (!input.sessionId) return null
    const id = `claude-${crypto.randomUUID()}`
    _sessions = [
      ..._sessions,
      {
        id,
        kind: 'claude',
        provider: 'claude',
        label: input.label || defaultLabel('claude'),
        ...(input.customLabel ? { customLabel: true as const } : {}),
        launchDir: input.launchDir,
        worktreePath: input.worktreePath,
        ...(input.repoPath ? { repoPath: input.repoPath } : {}),
        touchedWorktrees,
        ...(input.groupId ? { groupId: input.groupId } : {}),
        pendingResume: { sessionId: input.sessionId },
      },
    ]
    return id
  },

  /** Seed group definitions from a restored blob (before sessions are added). */
  restoreGroups(groups: SessionGroup[]): void {
    _groups = groups.map((g) => ({ ...g }))
  },

  /**
   * After hydration, normalize order and drop any group that ended up with <2
   * members (e.g. members that were plain terminals, which aren't persisted).
   */
  finalizeRestoredGroups(): void {
    normalizeGroups()
    for (const g of [..._groups]) dissolveIfOrphaned(g.id)
  },

  /** Reset everything (switching repos). */
  reset(): void {
    for (const t of forkErrorDismissTimers.values()) clearTimeout(t)
    forkErrorDismissTimers.clear()
    _sessions = []
    _activeId = null
    _groups = []
    _pendingFocusId = null
    _visitedIds = []
    nextClaudeIndex = 1
    nextAgentsIndex = 1
    nextTerminalIndex = 1
  },
}

/**
 * Distinct repos this session has touched, most-recently-first. Each touched
 * worktree is normalized to its repo key (primary repo for primary worktrees),
 * so the repo picker lists exactly the repos this agent has worked across.
 */
export function touchedReposForSession(session: Session): string[] {
  const repos: string[] = []
  for (const wt of session.touchedWorktrees) {
    const repo = repoKeyForWorktree(wt)
    if (repo && !repos.includes(repo)) repos.push(repo)
  }
  return repos
}

/**
 * This session's touched worktrees within one repo, most-recently-first.
 * `repoPath` undefined = the primary repo. Backs the worktree picker's pinned
 * "touched" group (the rest of the repo's worktrees follow, alphabetically).
 */
export function touchedWorktreesForRepo(
  session: Session,
  repoPath: string | null | undefined,
): string[] {
  const key = repoPath ?? primaryRepo()
  return session.touchedWorktrees.filter((wt) => repoKeyForWorktree(wt) === key)
}

/**
 * Global listeners that keep the registry in sync with main. Call once at
 * app startup; returns an unsubscribe.
 */
export function initSessionListeners(): () => void {
  // Graceful exit (code 0: `exit`, `/exit`) auto-closes the session — no
  // "exited" state lingers in the inbox (PLAN.md design decision). A NON-zero
  // exit means spawn failure or crash: keep the entry with the terminal
  // buffer intact so the failure is readable instead of silently vanishing.
  const offExit = window.api.on('pty:exit', ({ id, exitCode }) => {
    const session = sessionsStore.get(id)
    if (!session) return
    if (exitCode === 0) {
      sessionsStore.close(id, { ptyAlreadyDead: true })
    } else {
      sessionsStore.update(id, { exited: { exitCode } })
    }
  })

  // Claude session uuid, pinned at spawn time by main (claude --session-id).
  const offSessionId = window.api.on('claude:session-id', (data) => {
    sessionsStore.update(data.terminalId, { claudeSessionId: data.sessionId })
  })

  // Location tracking (Stage 2+): the agent's tracked cwd moved.
  //   • Always RECORD the move on the session's trail (drives the pickers),
  //     after caching a freshly-discovered repo's worktrees so it resolves.
  //   • Only FOLLOW it with the view when the viewer is CLOSED — if it's open
  //     the user is reviewing, so we leave the view put and let the picker
  //     indicator surface the move instead.
  // Last-writer-wins against the manual dropdown when we do follow — the
  // agent's cwd is the freshest signal of what it's working on.
  const offCwd = window.api.on('session:cwd', (data) => {
    const session = sessionsStore.get(data.terminalId)
    if (!session) return
    void (async () => {
      // data.repoPath is set only when the agent roamed into a repo this window
      // hadn't opened; cache its worktrees so repoForWorktree / the pickers
      // can resolve the new worktree before we record it.
      if (data.repoPath && worktreeListFor(data.repoPath).length === 0) {
        await refreshWorktreesFor(data.repoPath)
      }
      if (!data.worktreePath) return
      sessionsStore.recordTouch(data.terminalId, data.worktreePath)
      const current = sessionsStore.get(data.terminalId)
      if (!current || current.viewerOpen) return
      if (current.worktreePath === data.worktreePath) return
      sessionsStore.setWorktree(data.terminalId, data.worktreePath, repoForWorktree(data.worktreePath))
    })()
  })

  // The agent read/edited a file in a repo its cwd never entered. RECORD the
  // touch (so the repo surfaces in the picker) but never FOLLOW it — unlike
  // session:cwd, a file glance must not repoint the workspace the user is on.
  const offRepoTouch = window.api.on('session:repo-touch', (data) => {
    const session = sessionsStore.get(data.terminalId)
    if (!session) return
    void (async () => {
      if (data.repoPath && worktreeListFor(data.repoPath).length === 0) {
        await refreshWorktreesFor(data.repoPath)
      }
      sessionsStore.recordTouch(data.terminalId, data.worktreePath)
    })()
  })

  // Fork placeholder goes live on the new PTY's first byte.
  const offData = window.api.on('pty:data', ({ id }) => {
    const session = sessionsStore.get(id)
    if (session?.forking) sessionsStore.update(id, { forking: undefined })
  })

  const offForkResult = window.api.on('claude:fork-result', (payload) => {
    if (payload.ok) return // success surfaces via pty:data above
    sessionsStore.failFork(payload.placeholderTabId, payload.error)
  })

  return () => {
    offExit()
    offSessionId()
    offCwd()
    offRepoTouch()
    offData()
    offForkResult()
  }
}
