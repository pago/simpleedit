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
import { clearClaudeStatusForTerminal } from './claude-status.svelte'
import { tabsStore } from './tabsStore.svelte'
import { repoForWorktree } from './worktrees.svelte'

export type SessionKind = 'claude' | 'agents' | 'terminal'

export interface Session {
  /** PTY terminal id in main ('claude-…', 'agents-…', 'term-…'). */
  id: string
  kind: SessionKind
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
  /** Claude session uuid (pinned at spawn) — required for fork/resume. */
  claudeSessionId?: string
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
}

let _sessions = $state<Session[]>([])
let _activeId = $state<string | null>(null)
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
    opts: { resumeSessionId?: string } = {},
  ): string {
    const id = `claude-${crypto.randomUUID()}`
    _sessions = [
      { id, kind: 'claude', label: defaultLabel('claude'), launchDir, worktreePath },
      ..._sessions,
    ]
    select(id)
    void window.api.invoke('claude:spawn', {
      id,
      worktreePath: launchDir,
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    })
    return id
  },

  createAgents(launchDir: string, worktreePath: string): string {
    const id = `agents-${crypto.randomUUID()}`
    // The `claude agents` TUI sets noisy OSC titles — customLabel keeps
    // "Agents N" sticky (same rule as the old TerminalTabs).
    _sessions = [
      { id, kind: 'agents', label: defaultLabel('agents'), customLabel: true, launchDir, worktreePath },
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
      { id, kind: 'terminal', label: defaultLabel('terminal'), launchDir, worktreePath },
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
    _sessions = _sessions.filter((s) => s.id !== id)
    _visitedIds = _visitedIds.filter((v) => v !== id)
    clearClaudeStatusForTerminal(id)
    tabsStore.closeAll(id)

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
        label: defaultLabel('claude'),
        // Forks are explicitly "into worktree": the fork lives there, so it
        // launches there too (not at the project root).
        launchDir: targetWorktreePath,
        worktreePath: targetWorktreePath,
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
    sessionId?: string
  }): string | null {
    if (input.kind === 'agents') {
      // Agent View can't resume (no session-id) — respawn fresh, same slot.
      const id = `agents-${crypto.randomUUID()}`
      _sessions = [
        ..._sessions,
        {
          id,
          kind: 'agents',
          label: input.label || defaultLabel('agents'),
          customLabel: true,
          launchDir: input.launchDir,
          worktreePath: input.worktreePath,
          ...(input.repoPath ? { repoPath: input.repoPath } : {}),
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
        label: input.label || defaultLabel('claude'),
        ...(input.customLabel ? { customLabel: true as const } : {}),
        launchDir: input.launchDir,
        worktreePath: input.worktreePath,
        ...(input.repoPath ? { repoPath: input.repoPath } : {}),
        pendingResume: { sessionId: input.sessionId },
      },
    ]
    return id
  },

  /** Reset everything (switching repos). */
  reset(): void {
    for (const t of forkErrorDismissTimers.values()) clearTimeout(t)
    forkErrorDismissTimers.clear()
    _sessions = []
    _activeId = null
    _visitedIds = []
    nextClaudeIndex = 1
    nextAgentsIndex = 1
    nextTerminalIndex = 1
  },
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

  // Location tracking (Stage 2): the agent moved into a worktree we recognise.
  // Repoint the session's workspace to follow it. Last-writer-wins against the
  // manual dropdown — a fine default, since the agent's cwd is the freshest
  // signal of what it's actually working on. No-match cwds are ignored (the
  // workspace stays where the user/agent last put it).
  const offCwd = window.api.on('claude:cwd', (data) => {
    if (!data.worktreePath) return
    const session = sessionsStore.get(data.terminalId)
    if (!session || session.worktreePath === data.worktreePath) return
    // Resolve which repo owns the matched worktree so the viewer's repo and
    // worktree stay coherent if the agent roamed into another opened repo
    // (undefined = primary). Without this, repoPath could lag worktreePath.
    sessionsStore.setWorktree(data.terminalId, data.worktreePath, repoForWorktree(data.worktreePath))
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
    offData()
    offForkResult()
  }
}
