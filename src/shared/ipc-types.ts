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

export interface WorktreeInvokeMap {
  'worktree:list': { args: []; result: WorktreeInfo[] }
  'worktree:create': { args: [name: string, baseBranch?: string]; result: WorktreeInfo }
  'worktree:checkout': { args: [branch: string]; result: WorktreeInfo }
  'worktree:branches': { args: []; result: BranchInfo[] }
  'worktree:remove': { args: [path: string]; result: void }
}

export interface WorktreeEventMap {
  'worktree:changed': WorktreeInfo[]
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
}

export interface PtyEventMap {
  'pty:data': { id: string; data: string }
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

// ── Plan ─────────────────────────────────────────────────
export type PlanReaction = 'thumbs-up' | 'thumbs-down' | 'question' | 'rocket' | 'eyes'

export interface PlanDiscussionMessage {
  id: string
  taskId: string
  role: 'user' | 'assistant'
  text: string
}

export interface PlanTask {
  id: string
  title: string
  description: string
  affectedFiles?: string[]
  status: 'todo' | 'in-progress' | 'done' | 'rejected'
  reactions: PlanReaction[]
  discussion: PlanDiscussionMessage[]
}

export interface Plan {
  overview: string
  tasks: PlanTask[]
}

export type PlanStatus = 'idle' | 'running' | 'revising' | 'done' | 'error'

export interface PlanInvokeMap {
  'plan:start': { args: [worktreePath: string, commitHash: string | null]; result: void }
  'plan:start-from-description': { args: [worktreePath: string, description: string]; result: void }
  'plan:cancel': { args: [worktreePath: string, commitHash: string | null]; result: void }
  'plan:load': { args: [worktreePath: string, commitHash: string | null]; result: Plan | null }
  'plan:save': { args: [worktreePath: string, commitHash: string | null, plan: Plan]; result: void }
  'plan:revise': { args: [worktreePath: string, commitHash: string | null, feedback: string]; result: void }
  'plan:latest-claude': { args: [worktreePath: string]; result: string | null }
}

export interface PlanEventMap {
  'plan:overview': { key: string; overview: string }
  'plan:task': { key: string; task: PlanTask }
  'plan:status': { key: string; status: PlanStatus; error?: string }
  'plan:from-claude': { key: string; terminalId: string; plan: Plan }
}

// ── Session save/restore ─────────────────────────────────
/**
 * Per-repo persisted snapshot of what was open last time the user quit.
 * Restored on next launch so engineers don't have to manually reopen tabs
 * or `/resume` Claude sessions across worktrees.
 */
export type SerializedTab =
  | { kind: 'file'; id: string; path: string }
  | { kind: 'diff'; id: string; commitHash: string | null; commitMessage: string }
  | { kind: 'tour'; id: string; commitHash: string | null; commitMessage: string }
  | { kind: 'plan'; id: string; planHash: string; label: string; claudeTerminalId: string | null }

/**
 * A Claude Code session that was running when SimpleEdit was last closed.
 * On restore, these come back as placeholder tabs the user clicks to resume
 * (avoids spawning N concurrent claude processes on launch). Plain terminals
 * are not persisted — each pane auto-spawns one on mount.
 */
export interface SerializedClaudeSession {
  /** UI label as last observed (e.g. "Claude" or a session-derived title). */
  label: string
  /** Pinned at spawn via `claude --session-id <uuid>`. Required to `--resume`. */
  sessionId?: string
  /**
   * True for `claude agents` (Agent View) tabs. Those tabs don't emit a
   * session-id, so on restore we respawn a fresh `claude agents` instead of
   * trying to resume — best-effort restoration, position + label only.
   */
  isAgentView?: boolean
  /**
   * True when the user explicitly renamed the tab via the context menu. The
   * label then becomes sticky — `handleTitleChange` early-returns, so a
   * subsequent xterm OSC title from Claude won't overwrite the user's choice.
   */
  customLabel?: boolean
}

export interface SerializedWorktreeState {
  worktreePath: string
  tabs: SerializedTab[]
  activeTabId: string | null
  mru: string[]
  unread: string[]
  /** Claude sessions that lived in the primary pane's terminal list. */
  primaryClaudeSessions: SerializedClaudeSession[]
  /** Claude sessions that lived in the secondary pane's terminal list. */
  secondaryClaudeSessions: SerializedClaudeSession[]
}

export interface SerializedSession {
  version: 1
  repoPath: string
  savedAt: string
  layout: {
    primaryWorktreePath: string | null
    secondaryWorktreePath: string | null
    focusedPane: 'primary' | 'secondary'
    splitRatio: number
    visitedPrimary: string[]
    visitedSecondary: string[]
  }
  worktreeStates: SerializedWorktreeState[]
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
  PlanInvokeMap &
  LspInvokeMap &
  SessionInvokeMap

export type SendMap = LspSendMap

export type EventMap = WorktreeEventMap &
  PtyEventMap &
  ClaudeEventMap &
  GitEventMap &
  ReviewEventMap &
  TourEventMap &
  PlanEventMap &
  LspEventMap &
  AgentPanelEventMap
