/**
 * All IPC channel definitions. Each feature uses a namespaced prefix.
 * Renderer → Main: invoke channels (request/response)
 * Main → Renderer: event channels (push)
 */

import type { Spec } from './gen-ui-catalog'
import type { PrRef, PrContext, ScreenPrCard, DeepLensId, DeepFinding, DeepReviewStatus, DeepLensStatus, PrReviewDraft } from './screenprs'

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

// ── Interactive agents ────────────────────────────────────
export type AgentProviderId = 'claude' | 'codex'
export type AgentStatus = 'initializing' | 'idle' | 'running' | 'waiting' | 'error' | 'exited'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/**
 * Every effort we recognise, for validating values that arrive from outside.
 * Codex's app-server schema types `reasoningEffort` as an open, non-empty
 * string, so a new value can appear at any time — `isReasoningEffort` keeps it
 * from being cast blindly into the union above.
 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

export type InteractiveTarget =
  | { provider: 'claude'; model?: ModelRef }
  | { provider: 'codex'; model?: string; reasoningEffort?: ReasoningEffort }

export interface AgentSpawnOptions extends PtySpawnOptions {
  target: InteractiveTarget
  /** When set, claude is launched with `--resume <id>` to restore a prior session. */
  resumeSessionId?: string
  /**
   * Full-context in-place fork: with `resumeSessionId`, launch a FRESH session
   * id that forks the source (`--session-id <new> --resume <src> --fork-session`)
   * instead of appending to it. Distinct from a plain resume, which reuses the
   * source id and continues it. Requires `resumeSessionId`.
   */
  forkSession?: boolean
  /** Seed the session with this first message (positional prompt) — e.g. a PR
   *  review brief for "Discuss with Agent". Fresh spawn only. */
  initialPrompt?: string
  /**
   * Which brain to launch against (fresh spawn only). `ollama` points the
   * harness at a local endpoint via an inline env override; `anthropic` adds
   * `--model` with normal cloud auth. Absent = cloud default.
   */
  model?: ModelRef
}

export interface AgentInvokeMap {
  'agent:spawn': { args: [options: AgentSpawnOptions]; result: void }
  /**
   * Spawn `claude agents` (the interactive TUI) without stream-json parsing.
   * Used by the Agent View menu entry on the new-Claude button. No session-id
   * capture, no MCP bridge config — those only make sense for stream-json mode.
   */
  'agent:spawn-agents': { args: [options: PtySpawnOptions]; result: void }
  'agent:attach': { args: [terminalId: string, worktreePath: string]; result: void }
  'agent:detach': { args: [terminalId: string]; result: void }
  'agent:capabilities': { args: [provider: AgentProviderId]; result: AgentCapabilities }
  'agent:available': { args: [provider: AgentProviderId]; result: boolean }
  /** Ids of every registered provider, for capability discovery at startup. */
  'agent:providers': { args: []; result: AgentProviderId[] }
}

/**
 * What a provider's agent can do, so the UI adapts without naming providers.
 * Every renderer branch that would otherwise read `provider === 'codex'`
 * belongs here instead — that is what lets a new provider (OpenCode, …) drop in
 * by registering a descriptor rather than by editing components.
 */
export interface AgentCapabilities {
  status: 'precise' | 'osc' | 'basic'
  resume: boolean
  fork: boolean
  tracking: 'full' | 'cwd-only' | 'none'
  mcp: boolean
  modelOverride: 'env' | 'native' | 'none'
  /**
   * How Shift+Enter must reach the agent. `escape-newline` needs the CSI-u
   * sequence written to the PTY (the agent would otherwise submit the turn);
   * `native` means the agent's own TUI already handles it, so don't intercept.
   */
  shiftEnter: 'native' | 'escape-newline'
  /**
   * How dropped file paths should be formatted for the agent's prompt.
   * `at-reference` = `@path` space-joined; `newline-list` = newline-joined
   * (parsed by regex); `shell-escaped` = quoted and space-joined, for a plain
   * shell where a literal newline would submit.
   */
  droppedPath: 'at-reference' | 'newline-list' | 'shell-escaped'
  gracefulShutdown: boolean
  /** Human-facing provider name for labels, tooltips and empty states. */
  displayName: string
  /**
   * What the agent puts in the terminal's OSC title. `session-label` means it's
   * a meaningful name we can show as the session's label (Claude writes the
   * conversation name); `directory` means it's just the cwd — possibly with a
   * spinner glyph — so it must NOT overwrite the session label.
   */
  oscTitle: 'session-label' | 'directory'
  /**
   * Whether lifecycle reporting works as soon as we launch, or needs a one-time
   * grant from the user. Codex is `user-granted`: it refuses to run our hooks
   * until their command hash is trusted, so status, session identity and cwd
   * tracking stay degraded until the user allows them once.
   */
  reportingSetup: 'automatic' | 'user-granted'
}

export interface AgentEventMap {
  'agent:status': { worktreePath: string; status: AgentStatus; terminalId: string; precise: boolean; message?: string }
  'agent:session-id': { terminalId: string; sessionId: string }
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
  'session:cwd': {
    terminalId: string
    cwd: string
    worktreePath: string | null
    repoPath: string | null
  }
  /**
   * The session touched a file in a worktree its `cwd` is NOT inside — the
   * agent read or edited a file in a sibling repo without `cd`-ing there. The
   * renderer registers the repo and records it on the session's touched trail
   * (so it appears in the repo picker) WITHOUT repointing the workspace view —
   * a glance at another repo shouldn't move what the user is looking at.
   *
   * `repoPath` is the bare repo when it was freshly discovered (so the renderer
   * can cache its worktrees), else null. `worktreePath` is always the resolved
   * worktree the touched file lives in.
   */
  'session:repo-touch': {
    terminalId: string
    worktreePath: string
    repoPath: string | null
  }
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

export interface ScreenPrsFilters {
  /** GitHub org to scope to; omitted = all orgs where the user is a reviewer. */
  owner?: string
  /** Only PRs updated on/after this YYYY-MM-DD (the activity cutoff). */
  updatedSince?: string
  /** Bypass the triage cache and re-run every PR (⌥-click Re-screen). */
  force?: boolean
}

export type ScreenPrsRunStatus = 'running' | 'done' | 'error'

export interface ScreenPrsInvokeMap {
  'screenprs:start': { args: [filters: ScreenPrsFilters]; result: void }
  'screenprs:cancel': { args: []; result: void }
  /** Run a deep review on one PR (full context is passed — triage doesn't retain it). */
  'screenprs:deep-start': { args: [context: PrContext]; result: void }
  'screenprs:deep-cancel': { args: [url: string]; result: void }
  /** Post a review to GitHub — the composer's write path (guarded by a confirm). */
  'screenprs:submit-review': { args: [request: SubmitReviewRequest]; result: SubmitReviewResult }
}

/** Identify the PR + the composed review to post. */
export interface SubmitReviewRequest {
  pr: Pick<PrRef, 'owner' | 'repo' | 'number' | 'url'>
  draft: PrReviewDraft
}

export type SubmitReviewResult =
  | { ok: true; reviewUrl?: string; foldedComments: boolean }
  | { ok: false; error: string }

export interface ScreenPrsEventMap {
  /** The queue is known (right after search): seed placeholders before gathering. */
  'screenprs:queued': { refs: PrRef[] }
  /** A PR's context is gathered; the placeholder gains size/CI/reviewers (and is
   *  now "scheduled" — waiting for the triage model). */
  'screenprs:screening': { context: PrContext }
  /** The triage model has *started* on this PR (vs. merely scheduled). */
  'screenprs:triaging': { url: string }
  /** A PR finished triage — full card with its derived bucket. */
  'screenprs:card': { card: ScreenPrCard }
  'screenprs:status': { status: ScreenPrsRunStatus; error?: string; total?: number }
  /** Per-lens progress for a PR's deep review (keyed by the PR url). */
  'screenprs:deep-lens': { url: string; lens: DeepLensId; status: DeepLensStatus }
  /** The synthesized, curated deep-review findings for a PR. */
  'screenprs:deep-result': { url: string; findings: DeepFinding[] }
  'screenprs:deep-status': { url: string; status: DeepReviewStatus; error?: string }
}

export interface TourEventMap {
  'tour:overview': { key: string; overview: string }
  'tour:topic': { key: string; topic: TourTopic }
  'tour:status': { key: string; status: TourStatus; error?: string }
  'tour:from-agent': {
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
  kind: 'agent' | 'agents' | 'claude'
  /** `claude` kind is accepted only for v2/v3 migration. */
  provider?: AgentProviderId
  target?: InteractiveTarget
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
  model?: string
  reasoningEffort?: ReasoningEffort
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
  /**
   * The session group this entry belongs to (a `SerializedGroup.id`), or absent
   * when standalone. Members of a group are kept contiguous in `sessions`.
   */
  groupId?: string
  /**
   * The session's opening prompt (`createClaude`'s `initialPrompt`), so the
   * handoff composer can recover the GOAL of a restored session without
   * re-reading the JSONL transcript. Absent for sessions launched with no seed
   * prompt. Eviction is structural: the blob is rebuilt from the live
   * persistable sessions on each save, so a closed session's seed prompt drops
   * out on the next save — it is never retained past the session's lifetime.
   */
  seedPrompt?: string
  tabs: SerializedTab[]
  activeTabId: string | null
  unread: string[]
}

/** A persisted session group (Edge-style tab group). */
export interface SerializedGroup {
  id: string
  name: string
  color: string
  collapsed: boolean
}

export interface SerializedSession {
  /** v4 introduces provider-aware agent sessions. */
  version: 2 | 3 | 4
  repoPath: string
  savedAt: string
  /** Sidebar order. */
  sessions: SerializedAgentSession[]
  /** Index into `sessions` of the entry that was active, if any. */
  activeIndex: number | null
  /** Session groups, in sidebar order. Absent in v2 blobs. */
  groups?: SerializedGroup[]
}

export interface SessionInvokeMap {
  'session:save': { args: [payload: SerializedSession]; result: void }
  'session:load': { args: [repoPath: string]; result: SerializedSession | null }
  'session:clear': { args: [repoPath: string]; result: void }
}

// ── Models (local Ollama + cloud Claude) ──────────────────
/**
 * Which brain a session runs against. `anthropic` uses normal cloud auth (no
 * env override); `ollama` points the harness at a local endpoint (defaults to
 * http://localhost:11434 when `endpoint` is absent).
 */
export type ModelRef =
  | { provider: 'anthropic'; model: string }
  | { provider: 'ollama'; model: string; endpoint?: string }
  | { provider: 'openai'; model?: string; reasoningEffort?: ReasoningEffort }

export type TaskTarget =
  | { runner: 'claude'; model?: string }
  | { runner: 'codex'; model?: string; reasoningEffort?: ReasoningEffort }
  | { runner: 'ollama'; model: string; endpoint?: string }

/** How well a model is expected to run on the current machine (see computeFit). */
export type ModelFit = 'fits' | 'marginal' | 'too-big'

/**
 * A model surfaced in the management UI. Covers both installed Ollama models
 * and curated recommendations; `installed` disambiguates. `minRamBytes` is an
 * estimate (params × bytes-per-param + context overhead) and may be absent when
 * we can't infer the parameter size.
 */
export interface ModelDescriptor {
  name: string
  paramSize?: string
  quantization?: string
  minRamBytes?: number
  fit: ModelFit
  installed: boolean
  toolCapable: boolean
}

/** A curated, not-necessarily-installed recommendation with display metadata. */
export interface RecommendedModel extends ModelDescriptor {
  label: string
  notes?: string
}

/**
 * A Claude cloud model offered in the picker. Doubles as an `anthropic` ModelRef
 * (`model` is the `--model` value) plus a human display name.
 */
export interface ClaudeModel {
  provider: 'anthropic'
  displayName: string
  model: string
}

export interface CodexModel {
  provider: 'openai'
  displayName: string
  model: string
  defaultReasoningEffort?: ReasoningEffort
  supportedReasoningEfforts: ReasoningEffort[]
  isDefault: boolean
}

/** Machine profile used to size recommendations. */
export interface HardwareInfo {
  totalRamBytes: number
  chip: string
  platform: string
}

/** Bounded features (plus interactive spawn) each get a per-feature default. */
export type ModelFeatureKey = 'review' | 'tour' | 'screenPrs' | 'interactive'

/** Per-lens deep-review setting: whether it runs, and (optionally) on which model.
 *  An unset `model` inherits the `screenPrs` default (so deep review is as local
 *  as triage unless a lens is explicitly escalated to cloud). */
export interface DeepLensSetting {
  enabled: boolean
  model?: ModelRef
}

/** Deep-review configuration: per-lens settings + the synthesis model. */
export interface DeepReviewConfig {
  lenses: Partial<Record<DeepLensId, DeepLensSetting>>
  /** Model for the synthesis/noise-kill reduce (defaults to the screenPrs model). */
  synthesisModel?: ModelRef
}

/** Persisted model preferences (userData/config/models.json). */
export interface ModelConfig {
  /** Per-feature default model. */
  defaults: Partial<Record<ModelFeatureKey, ModelRef>>
  /** Model names allowed to appear in the quick ✦ submenu. */
  submenuAllowlist: string[]
  /** The last model a session was launched against. */
  lastUsed?: ModelRef
  /** Deep-review lens config (Screen PRs). */
  deepReview?: DeepReviewConfig
}

/** One NDJSON progress line from `POST /api/pull`, forwarded to the renderer. */
export interface ModelPullProgress {
  name: string
  status: string
  completed?: number
  total?: number
}

export interface ModelsInvokeMap {
  /** Is Ollama reachable? Gates the whole local-model UI. */
  'models:available': { args: []; result: boolean }
  /** The static Claude cloud model list (always available). */
  'models:claude': { args: []; result: ClaudeModel[] }
  /** Best-effort dynamic catalog. Empty means use Codex's configured default. */
  'models:codex': { args: []; result: CodexModel[] }
  /** This machine's profile (chip + RAM), used to show fit/hardware hints. */
  'models:hardware': { args: []; result: HardwareInfo }
  /** All installed Ollama models, annotated with hardware fit + tool-capability. */
  'models:installed': { args: []; result: ModelDescriptor[] }
  /** Curated recommendations minus what's installed, annotated with fit. */
  'models:recommended': { args: []; result: RecommendedModel[] }
  /** Start a pull; streams `models:pull-progress`, resolves on completion. */
  'models:pull': { args: [name: string]; result: void }
  'models:config-get': { args: []; result: ModelConfig }
  'models:config-set': { args: [partial: Partial<ModelConfig>]; result: ModelConfig }
}

export interface ModelsEventMap {
  'models:pull-progress': ModelPullProgress
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
    /**
     * Worktree the panel's actions were validated against. The renderer routes
     * panels purely by `sourceTerminalId` and takes its git context from the
     * owning session, so this is currently informational on this side.
     */
    worktreePath: string
    sourceTerminalId: string
    /**
     * Agent-supplied panel identity. Distinct ids from one session coexist as
     * separate tabs; absent means replace-the-session's-panel-in-place.
     */
    panelId?: string
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
  /**
   * `spawn_session` MCP tool: create a NEW primary Claude session seeded with an
   * agent-authored brief (to hand off or fan out work). Unlike the other
   * agent-* events this creates a session rather than acting on the caller's
   * workspace, so it's handled by the global session listener, not
   * SessionWorkspace. The renderer reports the new session back via
   * `agent-bus:spawned` so the tool call can return an addressable handle.
   */
  'agent-session:spawn': {
    /** Terminal id of the session that called the tool (for model inheritance). */
    sourceTerminalId: string
    /** Becomes the new session's `initialPrompt` / persisted seed prompt. */
    brief: string
    /**
     * Echoed back through `agent-bus:spawned` to match the created session to
     * the waiting tool call. The renderer mints the terminal id, so this is the
     * only way the id can reach the caller.
     */
    correlationId?: string
    /** Optional sidebar label for the new session. */
    label?: string
    /** Optional model id override; when absent the caller's model is inherited. */
    model?: string
    /** Agent runtime. Omitted inherits the caller's complete target. */
    provider?: AgentProviderId
    /** Codex-only reasoning override. */
    reasoningEffort?: ReasoningEffort
    /**
     * Worktree the new session's workspace points at, validated against the
     * repo main-side. Absent = inherit the caller's current workspace worktree.
     */
    worktreePath?: string
    /**
     * 'new-pane' (default) = open alongside the caller (fan-out). 'replace' =
     * dispose the caller and take its slot (the in-place reset / hand-off).
     */
    target?: 'new-pane' | 'replace'
  }
}

// ── Agent-to-agent messaging ──────────────────────────────

/** One session addressable by another agent (renderer → main sync). */
export interface AgentPeer {
  terminalId: string
  label: string
  provider?: string
  worktreePath: string
  status: ClaudeStatus | 'unknown'
}

export interface AgentBusInvokeMap {
  /**
   * Push the current session list to the bus. The renderer owns labels,
   * provider and status, so main can't derive the peer list itself; this is
   * called whenever those change (and is idempotent — it replaces the set).
   */
  'agent-bus:sync': { args: [peers: AgentPeer[]]; result: void }
  /**
   * Report a session created for a `spawn_session` tool call, matching the
   * `correlationId` the bridge sent, so that call can return a usable handle.
   */
  'agent-bus:spawned': { args: [correlationId: string, peer: AgentPeer]; result: void }
}

export interface AgentBusEventMap {
  /** A message was sent between sessions — mirrored so the UI can show it. */
  'agent-message:sent': {
    messageId: string
    from: string
    fromLabel: string
    to: string
    text: string
    expectsReply: boolean
    replyTo?: string
  }
  /** Queued mail was handed to a session via its Stop hook. */
  'agent-message:delivered': {
    terminalId: string
    messageIds: string[]
  }
}

// ── Auto-update ──────────────────────────────────────────
/**
 * Deliberately spelled with the fully-qualified cask name. Homebrew 6 requires
 * non-official taps to be trusted before it will load them, and the *only*
 * exemption is naming the cask (or its tap) explicitly on the command line — so
 * `brew upgrade --cask simpleedit` fails for anyone who skipped
 * `brew trust pago/simpleedit`, while this form always works.
 */
export const BREW_UPGRADE_COMMAND = 'brew upgrade --cask pago/simpleedit/simpleedit'

export interface UpdateInfo {
  version: string
  releaseNotes?: string
  /**
   * Present only when this copy was installed by Homebrew. Such a copy can't be
   * replaced by electron-updater — Squirrel rejects the ad-hoc signature — and
   * `brew upgrade --cask simpleedit` owns it anyway, so the banner offers that
   * command instead of a restart.
   */
  managedByHomebrew?: boolean
}

export interface UpdateInstallResult {
  ok: boolean
  error?: string
}

/**
 * Which step failed. The renderer words the banner from this and ignores
 * `check` failures outright — a failed poll for updates is not something the
 * user asked for, so it must not claim an update "could not be installed".
 */
export type UpdateErrorPhase = 'check' | 'prepare' | 'install'

export interface UpdateInvokeMap {
  'update:open-log': { args: []; result: void }
  'update:check': { args: []; result: void }
  'update:install': { args: []; result: UpdateInstallResult }
}

export interface UpdateEventMap {
  'update:available': UpdateInfo
  'update:downloaded': UpdateInfo
  'update:error': { message: string; phase: UpdateErrorPhase }
  /**
   * A detached `brew upgrade` finished badly while the app was closed. Reported
   * on the next launch, since there was no window to report it to at the time —
   * without this a failed background upgrade would be completely silent.
   */
  'update:homebrew-failed': { version: string; message: string }
}

// ── Aggregate maps for type-safe IPC helpers ──────────────
export type InvokeMap = WorktreeInvokeMap &
  PtyInvokeMap &
  FsInvokeMap &
  EditorInvokeMap &
  GitInvokeMap &
  AgentInvokeMap &
  AppInvokeMap &
  ReviewInvokeMap &
  TourInvokeMap &
  ScreenPrsInvokeMap &
  LspInvokeMap &
  SessionInvokeMap &
  UpdateInvokeMap &
  ModelsInvokeMap &
  AgentBusInvokeMap

export type SendMap = LspSendMap

export type EventMap = WorktreeEventMap &
  PtyEventMap &
  AgentEventMap &
  GitEventMap &
  ReviewEventMap &
  TourEventMap &
  ScreenPrsEventMap &
  LspEventMap &
  AgentPanelEventMap &
  AgentBusEventMap &
  UpdateEventMap &
  EditorEventMap &
  ModelsEventMap
