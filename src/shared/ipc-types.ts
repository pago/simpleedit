/**
 * All IPC channel definitions. Each feature uses a namespaced prefix.
 * Renderer → Main: invoke channels (request/response)
 * Main → Renderer: event channels (push)
 */

import type { Spec } from './gen-ui-catalog'

// ── Worktree ──────────────────────────────────────────────
export interface WorktreeInfo {
  path: string
  branch: string
  isMain: boolean
  isCurrent: boolean
}

// All worktree handlers take an OPTIONAL trailing `repoPath` (the bare repo to
// target). Omitted → the window's primary repo (single-repo fallback); present
// → a session pointed at another bare repo (multi-repo, Stage 4).
export interface WorktreeInvokeMap {
  'worktree:list': { args: [repoPath?: string]; result: WorktreeInfo[] }
  'worktree:create': { args: [name: string, baseBranch?: string, repoPath?: string]; result: WorktreeInfo }
  'worktree:checkout': { args: [branch: string, repoPath?: string]; result: WorktreeInfo }
  'worktree:branches': { args: [repoPath?: string]; result: BranchInfo[] }
  'worktree:remove': { args: [path: string, repoPath?: string]; result: void }
  /** Start/stop watching the project root for externally-created/removed worktrees (#120). */
  'worktree:watch': { args: [repoPath?: string]; result: void }
  'worktree:unwatch': { args: [repoPath?: string]; result: void }
}

export interface WorktreeEventMap {
  'worktree:changed': WorktreeInfo[]
  /**
   * Fired when a worktree is added/removed/moved outside SimpleEdit. Carries
   * the bare repo path of the affected window; the renderer responds by
   * re-running `refreshWorktrees()`.
   */
  'worktree:list-changed': { repoPath: string }
}

// ── PTY / Terminal ────────────────────────────────────────
export interface PtySpawnOptions {
  worktreePath: string
  id: string
}

export interface BranchInfo {
  name: string
  isRemote: boolean // true = exists only on origin, not as a local branch
}

export interface PtyInvokeMap {
  'pty:spawn': { args: [options: PtySpawnOptions]; result: void }
  'pty:write': { args: [id: string, data: string]; result: void }
  'pty:resize': { args: [id: string, cols: number, rows: number]; result: void }
  'pty:kill': { args: [id: string]; result: void }
  'pty:active-ids': { args: []; result: string[] }
  /** Replay buffer for output emitted before the renderer's xterm attached
   * (or before a fast-crashing process died). Offsets are absolute bytes
   * since spawn; `data` covers [start, end). */
  'pty:backlog': { args: [id: string]; result: { data: string; start: number; end: number } }
}

export interface PtyEventMap {
  /** `offset`: absolute byte position of this chunk since spawn — lets the
   * renderer dedup live chunks against the pty:backlog replay. */
  'pty:data': { id: string; data: string; offset: number }
  'pty:exit': { id: string; exitCode: number }
}

// ── File system ───────────────────────────────────────────
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: FileEntry[]
}

export interface FsInvokeMap {
  'fs:list': { args: [dirPath: string]; result: FileEntry[] }
  'fs:list-all': { args: [worktreePath: string]; result: string[] }
  'fs:read': { args: [filePath: string]; result: string }
  'fs:write': { args: [filePath: string, content: string]; result: void }
  'fs:create-file': { args: [filePath: string]; result: void }
  'fs:create-dir': { args: [dirPath: string]; result: void }
  'fs:rename': { args: [oldPath: string, newPath: string]; result: void }
  'fs:delete': { args: [filePath: string]; result: void }
}

// ── Editor ────────────────────────────────────────────────
export interface EditorInvokeMap {
  'editor:open': { args: [filePath: string]; result: string }
  'editor:save': { args: [filePath: string, content: string]; result: void }
  'editor:watch': { args: [filePath: string]; result: void }
  'editor:unwatch': { args: [filePath: string]; result: void }
}

export interface EditorEventMap {
  'editor:file-changed': { filePath: string }
}

// ── Git ───────────────────────────────────────────────────
export interface GitCommitInfo {
  hash: string
  message: string
  author: string
  date: string
}

export interface DiffFileEntry {
  path: string
  status: 'added' | 'modified' | 'deleted'
}

export interface GitInvokeMap {
  'git:log': { args: [worktreePath: string, count?: number]; result: GitCommitInfo[] }
  'git:diff': { args: [worktreePath: string, commitHash: string]; result: string }
  'git:commit-files': { args: [worktreePath: string, commitHash: string]; result: DiffFileEntry[] }
  'git:file-at-commit': { args: [worktreePath: string, commitHash: string, filePath: string]; result: string }
  'git:staging-files': { args: [worktreePath: string]; result: DiffFileEntry[] }
  'git:staging-diff': { args: [worktreePath: string]; result: string }
  'git:file-at-head': { args: [worktreePath: string, filePath: string]; result: string }
  'git:watch': { args: [worktreePath: string]; result: void }
  'git:unwatch': { args: [worktreePath: string]; result: void }
  'git:branch-diff': { args: [worktreePath: string]; result: string }
  'git:branch-files': { args: [worktreePath: string]; result: DiffFileEntry[] }
  'git:file-at-branch-base': { args: [worktreePath: string, filePath: string]; result: string }
}

export interface GitEventMap {
  'git:refs-changed': { worktreePath: string }
  'git:status-changed': { worktreePath: string }
}

// ── Claude stream ─────────────────────────────────────────
export type ClaudeStatus = 'idle' | 'running' | 'waiting' | 'error'

export interface ClaudeSpawnOptions extends PtySpawnOptions {
  /** When set, claude is launched with `--resume <id>` to restore a prior session. */
  resumeSessionId?: string
}

export interface ClaudeInvokeMap {
  'claude:spawn': { args: [options: ClaudeSpawnOptions]; result: void }
  /**
   * Spawn `claude agents` (the interactive TUI) without stream-json parsing.
   * Used by the Agent View menu entry on the new-Claude button. No session-id
   * capture, no MCP bridge config — those only make sense for stream-json mode.
   */
  'claude:spawn-agents': { args: [options: PtySpawnOptions]; result: void }
  'claude:attach': { args: [terminalId: string, worktreePath: string]; result: void }
  'claude:detach': { args: [terminalId: string]; result: void }
  /**
   * Fork a Claude session into another worktree of the same repo. Copies the
   * source session's JSONL (and any subagent subdir) into the target's project
   * dir, then spawns a new PTY there with --resume + --fork-session + a
   * pre-minted forkUuid. Caller pre-creates a placeholder tab and listens on
   * `claude:fork-result` for success/failure.
   */
  'claude:fork': {
    args: [options: ClaudeForkOptions]
    result: void
  }
}

export interface ClaudeForkOptions {
  /** Terminal id of the source Claude tab being forked from. */
  sourceTerminalId: string
  /** Source session id, used as the --resume arg. */
  sourceSessionId: string
  /** Source worktree path (where the source JSONL lives). */
  sourceWorktreePath: string
  /** Target worktree path where the new PTY will run. */
  targetWorktreePath: string
  /** SimpleEdit-minted UUID for the new (forked) session. */
  forkUuid: string
  /** Terminal id the placeholder tab is using; the new PTY uses this id. */
  placeholderTabId: string
}

export interface ClaudeEventMap {
  'claude:status': { worktreePath: string; status: ClaudeStatus; terminalId: string }
  'claude:session-id': { terminalId: string; sessionId: string }
  /**
   * The session's tracked working directory changed (from a hook POST). When
   * `cwd` falls inside a worktree of the session's repo, `worktreePath` is that
   * worktree (so the renderer can repoint the workspace); otherwise it's null.
   *
   * `repoPath` is the bare repo that contains `cwd`, resolved even when the
   * window had never opened that repo before (the agent roamed into a fresh
   * repo). Null when the cwd couldn't be resolved to a bare repo at all. The
   * renderer uses it to register the repo and record it on the session's
   * touched trail so it appears in the repo picker.
   */
  'claude:cwd': {
    terminalId: string
    cwd: string
    worktreePath: string | null
    repoPath: string | null
  }
  /**
   * Fork operation outcome. `placeholderTabId` matches the id the renderer
   * used in `claude:fork`, so it can locate the placeholder tab to transition
   * (success) or mark errored (failure).
   */
  'claude:fork-result':
    | { placeholderTabId: string; ok: true }
    | { placeholderTabId: string; ok: false; error: string }
}

// ── Review ────────────────────────────────────────────────
export type ConventionalCommentLabel =
  | 'praise' | 'nitpick' | 'suggestion' | 'issue'
  | 'question' | 'thought' | 'chore'

export type ReviewFindingDecoration = 'blocking' | 'non-blocking' | 'if-minor'

export interface ReviewFinding {
  id: string
  label: ConventionalCommentLabel
  decoration?: ReviewFindingDecoration
  file: string
  lineRange: [number, number]
  title: string
  body: string
}

export type ReviewStatus = 'idle' | 'running' | 'done' | 'error'

export interface ReviewInvokeMap {
  'review:start': { args: [worktreePath: string, commitHash: string | null]; result: void }
  'review:cancel': { args: [worktreePath: string, commitHash: string | null]; result: void }
}

export interface ReviewEventMap {
  'review:finding': { key: string; finding: ReviewFinding }
  'review:status': { key: string; status: ReviewStatus; error?: string }
}

// ── Tour ─────────────────────────────────────────────────
export interface TourSegment {
  prose: string
  file: string
  lineRange: [number, number]
}

export interface TourTopic {
  id: string
  title: string
  summary: string
  segments: TourSegment[]
}

export interface Tour {
  overview: string
  topics: TourTopic[]
  openQuestions?: string[]
}

export type TourStatus = 'idle' | 'running' | 'done' | 'error'

export interface TourInvokeMap {
  'tour:start': { args: [worktreePath: string, commitHash: string | null, overrideOverview?: string]; result: void }
  'tour:cancel': { args: [worktreePath: string, commitHash: string | null]; result: void }
  'tour:load': { args: [worktreePath: string, commitHash: string | null]; result: Tour | null }
  'tour:save-overview': { args: [worktreePath: string, commitHash: string | null, overview: string]; result: void }
}

export interface TourEventMap {
  'tour:overview': { key: string; overview: string }
  'tour:topic': { key: string; topic: TourTopic }
  'tour:status': { key: string; status: TourStatus; error?: string }
  'tour:from-claude': {
    key: string
    terminalId: string
    worktreePath: string
    commitHash: string | null
    tour: Tour
  }
}

// ── Session save/restore ─────────────────────────────────
/**
 * Per-repo persisted snapshot of what was open last time the user quit.
 * Restored on next launch: agent sessions come back as click-to-resume
 * entries in the sessions panel, each with its workspace tabs. Plain
 * terminals are not persisted (a dead shell can't resume).
 */
export type SerializedTab =
  | { kind: 'file'; id: string; path: string }
  | { kind: 'diff'; id: string; worktreePath: string; commitHash: string | null; commitMessage: string }
  | { kind: 'tour'; id: string; worktreePath: string; commitHash: string | null; commitMessage: string }

/** One persisted agent session plus its workspace state. */
export interface SerializedAgentSession {
  kind: 'claude' | 'agents'
  /** UI label as last observed (OSC title or user rename). */
  label: string
  /** True when the user renamed the session — the label is sticky. */
  customLabel?: boolean
  /**
   * Claude session uuid, pinned at spawn via `claude --session-id <uuid>`.
   * Required to `--resume`. Absent for Agent View sessions (the TUI emits no
   * session-id) — those respawn fresh instead.
   */
  sessionId?: string
  /**
   * Directory the PTY spawned in (project root for Claude sessions — the
   * shared Claude memory home). Resume respawns here. Falls back to
   * `worktreePath` when absent (blobs from before the field existed).
   */
  launchDir?: string
  /** The worktree the session's workspace was pointed at. */
  worktreePath: string
  /**
   * The bare repo `worktreePath` belongs to (Stage 4 multi-repo). Absent =
   * the window's primary repo (single-repo default). When set to a non-primary
   * repo, restore keeps the workspace pointed there rather than remapping to
   * the primary repo's main worktree.
   */
  repoPath?: string
  /**
   * Worktrees this session has worked in, most-recently-touched first (the
   * agent's location trail). Drives the repo picker (distinct repos, in touch
   * order) and the worktree picker's "touched" group. Restored so the pickers
   * survive a restart rather than rebuilding only as the agent moves again.
   */
  touchedWorktrees?: string[]
  tabs: SerializedTab[]
  activeTabId: string | null
  unread: string[]
}

export interface SerializedSession {
  version: 2
  repoPath: string
  savedAt: string
  /** Sidebar order. */
  sessions: SerializedAgentSession[]
  /** Index into `sessions` of the entry that was active, if any. */
  activeIndex: number | null
}

export interface SessionInvokeMap {
  'session:save': { args: [payload: SerializedSession]; result: void }
  'session:load': { args: [repoPath: string]; result: SerializedSession | null }
  'session:clear': { args: [repoPath: string]; result: void }
}

// ── App-level ─────────────────────────────────────────────
export interface RecentRepo {
  path: string
  name: string
  lastOpened: string // ISO date
}

export interface AppInvokeMap {
  'app:get-repo': { args: []; result: string | null }
  'app:set-repo': { args: [repoPath: string]; result: void }
  'app:pick-repo': { args: []; result: string | null }
  'app:pick-directory': { args: []; result: string | null }
  'app:clone-repo': { args: [repoUrl: string, parentDir: string]; result: string }
  'app:recent-repos': { args: []; result: RecentRepo[] }
  'app:open-window': { args: [repoPath?: string]; result: void }
  'app:open-external': { args: [url: string]; result: void }
  'app:save-dropped-blob': { args: [filename: string, bytes: Uint8Array]; result: string }
}

// ── LSP ───────────────────────────────────────────────────
/** Opaque JSON-RPC message passed between renderer and LSP server */
export type JsonRpcMessage = Record<string, unknown>

export interface LspInvokeMap {
  'lsp:start': {
    args: [{ language: string; rootUri: string }]
    result:
      | { serverId: string; initializationOptions: Record<string, unknown> | undefined }
      | { serverId: null; reason: string }
  }
  'lsp:stop': { args: [{ serverId: string }]; result: void }
}

/** Fire-and-forget messages from renderer → main (no response) */
export interface LspSendMap {
  'lsp:send': { serverId: string; message: JsonRpcMessage }
}

export interface LspEventMap {
  'lsp:message': { serverId: string; message: JsonRpcMessage }
  'lsp:server-exit': { serverId: string; code: number | null }
}

// ── AgentPanel (gen-ui composed panels) ───────────────────

export interface AgentPanelEventMap {
  'agent-panel:open': {
    spec: Spec
    title: string
    worktreePath: string
    sourceTerminalId: string
  }
  /**
   * `open_worktree` MCP tool: repoint the calling session's workspace at a
   * worktree (already validated against the repo's worktree list main-side).
   */
  'agent-workspace:open-worktree': {
    sourceTerminalId: string
    worktreePath: string
  }
  /**
   * `show_diff` MCP tool: open a diff tab in the calling session's workspace.
   * `commitHash` follows the in-app convention: null = staging/uncommitted,
   * 'branch' = branch-base diff, otherwise a commit SHA.
   */
  'agent-workspace:show-diff': {
    sourceTerminalId: string
    worktreePath: string
    commitHash: string | null
  }
}

// ── Auto-update ──────────────────────────────────────────
export interface UpdateInfo {
  version: string
  releaseNotes?: string
}

export interface UpdateInvokeMap {
  'update:check': { args: []; result: void }
  'update:install': { args: []; result: void }
}

export interface UpdateEventMap {
  'update:available': UpdateInfo
  'update:downloaded': UpdateInfo
  'update:error': { message: string }
}

// ── Aggregate maps for type-safe IPC helpers ──────────────
export type InvokeMap = WorktreeInvokeMap &
  PtyInvokeMap &
  FsInvokeMap &
  EditorInvokeMap &
  GitInvokeMap &
  ClaudeInvokeMap &
  AppInvokeMap &
  ReviewInvokeMap &
  TourInvokeMap &
  LspInvokeMap &
  SessionInvokeMap &
  UpdateInvokeMap

export type SendMap = LspSendMap

export type EventMap = WorktreeEventMap &
  PtyEventMap &
  ClaudeEventMap &
  GitEventMap &
  ReviewEventMap &
  TourEventMap &
  LspEventMap &
  AgentPanelEventMap &
  UpdateEventMap &
  EditorEventMap
