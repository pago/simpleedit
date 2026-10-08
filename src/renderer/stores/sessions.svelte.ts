/**
 * Global session registry — the primary navigation entity of the agent-first
 * UI. A session is one PTY (Claude, Codex, Agent View, or plain terminal) plus the
 * workspace state that hangs off it (tabs in tabsStore keyed by session id,
 * worktree selection, editor layout in SessionWorkspace).
 *
 * The session id doubles as the PTY terminal id in main, so all existing
 * `pty:*` and `agent:*` IPC routes address the same identifier.
 */
import { untrack } from 'svelte'
import { capabilitiesFor, providerForModelBrand, providerLabel } from './agent-capabilities.svelte'
import type { AgentPeer, AgentProviderId, InteractiveTarget, MemoryGit, MemoryLocation, ModelConfig, ModelRef, NativeModelAgentId, ReasoningEffort, SessionRepoTrail, WindowSessionInput } from '../../shared/ipc-types'
import { clearAgentStatusForTerminal, getAgentStatusForTerminal } from './agent-status.svelte'
import { tabsStore } from './tabsStore.svelte'
import {
  repoForWorktree,
  repoKeyForWorktree,
  worktreeListFor,
  refreshWorktreesFor,
  primaryRepo,
  projectRoot,
  mainWorktree,
} from './worktrees.svelte'
import { loadAgentModels } from '../lib/agentModels'

export type SessionKind = 'agent' | 'agents' | 'terminal'

export interface Session {
  /** PTY terminal id in main ('agent-claude-…', 'agent-codex-…', 'agents-…', 'term-…'). */
  id: string
  kind: SessionKind
  /**
   * The agent provider backing this session (harness axis, orthogonal to
   * `kind`). Set on agent-backed sessions; absent for plain terminals. Defaults
   * to 'claude' when loading a legacy session.
   */
  provider?: AgentProviderId
  target?: InteractiveTarget
  label: string
  /** True when the user renamed the session — OSC titles no longer apply. */
  customLabel?: boolean
  /**
   * Directory the PTY spawned in (and respawns in on resume). EVERY agent —
   * Claude and Codex alike — launches at the project root (beside the bare
   * repo), never inside a worktree: agents create their own worktrees, and a
   * root launch is what lets one agent memory span them. Only plain terminals
   * spawn in a worktree.
   *
   * For Codex this is load-bearing beyond convention. Codex gates hook loading
   * on directory trust (`[projects."<path>"] trust_level`), which is NOT
   * inherited by subdirectories — so launching per-worktree would demand a
   * fresh interactive trust grant for every worktree, and until it was given
   * no hooks would load at all. Rooted at the container, one grant covers
   * every session in the project.
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
  /**
   * The workspace is showing this session's Claude auto-memory directory
   * instead of its worktree. A VIEW overlay only: `worktreePath` keeps
   * pointing at the real worktree (agent spawn, cwd-follow, the repo trail and
   * persistence all read it), and this field is never persisted.
   */
  memoryView?: MemoryView
  /** Claude session uuid (pinned at spawn) — required for fork/resume. */
  providerSessionId?: string
  /**
   * The opening prompt this session was launched with (`createClaude`'s
   * `initialPrompt`). Kept on the record — not merely forwarded to the PTY — so
   * the handoff composer can recover the session's GOAL without re-reading the
   * JSONL transcript (the anti-pattern the session-spawn design forbids).
   * Absent for sessions launched with no seed prompt.
   */
  seedPrompt?: string
  /**
   * The brain this session was launched against (cloud Claude or local Ollama).
   * Absent = cloud default.
   */
  model?: ModelRef
  /** Restored-from-disk placeholder: no live PTY until the user clicks Resume. */
  pendingResume?: { sessionId: string }
  /**
   * Why the last Resume never reached main. Shown on the placeholder, which
   * comes back so the user can retry; not persisted.
   */
  resumeError?: string
  /**
   * The PTY exited with a non-zero code (spawn failure or crash). The entry
   * stays in the inbox with the terminal buffer intact so the user can read
   * what happened; only zero-code (graceful) exits auto-close.
   */
  exited?: { exitCode: number }
  /**
   * This provider's reporting needs a one-time grant from the user
   * (`capabilities.reportingSetup === 'user-granted'`) and hasn't reported
   * yet, so status and tracking are still on coarse PTY signals. Clears as
   * soon as the first provider-native signal arrives.
   */
  reportingSetupNeeded?: boolean
  /**
   * The group this session belongs to (a `SessionGroup.id`), or undefined when
   * standalone. The sidebar keeps every group's members CONTIGUOUS in
   * `_sessions`, so grouping is purely an ordering invariant — see
   * `normalizeGroups`.
   */
  groupId?: string
}

export interface MemoryView {
  memoryDir: string
  exists: boolean
  git: MemoryGit | null
  /** See `MemoryLocation.refused`. */
  refused?: true
  /** `viewerOpen` before the memory view forced it open — restored on leave,
   * since cwd-follow only runs while the viewer is closed. */
  prevViewerOpen: boolean
  /** A leave was refused because these memory files have unsaved edits. */
  leaveBlocked?: { files: string[]; agentRepoint: boolean }
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

export interface AgentCreateOptions {
  resumeSessionId?: string
  forkSession?: boolean
  model?: ModelRef
  initialPrompt?: string
  /**
   * A name a human or a model CHOSE. Sticky: nothing automatic overwrites it.
   */
  label?: string
  /**
   * A name DERIVED from something the user wrote — a brief's first clause —
   * shown for want of anything better until the agent names the conversation.
   *
   * Deliberately separate from `label`, because a machine-derived stand-in
   * must not suppress a name a human or model later chooses. Ranks below
   * `label` and above the model id.
   */
  provisionalLabel?: string
  target?: { groupId?: string; index: number }
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
/**
 * The window's sessions have been restored. Until then the list is empty only
 * because it hasn't been filled, and pushing it to the messaging bus would
 * read as "every session is gone" and drop their mail.
 */
let _hydrated = $state(false)

let nextAgentsIndex = 1
let nextTerminalIndex = 1

/**
 * Per-provider counters so each agent numbers its own sessions ("Claude",
 * "Claude 2", "Codex", …) rather than sharing one "Claude" sequence.
 */
const nextAgentIndex = new Map<string, number>()

function defaultLabel(kind: SessionKind, providerName = 'Claude'): string {
  switch (kind) {
    case 'agent': {
      const n = (nextAgentIndex.get(providerName) ?? 0) + 1
      nextAgentIndex.set(providerName, n)
      return n === 1 ? providerName : `${providerName} ${n}`
    }
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

export function isInMemoryDir(path: string, memoryDir: string): boolean {
  return path === memoryDir || path.startsWith(`${memoryDir}/`)
}

/** Where the session's file tree and editor are rooted right now. */
export function viewRootFor(session: Session): string {
  return session.memoryView?.memoryDir ?? session.worktreePath
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

  createAgent(
    rawTarget: InteractiveTarget,
    launchDir: string,
    worktreePath: string,
    opts: AgentCreateOptions = {},
  ): string {
    // Detach from Svelte's reactive graph ONCE, up front. Callers hand us a
    // target read straight out of the session array — `forkAgent` and
    // "discuss with agent" both pass `session.target` — so it is a $state proxy,
    // which structured clone rejects on the way through IPC. Snapshotting here
    // rather than at each `invoke` keeps the two calls below from disagreeing,
    // and stops the new session aliasing the source session's target object.
    const target = $state.snapshot(rawTarget) as InteractiveTarget
    const id = `agent-${target.provider}-${crypto.randomUUID()}`
    const model = opts.model ?? (target.provider === 'claude' ? target.model : undefined)
    const caps = capabilitiesFor(target.provider)
    const name = providerLabel(target.provider)
    // The model id, when the target names one. `model-ref` providers carry a
    // structured ModelRef; every other provider carries a bare native id, so
    // narrowing on 'claude' handles all of them without naming any.
    const modelId = target.provider === 'claude' ? model?.model : target.model
    // `customLabel` means a human or a model CHOSE this name, and nothing
    // automatic may overwrite it. Falling back to the model id is NOT a choice
    // — it is what we show for want of anything better — so it no longer sets
    // the flag, and the conversation title the agent later reports replaces it.
    // This applies to every provider: before, any session started on an
    // explicit model was frozen at the model id for its whole life.
    // Whether a provider's titles may rename a session stays a provider
    // property, decided when the title actually arrives — deciding it here
    // would race the async capability fetch.
    // A CHOSEN name only. A provisional one ranks above the model id and
    // below nothing else — it is still a stand-in, so the agent's own title
    // replaces it exactly as it replaces the model id.
    const chosen = !!opts.label
    const newSession: Session = {
      id,
      kind: 'agent',
      provider: target.provider,
      target,
      label: opts.label ?? opts.provisionalLabel ?? modelId ?? defaultLabel('agent', name),
      ...(chosen ? { customLabel: true as const } : {}),
      ...(model ? { model } : {}),
      ...(opts.initialPrompt ? { seedPrompt: opts.initialPrompt } : {}),
      ...(opts.target?.groupId ? { groupId: opts.target.groupId } : {}),
      launchDir,
      worktreePath,
      touchedWorktrees: [worktreePath],
      ...(caps?.reportingSetup === 'user-granted' ? { reportingSetupNeeded: true } : {}),
    }
    if (opts.target) {
      const at = Math.min(Math.max(opts.target.index, 0), _sessions.length)
      _sessions = [..._sessions.slice(0, at), newSession, ..._sessions.slice(at)]
      // Keep the adopted group's members contiguous (no-op when standalone).
      if (opts.target.groupId) normalizeGroups()
    } else {
      _sessions = [newSession, ..._sessions]
    }
    select(id)
    void window.api.invoke('agent:spawn', {
      id,
      worktreePath: launchDir,
      target,
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
      ...(opts.forkSession ? { forkSession: true } : {}),
      // $state.snapshot: `model` may be a Svelte proxy (e.g. an element of a
      // $state model list) — Electron IPC structured-clone rejects proxies.
      ...(model ? { model: $state.snapshot(model) } : {}),
      ...(opts.initialPrompt ? { initialPrompt: opts.initialPrompt } : {}),
    })
    // "Last model used" is stored as a uniform ModelRef. A bare native id is
    // lifted into one using the brand its provider declares, so this never has
    // to know which agent produced the id. `lastUsed` is always sent, including
    // as undefined: `setModelConfig` treats a present-but-undefined key as an
    // explicit clear, which is how starting a default session resets the
    // remembered model. Dropping the key instead would silently keep it.
    //
    // A model-less launch still records WHICH AGENT ran — the brand alone is a
    // valid ModelRef for every native provider, and it is what the next
    // new-session gesture reads. Requiring an id here meant the ✦ menu's own
    // "configured default" entry for an agent cleared the memory instead of
    // writing it, sending ⌘T, ✦ and the phone back to Claude.
    const lastUsed: ModelRef | undefined =
      target.provider === 'claude'
        ? target.model
        : caps?.nativeModelBrand
          ? {
              provider: caps.nativeModelBrand,
              ...(target.model ? { model: target.model } : {}),
              ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
            }
          : undefined
    void window.api.invoke('models:config-set', { lastUsed })
    // For cloud Claude, upgrade the raw model id to its human display name once
    // the catalog resolves — best-effort, leaves the id if not found.
    // Skip when the caller supplied any label: the upgrade only prettifies the
    // default (model-id) label. It must not clobber a chosen name — nor a
    // provisional one, which is likewise more use than a model id.
    if (model?.provider === 'anthropic' && !opts.label && !opts.provisionalLabel) {
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

  createClaude(
    launchDir: string,
    worktreePath: string,
    opts: AgentCreateOptions = {},
  ): string {
    const target: InteractiveTarget = { provider: 'claude', ...(opts.model ? { model: opts.model } : {}) }
    return this.createAgent(target, launchDir, worktreePath, opts)
  },

  /**
   * Start a session for any provider that names its model by bare native id.
   *
   * `opts.model` is that native id and belongs ONLY on the target.
   * `AgentCreateOptions.model` is a structured ModelRef — Claude's brain
   * selection — so the rest of `opts` is forwarded field by field rather than
   * spread. Passing the string through would put it on `Session.model` and in
   * the `agent:spawn` payload, and `spawnSessionFromAgent` inherits
   * `caller.model` as a ModelRef, so this session spawning a Claude peer would
   * hand the bare id on as that peer's model.
   */
  createNativeAgent(
    provider: NativeModelAgentId,
    launchDir: string,
    worktreePath: string,
    opts: { model?: string; reasoningEffort?: ReasoningEffort; initialPrompt?: string; label?: string; provisionalLabel?: string } = {},
  ): string {
    const target: InteractiveTarget = {
      provider,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    }
    return this.createAgent(target, launchDir, worktreePath, {
      ...(opts.initialPrompt ? { initialPrompt: opts.initialPrompt } : {}),
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.provisionalLabel ? { provisionalLabel: opts.provisionalLabel } : {}),
    })
  },

  createCodex(
    launchDir: string,
    worktreePath: string,
    opts: { model?: string; reasoningEffort?: ReasoningEffort; initialPrompt?: string; label?: string; provisionalLabel?: string } = {},
  ): string {
    return this.createNativeAgent('codex', launchDir, worktreePath, opts)
  },

  createOpenCode(
    launchDir: string,
    worktreePath: string,
    opts: { model?: string; reasoningEffort?: ReasoningEffort; initialPrompt?: string; label?: string; provisionalLabel?: string } = {},
  ): string {
    return this.createNativeAgent('opencode', launchDir, worktreePath, opts)
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
    void window.api.invoke('agent:spawn-agents', { id, worktreePath: launchDir })
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

  /**
   * Replace a session in place: spawn a fresh Claude session at the outgoing
   * session's slot (and group), then dispose the outgoing one. This is the
   * in-place "reset" — escape a bloated context and start clean without losing
   * your position in the sidebar. Returns the new session id, or null if the
   * outgoing session no longer exists.
   *
   * Ordering matters: we spawn (and `select`) the successor first, THEN close
   * the outgoing session — so the active selection lands on the new session and
   * the outgoing's group (if any) never drops below two members mid-swap.
   */
  replaceWithClaude(
    outgoingId: string,
    launchDir: string,
    worktreePath: string,
    opts: { model?: ModelRef; initialPrompt?: string; label?: string } = {},
  ): string | null {
    return this.replaceWithAgent(outgoingId, { provider: 'claude', ...(opts.model ? { model: opts.model } : {}) }, launchDir, worktreePath, opts)
  },

  replaceWithAgent(
    outgoingId: string,
    target: InteractiveTarget,
    launchDir: string,
    worktreePath: string,
    opts: AgentCreateOptions = {},
  ): string | null {
    const outgoing = findSession(outgoingId)
    if (!outgoing) return null
    const index = _sessions.findIndex((s) => s.id === outgoingId)
    const newId = this.createAgent(target, launchDir, worktreePath, {
      ...opts,
      target: { groupId: outgoing.groupId, index },
    })
    this.close(outgoingId)
    return newId
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

    const hasLivePty =
      !session.pendingResume && !session.exited && !opts.ptyAlreadyDead
    if (hasLivePty) {
      if (session.kind === 'agent') {
        void window.api.invoke('agent:detach', id)
      }
      void window.api.invoke('pty:kill', id)
    }

    const idx = _sessions.findIndex((s) => s.id === id)
    const closedGroup = session.groupId
    _sessions = _sessions.filter((s) => s.id !== id)
    _visitedIds = _visitedIds.filter((v) => v !== id)
    clearAgentStatusForTerminal(id)
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
    const pendingResume = { sessionId: session.pendingResume.sessionId }
    // A restored target lives in the session array, so it is a $state proxy,
    // which structured clone rejects on the way through IPC.
    const target = $state.snapshot(
      session.target ?? { provider: session.provider ?? 'claude' },
    ) as InteractiveTarget
    // Claude's launch reads its brain from the spawn's `model`, never from the
    // target. Without it a resumed session starts on the default model, and a
    // local one loses the endpoint it ran against.
    const model = target.provider === 'claude' ? target.model : undefined
    this.update(id, { pendingResume: undefined, resumeError: undefined })
    select(id)
    // Main reports its own spawn failures into the terminal. Anything thrown
    // here never got that far, so there is no terminal to show it in: put the
    // placeholder back, or the workspace is left black with nothing behind it.
    void (async () => {
      try {
        await window.api.invoke('agent:spawn', {
          id,
          worktreePath: session.launchDir,
          target,
          resumeSessionId: pendingResume.sessionId,
          ...(model ? { model } : {}),
        })
      } catch (error) {
        console.error(`Resume of ${id} failed:`, error)
        if (!findSession(id)) return
        sessionsStore.update(id, {
          pendingResume,
          resumeError: error instanceof Error ? error.message : String(error),
        })
      }
    })()
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

  // ── Claude memory view ───────────────────────────────────────────────────

  /** Point the session's viewer at its Claude memory dir (resolved in main). */
  async openMemoryView(id: string): Promise<void> {
    const session = findSession(id)
    if (!session || session.memoryView) return
    const loc = await window.api.invoke('memory:resolve', session.launchDir)
    const current = findSession(id)
    if (!current || current.memoryView) return
    this.update(id, {
      memoryView: {
        memoryDir: loc.memoryDir,
        exists: loc.exists,
        git: loc.git,
        refused: loc.refused,
        prevViewerOpen: !!current.viewerOpen,
      },
      viewerOpen: true,
    })
  },

  /** Apply a re-resolve to every open memory view launched from `launchDir`. */
  applyMemoryLocation(launchDir: string, loc: MemoryLocation): void {
    for (const s of _sessions) {
      const mv = s.memoryView
      if (!mv || s.launchDir !== launchDir) continue
      if (
        mv.memoryDir === loc.memoryDir &&
        mv.exists === loc.exists &&
        mv.refused === loc.refused &&
        mv.git?.root === loc.git?.root &&
        mv.git?.pathspec === loc.git?.pathspec
      ) {
        continue
      }
      this.update(s.id, {
        memoryView: { ...mv, memoryDir: loc.memoryDir, exists: loc.exists, git: loc.git, refused: loc.refused },
      })
    }
  },

  /**
   * Leave the memory view: close its file and diff tabs and restore the
   * viewer's previous open state. Refused — nothing changes — while any memory
   * file has unsaved edits, since closing a tab discards them.
   */
  closeMemoryView(id: string): { blocked: string[] } {
    const session = findSession(id)
    const mv = session?.memoryView
    if (!mv) return { blocked: [] }
    const tabs = tabsStore.list(id)
    const memoryFileTabs = tabs.filter(
      (t) => t.kind === 'file' && isInMemoryDir(t.path, mv.memoryDir),
    )
    const blocked = memoryFileTabs.flatMap((t) => (t.kind === 'file' && t.modified ? [t.path] : []))
    if (blocked.length > 0) return { blocked }
    for (const t of tabs) {
      if (memoryFileTabs.includes(t) || (t.kind === 'diff' && t.memoryScope)) tabsStore.close(id, t.id)
    }
    this.update(id, { memoryView: undefined, viewerOpen: mv.prevViewerOpen })
    return { blocked: [] }
  },

  /**
   * Run a repoint of the session's view, leaving the memory view first. When
   * the leave is refused `fn` is dropped and the workspace shows why.
   */
  leaveMemoryThen(id: string | null, fn: () => void, opts: { agentRepoint?: boolean } = {}): boolean {
    const mv = id ? findSession(id)?.memoryView : undefined
    if (!id || !mv) {
      fn()
      return true
    }
    const { blocked } = this.closeMemoryView(id)
    if (blocked.length > 0) {
      this.update(id, {
        memoryView: { ...mv, leaveBlocked: { files: blocked, agentRepoint: !!opts.agentRepoint } },
      })
      return false
    }
    fn()
    return true
  },

  dismissMemoryLeaveBlocked(id: string): void {
    const mv = findSession(id)?.memoryView
    if (!mv?.leaveBlocked) return
    this.update(id, { memoryView: { ...mv, leaveBlocked: undefined } })
  },

  setViewerOpen(id: string, open: boolean): void {
    const session = findSession(id)
    if (!session || !!session.viewerOpen === open) return
    this.update(id, { viewerOpen: open })
  },

  /**
   * Apply a conversation title the agent reported out-of-band.
   *
   * Unlike an OSC title this never needs cleaning up or vetting — a provider
   * only reports one if `reportsSessionTitle` says it names conversations —
   * but it obeys the same stickiness rule: a name the user or a model CHOSE
   * wins, a provisional model-id stand-in does not.
   */
  applySessionTitle(id: string, title: string): void {
    const session = findSession(id)
    if (!session || session.customLabel) return
    const clean = title.trim()
    if (!clean || clean === session.label) return
    this.update(id, { label: clean })
  },

  /**
   * Apply an OSC title from the PTY. User-renamed sessions are sticky.
   * Strips Claude Code's status prefix (✳ U+2733 or braille spinner
   * U+2800–U+28FF), which is always followed by a space.
   */
  applyOscTitle(id: string, rawTitle: string): void {
    const session = findSession(id)
    if (!session || session.customLabel) return
    // Agents put all sorts of things in the OSC title — a working directory
    // plus a spinner, or a fixed brand string — and renaming the session to
    // that on every turn would be worse than useless. A known provider must
    // therefore opt IN by reporting `session-label`; only a session with no
    // provider at all (a plain terminal, keeping its shell-set title) is
    // permissive by default. Blocking a denylist of known-bad values instead
    // silently re-breaks the moment a provider reports a new kind of title.
    const caps = capabilitiesFor(session.provider)
    if (session.provider && caps && caps.oscTitle !== 'session-label') return
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
   * Full-context in-place fork: branch a live provider session into a fresh,
   * independent session carrying the whole forked conversation. Goes through
   * the same provider launch path as any spawn, with `forkSession` set so the
   * provider uses its native fork command. The source is left intact.
   *
   * Grouping: the fork joins the source's group if it has one, else a fresh
   * group is formed pairing the two — a lone session has no group to inherit,
   * so the fork must create one to keep the pair visually together.
   *
   * Returns the new session id, or null if the source has no provider identity
   * yet (for example while initializing, or for Agent View).
   */
  forkAgent(sourceId: string): string | null {
    const source = findSession(sourceId)
    if (!source || source.kind !== 'agent' || !source.providerSessionId || !source.target) return null

    const index = _sessions.findIndex((s) => s.id === sourceId)
    const newId = this.createAgent(source.target, source.launchDir, source.worktreePath, {
      resumeSessionId: source.providerSessionId,
      forkSession: true,
      // No `model`: `createAgent` takes it from the source's target.
      label: `${source.label} (fork)`,
      // Sit right after the source; adopt its group when it has one.
      target: { groupId: source.groupId, index: index + 1 },
    })
    // A standalone source has no group to inherit (groups dissolve below two
    // members), so form one pairing the origin and its fork.
    if (!source.groupId) this.createGroup([sourceId, newId], 'Fork')
    return newId
  },

  // ── persistence hooks ────────────────────────────────────────────────────

  /** Stage a restored session as a click-to-resume placeholder. */
  addRestoredSession(input: {
    kind: 'agent' | 'agents' | 'claude'
    provider?: AgentProviderId
    target?: InteractiveTarget
    label: string
    customLabel?: boolean
    launchDir: string
    worktreePath: string
    repoPath?: string
    touchedWorktrees?: string[]
    sessionId?: string
    groupId?: string
    seedPrompt?: string
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
      void window.api.invoke('agent:spawn-agents', { id, worktreePath: input.launchDir })
      return id
    }
    if (!input.sessionId) return null
    const id = `agent-${input.provider ?? 'claude'}-${crypto.randomUUID()}`
    const restoredModel = input.target?.provider === 'claude' ? input.target.model : undefined
    _sessions = [
      ..._sessions,
      {
        id,
        kind: 'agent',
        provider: input.provider ?? 'claude',
        target: input.target ?? { provider: input.provider ?? 'claude' },
        label: input.label || defaultLabel('agent'),
        ...(input.customLabel ? { customLabel: true as const } : {}),
        // As `createAgent` sets it, so a peer this session spawns inherits it.
        ...(restoredModel ? { model: { ...restoredModel } } : {}),
        launchDir: input.launchDir,
        worktreePath: input.worktreePath,
        ...(input.repoPath ? { repoPath: input.repoPath } : {}),
        touchedWorktrees,
        ...(input.groupId ? { groupId: input.groupId } : {}),
        ...(input.seedPrompt ? { seedPrompt: input.seedPrompt } : {}),
        // A restored session needs the trust-grant band as much as a fresh one —
        // arguably more, since the user has quit and relaunched since granting.
        // Without this, resuming a Codex session gives degraded status and
        // tracking with nothing on screen explaining why.
        ...(capabilitiesFor(input.provider ?? 'claude')?.reportingSetup === 'user-granted'
          ? { reportingSetupNeeded: true }
          : {}),
        pendingResume: { sessionId: input.sessionId },
      },
    ]
    return id
  },

  /** The repo's saved sessions are restored (or there were none). */
  markHydrated(): void {
    _hydrated = true
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
    _hydrated = false
    _sessions = []
    _activeId = null
    _groups = []
    _pendingFocusId = null
    _visitedIds = []
    nextAgentIndex.clear()
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
 * Start the session a bare "new session" gesture asks for — the ✦ Agent
 * button, ⌘T at the desk, `+` on the phone.
 *
 * ONE definition, because the alternatives disagree in front of the user: the
 * same `lastUsed` starting OpenCode from the sidebar and Claude from ⌘T, in
 * the same window, with no picker on the phone to correct it.
 *
 * The rule is the last model a session was launched against, resolved back to
 * the agent that OWNS it through the descriptors. Testing one brand by name —
 * `provider === 'openai'` — is the mistake `providerForModelBrand` exists to
 * prevent: it quietly sends every other native model to Claude. `anthropic`
 * and `ollama` are Claude's own brands, and a Claude default deliberately
 * pins no model id, so the harness's own default applies.
 */
export function createSessionFromDefaults(
  config: ModelConfig | null,
  launchDir: string,
  worktreePath: string,
  opts: { initialPrompt?: string; label?: string; provisionalLabel?: string } = {},
): string {
  const lastUsed = config?.lastUsed
  const owner =
    lastUsed && lastUsed.provider !== 'anthropic' && lastUsed.provider !== 'ollama'
      ? providerForModelBrand(lastUsed.provider)
      : undefined
  if (!owner || !isNativeModelAgent(owner)) {
    return sessionsStore.createClaude(launchDir, worktreePath, opts)
  }
  return sessionsStore.createNativeAgent(owner, launchDir, worktreePath, {
    ...opts,
    ...(lastUsed?.model ? { model: lastUsed.model } : {}),
    ...(lastUsed && 'reasoningEffort' in lastUsed && lastUsed.reasoningEffort
      ? { reasoningEffort: lastUsed.reasoningEffort }
      : {}),
  })
}

/**
 * Whether an agent names its models by bare native id, and so can be started
 * from a remembered one.
 *
 * Read from the descriptor rather than matched against a union of ids:
 * `NativeModelAgentId` is a compile-time list, and a provider registered after
 * it was written would be resolved by `providerForModelBrand` and then
 * rejected here for no reason the user could see. Claude is excluded by the
 * same rule rather than by name — it is the `model-ref` provider.
 */
function isNativeModelAgent(provider: AgentProviderId): provider is NativeModelAgentId {
  return capabilitiesFor(provider)?.modelSelector === 'model-id'
}

/**
 * Handle a `session:create-request`: a client with no session of its own — the
 * phone — asked for one, seeded with a spoken brief.
 *
 * Every answer path reports back. Main is holding a call open on the other
 * end, and it deliberately cannot tell a refusal from a renderer that never
 * answered: silence there is remembered as "a session may exist", which would
 * leave the user unable to retry an intent that in fact started nothing.
 */
async function createSessionFromBrief(
  data: import('../../shared/ipc-types').SessionEventMap['session:create-request'],
): Promise<void> {
  let answered = false
  const answer = (outcome: import('../../shared/ipc-types').SessionCreateOutcome): void => {
    if (answered) return
    answered = true
    void window.api.invoke('session:created', data.correlationId, outcome)
  }

  try {
    const wt = mainWorktree()
    const root = projectRoot() ?? wt?.path
    if (!root || !wt) {
      answer({ ok: false, reason: 'That SimpleEdit window has no repo open yet.' })
      return
    }

    const label = data.label
      ? data.labelFixed
        ? { label: data.label }
        : // Provisional: the brief's first clause is a stand-in the agent
          // replaces as soon as it names the conversation, exactly as at the desk.
          { provisionalLabel: data.label }
      : {}
    let id: string
    if (data.target) {
      // The same call the desk's Discuss with Agent makes for a picked model.
      id = sessionsStore.createAgent(data.target, root, wt.path, {
        ...(data.target.provider === 'claude' && data.target.model ? { model: data.target.model } : {}),
        initialPrompt: data.brief,
        ...label,
      })
    } else {
      // A config that cannot be read is not a reason to refuse: the fallback is
      // the same plain Claude session an absent `lastUsed` would have produced.
      const config = await window.api.invoke('models:config-get').catch(() => null)
      id = createSessionFromDefaults(config, root, wt.path, { initialPrompt: data.brief, ...label })
    }
    answer({ ok: true, terminalId: id, label: sessionsStore.get(id)?.label ?? id })
  } catch (err) {
    // Anything unforeseen still has to come back as an ANSWER. Main cannot see
    // a throw here — it only sees silence, which it remembers as "a session
    // may exist" and will not let the user retry. The bridge throwing
    // synchronously on an unclonable payload is the realistic one.
    answer({ ok: false, reason: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Handle a `spawn_session` MCP call: create a fresh primary Claude session
 * seeded with the agent-authored brief. Launches at the project root (shared
 * Claude memory, like every Claude session); the workspace points at the named
 * worktree, else the caller's current worktree, else the main worktree. When
 * the caller didn't override the model, the new session inherits the caller's
 * (the bridge only knows the terminal id — model is renderer state).
 */
async function spawnSessionFromAgent(
  data: import('../../shared/ipc-types').AgentPanelEventMap['agent-session:spawn'],
): Promise<void> {
  const caller = findSession(data.sourceTerminalId)
  const worktreePath = data.worktreePath ?? caller?.worktreePath ?? mainWorktree()?.path
  if (!worktreePath) return
  const launchDir = projectRoot() ?? worktreePath

  const provider = data.provider ?? caller?.provider ?? 'claude'
  let target: InteractiveTarget
  if (provider !== 'claude') {
    // Every non-Claude provider names its model by bare native id, so the
    // caller's own target can be inherited whenever it is also a native-id
    // target — regardless of which agent it is. Inheriting across a *different*
    // native provider would be wrong (an OpenCode id means nothing to Codex),
    // hence the provider match rather than a plain "not claude" check.
    const inherited = caller?.target?.provider === provider ? caller.target : undefined
    target = {
      provider,
      ...(data.model ?? inherited?.model ? { model: data.model ?? inherited?.model } : {}),
      ...(data.reasoningEffort ?? inherited?.reasoningEffort
        ? { reasoningEffort: data.reasoningEffort ?? inherited?.reasoningEffort }
        : {}),
    }
  } else {
    let model: ModelRef | undefined = caller?.model
    if (data.model) {
      const agentModels = await loadAgentModels().catch(() => [])
      model = agentModels.find((m) => m.ref?.model === data.model || m.id === data.model)?.ref ?? { provider: 'anthropic', model: data.model }
    }
    target = { provider: 'claude', ...(model ? { model } : {}) }
  }

  const spawnOpts = {
    initialPrompt: data.brief,
    ...(data.label ? { label: data.label } : {}),
    ...(target.provider === 'claude' && target.model ? { model: target.model } : {}),
  }

  // 'replace' = the caller asked to reset itself: spawn the successor in the
  // caller's slot and dispose the caller. Falls back to a plain new-pane spawn
  // when the caller can't be located (nothing to replace).
  const newId =
    data.target === 'replace' && caller
      ? sessionsStore.replaceWithAgent(caller.id, target, launchDir, worktreePath, spawnOpts)
      : sessionsStore.createAgent(target, launchDir, worktreePath, spawnOpts)

  // Hand the minted id back so the waiting `spawn_session` tool call can return
  // an addressable handle — main never sees this id otherwise.
  if (data.correlationId && newId) {
    const created = sessionsStore.get(newId)
    void window.api.invoke('agent-bus:spawned', data.correlationId, {
      terminalId: newId,
      label: created?.label ?? newId,
      provider: created?.provider ?? provider,
      worktreePath: created?.worktreePath ?? worktreePath,
      status: 'unknown',
    })
  }
}

/**
 * The peer set the messaging bus exposes to agents. Only live agent-backed
 * sessions qualify: a plain terminal has nothing to talk to, and a
 * pendingResume/exited entry has no process behind it, so addressing one would
 * queue mail that can never be delivered.
 */
function peerSnapshot(): AgentPeer[] {
  return _sessions
    // 'agent' covers every provider. Agent View ('agents') is excluded on
    // purpose: it's a bare TUI with no hook wiring to deliver mail through.
    .filter((s) => s.kind === 'agent' && !s.pendingResume && !s.exited)
    .map((s) => ({
      terminalId: s.id,
      label: s.label,
      provider: s.provider ?? 'claude',
      worktreePath: s.worktreePath,
      status: getAgentStatusForTerminal(s.id),
    }))
}

/**
 * The window's session list as anything ELSE attached to this window sees it —
 * a second desktop window, or a phone on the same hub.
 *
 * Broader than `peerSnapshot`: a plain terminal and an Agent View can't receive
 * mail, but they are sessions you can look at, so they belong on a list whose
 * job is "pick something to attend to". `pendingResume` entries are left out —
 * they have no PTY behind them, so a client that picked one would attach to
 * nothing.
 */
/**
 * The repo trail in the shape a client that is not this renderer can use.
 *
 * Built from the very functions the desktop repo and worktree pickers read, so
 * a second client's pickers cannot list a different set of places than the
 * sidebar does.
 */
function trailFor(session: Session): SessionRepoTrail[] {
  return touchedReposForSession(session).map((repoPath) => ({
    repoPath,
    worktrees: touchedWorktreesForRepo(session, repoPath),
  }))
}

function windowSessionSnapshot(): WindowSessionInput[] {
  return _sessions
    .filter((s) => !s.pendingResume)
    .map((s) => ({
      terminalId: s.id,
      label: s.label,
      kind: s.kind,
      provider: s.provider,
      worktreePath: s.worktreePath,
      status: s.exited ? ('exited' as const) : getAgentStatusForTerminal(s.id),
      trail: trailFor(s),
    }))
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

  // Provider session identity, pinned up front (Claude) or learned from hooks (Codex).
  const offSessionId = window.api.on('agent:session-id', (data) => {
    sessionsStore.update(data.terminalId, { providerSessionId: data.sessionId, reportingSetupNeeded: false })
  })

  // The agent's own name for the conversation, for providers that report one
  // out-of-band (`reportsSessionTitle`) rather than via the terminal title.
  const offSessionTitle = window.api.on('agent:session-title', (data) => {
    sessionsStore.applySessionTitle(data.terminalId, data.title)
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

  // spawn_session MCP call: an agent asked to start a fresh primary session.
  const offSpawn = window.api.on('agent-session:spawn', (data) => {
    void spawnSessionFromAgent(data)
  })

  // A client with no session of its own (the phone) asked to start one.
  const offCreate = window.api.on('session:create-request', (data) => {
    void createSessionFromBrief(data)
  })

  // Keep the messaging bus's peer list current. Labels, provider and status live
  // here, so main can't derive them — this pushes a fresh snapshot whenever any
  // of them changes. $effect.root because this runs outside a component.
  const stopPeerSync = $effect.root(() => {
    $effect(() => {
      if (!_hydrated) return
      void window.api.invoke('agent-bus:sync', peerSnapshot())
    })
    // The same push, for the wider list a second client renders. Main drops it
    // when nothing changed, so sharing the effect's firing rate costs nothing.
    $effect(() => {
      void window.api.invoke('session:sync', windowSessionSnapshot())
    })
  })

  return () => {
    offExit()
    offSessionId()
    offSessionTitle()
    offCwd()
    offRepoTouch()
    offSpawn()
    offCreate()
    stopPeerSync()
  }
}
