/**
 * All IPC channel definitions. Each feature uses a namespaced prefix.
 * Renderer → Main: invoke channels (request/response)
 * Main → Renderer: event channels (push)
 */

import type { Spec } from './gen-ui-catalog'
import type { PrRef, PrContext, ScreenPrCard, DeepLensId, DeepFinding, DeepReviewStatus, DeepLensStatus, PrReviewDraft } from './screenprs'
import type { DraftOpResult, DraftsSnapshot, PrReviewDraftOp } from './review-drafts'
import type { OverviewFacts, OverviewStatus } from './pr-overview'

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

/**
 * Identifies ONE TRANSPORT behind an IPC call — a window's renderer, or a
 * single remote (phone) socket. Never sent by a client: main stamps it from
 * the IPC event or the socket, so no client can name another one and take its
 * PTY.
 *
 * Deliberately finer-grained than `ClientHub.id`. A hub is one identity with
 * several transports, and size ownership is exactly the thing those transports
 * must be able to take from each other — keying it by the hub id would make a
 * desktop window and the phone attached to it indistinguishable, which is the
 * case the whole mechanism exists for. Desktop transports use the decimal
 * `WebContents.id`; remote sockets use a `w`-prefixed key, so the two spaces
 * cannot collide.
 */
export type PtyClientId = string

export interface PtyInvokeMap {
  'pty:spawn': { args: [options: PtySpawnOptions]; result: void }
  'pty:write': { args: [id: string, data: string]; result: void }
  /** Applied only if the calling client owns this PTY's size (see `pty:claim`);
   * a non-owner's resize is dropped, not queued. The owning `PtyClientId` comes
   * from the IPC event, not from these args. */
  'pty:resize': { args: [id: string, cols: number, rows: number]; result: void }
  /**
   * Take ownership of this PTY's size AND set it, in one call. Sent when the
   * user's attention lands on a terminal — a session being selected, the
   * window focused, the tab made visible — so the client being looked at is
   * the one that sizes the PTY. Last claim wins.
   *
   * The dimensions are not optional, and not a separate `pty:resize` after the
   * claim. While a client is not the owner its resizes are dropped, so its
   * container can reflow — a viewer opening, a diff tab appearing — with the
   * PTY never hearing about it. Taking ownership back without also handing
   * over the current geometry would leave the PTY at a size nothing on screen
   * matches, until some later resize happened to fix it by luck.
   */
  'pty:claim': { args: [id: string, cols: number, rows: number]; result: void }
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
  /**
   * Size ownership of `id` moved to `owner`. Sent to every client holding that
   * terminal — including the one that just LOST it, which may be a different
   * window and so a different hub.
   *
   * It does NOT stop that client sending resizes: main is authoritative and
   * drops a non-owner's, and gating the send on this would go stale exactly
   * when a container reflows out of focus. What it does is let a view say it
   * is sized by another device instead of silently rendering at a width the
   * terminal no longer uses.
   */
  /**
   * Who sizes this PTY now. `null` means nobody: the owning client's transport
   * went away, and the next resize from any client is applied.
   */
  'pty:owner-changed': { id: string; owner: PtyClientId | null }
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
export type AgentProviderId = 'claude' | 'codex' | 'opencode'

/**
 * Providers whose `InteractiveTarget` names a model by bare provider-native id
 * rather than by structured `ModelRef`. Grouping them in one union arm is what
 * lets callers narrow with `provider === 'claude'` and handle everything else
 * uniformly — naming each id individually is how `provider === 'codex'`
 * conditionals leaked into components in the first place.
 */
export type NativeModelAgentId = Exclude<AgentProviderId, 'claude'>
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
  | { provider: NativeModelAgentId; model?: string; reasoningEffort?: ReasoningEffort }

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
   * spinner glyph; `constant` means a fixed brand string (OpenCode emits the
   * literal "OpenCode"). Only `session-label` may overwrite the session label.
   */
  oscTitle: 'session-label' | 'directory' | 'constant'
  /**
   * Whether the provider reports a conversation title out-of-band (not via the
   * terminal title). OpenCode names a session from its first turn and pushes
   * that over its event stream, so a session can be labelled meaningfully even
   * though its OSC title is a fixed brand string.
   */
  reportsSessionTitle: boolean
  /**
   * Whether lifecycle reporting works as soon as we launch, or needs a one-time
   * grant from the user. Codex is `user-granted`: it refuses to run our hooks
   * until their command hash is trusted, so status, session identity and cwd
   * tracking stay degraded until the user allows them once.
   */
  reportingSetup: 'automatic' | 'user-granted'
  /**
   * How this provider's `InteractiveTarget` carries a model choice.
   * `model-ref` = a structured `ModelRef` (Claude, which can also point at a
   * local Ollama endpoint); `model-id` = a bare provider-native id (Codex).
   * Lets a picker build a target without knowing which provider it is.
   */
  modelSelector: 'model-ref' | 'model-id'
  /**
   * For `model-id` providers, the `ModelRef.provider` its bare ids belong to
   * (Codex's are `openai` ids, OpenCode's are `opencode` ids). This is what
   * lets "remember the last model used" store a uniform `ModelRef` without a
   * component knowing which agent produced it. Absent for `model-ref`
   * providers, which already carry a fully-formed `ModelRef`.
   */
  nativeModelBrand?: Extract<ModelRef, { reasoningEffort?: ReasoningEffort }>['provider']
  /** Whether a reasoning effort can be chosen alongside the model. */
  reasoningEffort: boolean
  /**
   * Whether the provider can be handed a catalog of selectable models, fetched
   * over `models:for-agent`. False for agents whose model list we cannot
   * enumerate, so the picker offers only the configured default.
   */
  modelCatalog: boolean
}

/**
 * One agent's lifecycle state, as main reports it.
 *
 * `precise` separates a state the agent ITSELF told us about (a hook, a
 * control-channel event, an OSC title it writes deliberately) from one we
 * inferred. Anything that acts on a status rather than merely displaying it —
 * a push notification, above all — must require it: a mis-parsed title
 * buzzing a phone is worse than no notification at all.
 */
export interface AgentStatusEvent {
  worktreePath: string
  status: AgentStatus
  terminalId: string
  precise: boolean
  message?: string
}

export interface AgentEventMap {
  'agent:status': AgentStatusEvent
  'agent:session-id': { terminalId: string; sessionId: string }
  /** The agent's own name for the conversation (see `reportsSessionTitle`). */
  'agent:session-title': { terminalId: string; title: string }
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
  /** One PR's unified diff, on demand — board cards reach a remote client with
   *  `diff` emptied, because a board is dozens of them. */
  'screenprs:pr-diff': { args: [pr: Pick<PrRef, 'url'> & { headSha?: string }]; result: string }
  /** Run a deep review on one PR (full context is passed — triage doesn't retain it). */
  'screenprs:deep-start': { args: [context: PrContext]; result: void }
  'screenprs:deep-cancel': { args: [url: string]; result: void }
  /** Write the PR overview for one PR (full context, diff included, as for deep review). */
  'screenprs:overview-start': { args: [context: PrContext]; result: void }
  'screenprs:overview-cancel': { args: [url: string]; result: void }
  /** Post a review to GitHub — the composer's write path (guarded by a confirm). */
  'screenprs:submit-review': { args: [request: SubmitReviewRequest]; result: SubmitReviewResult }
  /** Every persisted review draft — what a client's mirror starts from. */
  'screenprs:drafts-load': { args: []; result: DraftsSnapshot }
  /** Change one PR's draft. Main applies it, persists, and broadcasts `screenprs:draft-changed`. */
  'screenprs:draft-op': { args: [request: { url: string; op: PrReviewDraftOp }]; result: DraftOpResult }
}

/** Identify the PR + the composed review to post. */
export interface SubmitReviewRequest {
  pr: Pick<PrRef, 'owner' | 'repo' | 'number' | 'url'>
  draft: PrReviewDraft
}

export type SubmitReviewResult =
  | { ok: true; reviewUrl?: string; foldedComments: boolean }
  | {
      ok: false
      error: string
      /**
       * Set when the call was killed in flight, so GitHub may or may not have
       * received it. Absent means GitHub answered and nothing was posted —
       * which is safe to retry, and this is not.
       */
      delivered?: 'unknown'
    }

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
  /** The synthesized, curated deep-review findings for a PR, plus the head they
   *  were computed against — a finding's line number means nothing without it. */
  'screenprs:deep-result': { url: string; findings: DeepFinding[]; headSha: string }
  'screenprs:deep-status': { url: string; status: DeepReviewStatus; error?: string }
  /** The overview's raw markdown (parsed on render) and the facts code gathered with it. */
  'screenprs:overview-result': { url: string; headSha: string; text: string; facts: OverviewFacts }
  'screenprs:overview-status': { url: string; status: OverviewStatus; error?: string }
  /** A PR's draft changed, from any client — sent to every window and phone. `null`: it is gone. */
  'screenprs:draft-changed': { url: string } & DraftOpResult
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
  /**
   * v2 = pre-grouping (no groups; hydrates as all-standalone), v3 = grouped,
   * v4 = provider-aware agent sessions. All are still accepted on load.
   */
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

/**
 * A session as a client that is NOT the window's own renderer sees it.
 *
 * The renderer owns the session list — labels, provider, worktree and status
 * all live in its stores — so main cannot derive this. The renderer pushes it
 * (`session:sync`) and main keeps it per window, which is what lets a second
 * transport on that window's hub read the same list without reimplementing
 * any of it.
 */
/**
 * One repo a session has worked in, and the worktrees it touched there.
 *
 * Grouped by repo in MAIN's copy of the list because the grouping cannot be
 * redone anywhere else: mapping a worktree path back to its bare repo needs
 * the per-repo worktree lists, which only the renderer that loaded them holds.
 * A second client handed bare paths would have to guess, and a phone guessing
 * which repo a path belongs to is how the picker starts lying.
 */
export interface SessionRepoTrail {
  /** Bare repo path — the key the `worktree:*` channels take. */
  repoPath: string
  /** Worktrees touched in this repo, most-recently-first. Never empty. */
  worktrees: string[]
}

export interface WindowSessionInput {
  /** The PTY terminal id. Doubles as the session id renderer-side. */
  terminalId: string
  label: string
  kind: 'agent' | 'agents' | 'terminal'
  /** Absent on a plain terminal — there is no agent in front of the shell. */
  provider?: AgentProviderId
  worktreePath: string
  status: AgentStatus | 'unknown'
  /**
   * Where this session has been, most-recently-first.
   *
   * Seeded with the session's own worktree, so it is empty only before the
   * renderer has ever synced. The desktop repo picker reads the same trail.
   */
  trail: SessionRepoTrail[]
}

export interface WindowSession extends WindowSessionInput {
  /**
   * Epoch ms of the last change to `status`, stamped by MAIN.
   *
   * A client cannot compute this: it stamps only what it has witnessed, so a
   * session that blocked twenty minutes before the phone connected would read
   * as freshly blocked — the one number this surface exists to show.
   */
  statusSince: number
}

/**
 * Start a session from a brief, from a client that has no session of its own.
 *
 * One field, because a session needs no more: agents launch at the project
 * root and create their own worktrees, so there is no branch to name and no
 * directory to pick. Provider and model come from the same default a new
 * session gets at the desk.
 */
export interface SessionCreateRequest {
  /**
   * Identifies the user's INTENT, not this call.
   *
   * Minted once when the user commits to starting a session and reused by
   * every attempt to deliver that intent, so a double tap, a socket that drops
   * before the answer arrives, or a replayed frame all resolve to the one
   * session. Main is where that is enforced — a client-side guard cannot see
   * the attempt that a different client, or a previous page load, already made.
   */
  requestId: string
  /** What the agent should do. Becomes its seed prompt. */
  brief: string
}

/**
 * What main says when it delivered a create request and never heard back.
 *
 * Shared, and compared exactly, because a client has to ACT on this ONE
 * outcome differently from every other failure: it is the only one where a
 * session may exist that nobody has seen. Every other rejection means the
 * intent is still safe to re-ask. Recognising it by prose would make the
 * difference between one agent and two depend on a wording tweak.
 */
/**
 * Stands where a diff was cut short for a client that cannot receive all of it.
 *
 * Part of the diff text rather than a flag beside it, so a reader sees that
 * something is missing even if nothing special handles it — and shared so the
 * surface that CAN say more recognises it exactly.
 */
export const DIFF_TRUNCATED_MARKER =
  '*** This diff is too large to send to a phone. Open it at the desk to see the rest. ***'

export const SESSION_CREATE_UNWITNESSED =
  'SimpleEdit did not confirm the new session in time. Check the list before starting it again.'

/** The session a `session:create` produced — enough to open it. */
export interface SessionCreateResult {
  terminalId: string
  label: string
}

export interface SessionInvokeMap {
  'session:save': { args: [payload: SerializedSession]; result: void }
  'session:load': { args: [repoPath: string]; result: SerializedSession | null }
  'session:clear': { args: [repoPath: string]; result: void }
  /** Renderer → main: the whole list, whenever any part of it changes. */
  'session:sync': { args: [sessions: WindowSessionInput[]]; result: void }
  /** Any client → main: the current list for the window it is attached to. */
  'session:list': { args: []; result: WindowSession[] }
  /** Any client → main: start a session from a brief. Rejects with the reason. */
  'session:create': { args: [request: SessionCreateRequest]; result: SessionCreateResult }
  /**
   * Renderer → main: what became of a `session:create-request`.
   *
   * The renderer mints the terminal id and owns the defaults, so this is the
   * only way the outcome can reach the waiting call — including a refusal,
   * which must be distinguishable from a renderer that never answered.
   */
  'session:created': {
    args: [correlationId: string, outcome: SessionCreateOutcome]
    result: void
  }
}

/** The renderer's answer to one `session:create-request`. */
export type SessionCreateOutcome =
  | ({ ok: true } & SessionCreateResult)
  | { ok: false; reason: string }

export interface SessionEventMap {
  /** Fanned out to every transport on the window whose list changed. */
  'session:list-changed': WindowSession[]
  /**
   * Main → the window's own renderer: create a session seeded with this brief.
   *
   * Sent to the renderer rather than the hub because only the renderer holds
   * the session list, the project root and the model defaults. It answers on
   * `session:created` with the matching `correlationId`.
   */
  'session:create-request': {
    correlationId: string
    brief: string
    /** Derived from the brief by main, so one definition serves both ends. */
    label?: string
  }
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
  /**
   * An OpenCode model id, always fully qualified as `<provider>/<model>` (e.g.
   * `opencode/deepseek-v4-flash-free`) because that is the only form its
   * `--model` flag accepts. `reasoningEffort` maps to OpenCode's `--variant`.
   */
  | { provider: 'opencode'; model?: string; reasoningEffort?: ReasoningEffort }

export type TaskTarget =
  | { runner: 'claude'; model?: string }
  | { runner: 'codex'; model?: string; reasoningEffort?: ReasoningEffort }
  | { runner: 'opencode'; model?: string; reasoningEffort?: ReasoningEffort }
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

/**
 * An OpenCode model offered in the picker. `model` is the fully qualified
 * `<provider>/<id>` form, because that is the only form `--model` accepts.
 * Reasoning-effort variants are per model here, not global as they are for
 * Codex.
 */
export interface OpenCodeModel {
  provider: 'opencode'
  displayName: string
  model: string
  supportedReasoningEfforts: ReasoningEffort[]
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
export type ModelFeatureKey = 'review' | 'tour' | 'screenPrs' | 'prOverview' | 'interactive'

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
  /** OpenCode's catalog, from `opencode models --verbose`. */
  'models:opencode': { args: []; result: OpenCodeModel[] }
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

// ── Prompt overrides ──────────────────────────────────────
/** Every prompt whose instructions a person may override from Settings. */
export type PromptId = 'triage' | `deep-review/${DeepLensId}` | 'deep-review/synthesis' | 'overview'
export type PromptGroup = 'screening' | 'deep-review' | 'overview'
/** Settings shows the groups in this order, under these headings. */
export const PROMPT_GROUP_LABEL: Record<PromptGroup, string> = {
  screening: 'Screening',
  'deep-review': 'Deep review',
  overview: 'PR overview',
}
/**
 * `outdated`: the override was customized from an older default than the one
 * shipped now. Informational — the override still applies. `error`: the file
 * exists but is empty or unreadable, so runs fall back to the default.
 */
export type PromptStatus = 'default' | 'custom' | 'outdated' | 'error'

export interface PromptInfo {
  id: PromptId
  title: string
  description: string
  group: PromptGroup
  status: PromptStatus
  error?: string
  /** Where the override lives (or would live, before Customize). */
  path: string
  defaultVersion: number
  /** The default version the override was customized from, when recorded. */
  basedOn?: number
}

export interface PromptsInvokeMap {
  'prompts:list': { args: []; result: PromptInfo[] }
  /** Both texts without frontmatter. `text` is the default when no override exists. */
  'prompts:read': { args: [id: PromptId]; result: { text: string; defaultText: string } }
  /** Seed the override from the current default (no-op if it exists); returns its path. */
  'prompts:customize': { args: [id: PromptId]; result: string }
  'prompts:save': { args: [id: PromptId, text: string]; result: void }
  /** Rewrite `based-on` to the shipped default version, keeping the body. Clears `outdated`. */
  'prompts:mark-current': { args: [id: PromptId]; result: void }
  /** Delete the override, so runs use the default again. */
  'prompts:reset': { args: [id: PromptId]; result: void }
  'prompts:reveal': { args: [id: PromptId]; result: void }
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
  /**
   * This transport's own `PtyClientId`, so a client can tell whether a
   * `pty:owner-changed` names it. Stamped by main from the call's origin — the
   * value is not something a client may choose.
   */
  'app:client-key': { args: []; result: PtyClientId }
}

// ── Remote access ─────────────────────────────────────────
/**
 * Persisted remote-access preferences. `enabled` is never flipped implicitly:
 * the server exposes `pty:spawn`, `fs:write` and every git operation to
 * whoever holds its token, so it starts only when a person asks for it.
 */
export interface RemoteAccessConfig {
  enabled: boolean
  /** Interface to bind. Always explicit — never an implicit `0.0.0.0`. */
  host: string
  /** 0 for an ephemeral port. */
  port: number
  /**
   * Absolute path to a whisper.cpp GGML model file. Empty until a person picks
   * one — nothing is bundled and nothing is downloaded.
   */
  sttModelPath: string
  /**
   * Drive `tailscale serve` while remote access is on.
   *
   * Explicit opt-in, separate from `enabled`, and never implied by it: Serve
   * publishes this app to every device on the tailnet under a stable HTTPS
   * name. Turning remote access on is a decision about this Mac; turning Serve
   * on is a decision about the tailnet.
   */
  serveEnabled: boolean
  /**
   * The loopback port a serve mapping was last created for, or 0.
   *
   * Not a preference — a claim ticket. The mapping lives inside tailscaled and
   * outlives a crash, so the port is written down before the mapping exists
   * and cleared once it is gone. At launch a non-zero value means some earlier
   * run left a mapping behind, and it is removed only if tailscaled still
   * points at exactly that target.
   */
  servePort: number
}

// ── Speech to text ────────────────────────────────────────
/**
 * Whether dictation can run, and what to do about it when it cannot.
 *
 * Voice is an accelerant on this surface, never a requirement: the composer
 * takes typed input whatever this says. So `hint` is advice, not an error.
 */
export interface SttStatus {
  /** A whisper.cpp CLI was found on PATH. */
  installed: boolean
  /** Which command was found, so the pane can name it. */
  binary: string | null
  /** The configured model file. Empty when never set. */
  modelPath: string
  /** That file exists and is readable. */
  modelReady: boolean
  /** Both of the above — dictation will actually work. */
  ready: boolean
  /** What is missing and how to fix it. Null when ready. */
  hint: string | null
}

export interface SttInvokeMap {
  'stt:status': { args: []; result: SttStatus }
  /** Persists the model path and re-reports. An unusable path is rejected. */
  'stt:set-model-path': { args: [path: string]; result: SttStatus }
  /**
   * Base64 of a 16 kHz mono 16-bit PCM WAV. Base64 because this channel is
   * reached over a JSON WebSocket as well as over Electron IPC, and a
   * `Uint8Array` does not survive the former.
   */
  'stt:transcribe': { args: [audioBase64: string]; result: string }
  /**
   * Native file picker for the model. Desktop only in practice — it opens a
   * dialog on the Mac, which is no use to a phone, so the pane that calls it
   * is the settings pane and the mobile surface never does.
   */
  'stt:pick-model': { args: []; result: SttStatus | null }
}

export interface RemoteAccessStatus {
  running: boolean
  host: string | null
  port: number | null
  /** The full URL to open, token included, or null when not running. */
  url: string | null
  /** Currently attached web clients. */
  clients: number
  /**
   * Whether a power assertion is held. Surfaced so it is never a mystery why
   * the Mac stayed awake — and, more importantly, so a failure to take one is
   * visible rather than showing up later as agents that stopped overnight.
   */
  powerSaveBlocked: boolean
  /** Why the last start attempt failed (a taken port, typically). */
  error: string | null
}

export interface RemoteInvokeMap {
  'remote:status': { args: []; result: RemoteAccessStatus }
  'remote:config': { args: []; result: RemoteAccessConfig }
  /** Starts or stops the server, and persists the choice. */
  'remote:set-enabled': { args: [enabled: boolean]; result: RemoteAccessStatus }
  /** Rebinds a running server; persisted either way. */
  'remote:set-host': { args: [host: string]; result: RemoteAccessStatus }
  /** Candidate bind addresses, so the pane can offer them instead of a text field. */
  'remote:interfaces': { args: []; result: RemoteInterface[] }
  /**
   * Opt in to, or out of, `tailscale serve`. Persisted, and applied against
   * the running server's current port.
   */
  'remote:set-serve-enabled': { args: [enabled: boolean]; result: TailscaleServeStatus }
  /** Probe the Tailscale CLI. Spawns a subprocess, so it is called on demand. */
  'tailscale:status': { args: []; result: TailscaleStatus }
  'tailscale:serve-status': { args: []; result: TailscaleServeStatus }
}

/**
 * What the Tailscale CLI says about this node.
 *
 * `interfaces.ts` can only recognise the interface. Everything a phone needs —
 * the MagicDNS name, whether HTTPS certificates exist, whether Serve can run —
 * comes from the CLI, so its absence is a first-class state rather than a
 * failure to report.
 */
export interface TailscaleStatus {
  /** The command we would run, or null when no candidate exists at all. */
  cli: string | null
  /**
   * That command actually answered with a status we could parse.
   *
   * Not the same as `cli !== null`, and the difference is load-bearing: the
   * `$PATH` fallback hands back a bare name on Windows without verifying it,
   * and the Mac App Store bundle contains a binary that may not speak CLI at
   * all. This is the field anything that has to DRIVE Tailscale gates on.
   */
  cliUsable: boolean
  /** `Running`, `Stopped`, `NeedsLogin`, … Null when the CLI did not answer. */
  backendState: string | null
  /** `Self.DNSName`, trailing dot removed — the host part of the HTTPS URL. */
  dnsName: string | null
  /** A certificate exists for `dnsName`, so an HTTPS URL will actually load. */
  httpsReady: boolean
  /** What is missing and what to do about it. Null when nothing is. */
  hint: string | null
}

/**
 * The serve mapping this app owns.
 *
 * Its lifetime is the remote server's: created when the server starts,
 * re-pointed when the ephemeral port changes, removed when it stops.
 */
export interface TailscaleServeStatus {
  /** A mapping exists and is published. */
  active: boolean
  /** The loopback port we are responsible for, whether or not it published. */
  port: number | null
  /** The HTTPS URL Serve publishes, token included. Null unless active. */
  url: string | null
  /** A serve or an unserve is in flight. */
  busy: boolean
  /**
   * Where to switch Serve on for the tailnet.
   *
   * `tailscale serve` refuses with `Serve is not enabled on your tailnet. To
   * enable, visit: <url>`, and that URL names the node, so it cannot be
   * derived. It is also the thing a terminal truncates. Parsed out so the pane
   * can render it as a link rather than a dead end.
   */
  enableUrl: string | null
  error: string | null
}

export interface RemoteInterface {
  name: string
  address: string
  /** A Tailscale address (100.64.0.0/10) — the intended one for a phone. */
  isTailscale: boolean
  isLoopback: boolean
}

export interface RemoteEventMap {
  'remote:status-changed': RemoteAccessStatus
  'remote:serve-changed': TailscaleServeStatus
  'push:status-changed': PushStatus
}

// ── Push notifications ────────────────────────────────────
/**
 * One registered device, as the UI is allowed to see it.
 *
 * Deliberately NOT the endpoint. A push endpoint is a bearer capability to
 * send notifications to that device, and `push:status` is reachable over the
 * remote socket like every other channel — so the pane gets an id it can
 * address and a service host it can name, and nothing that could be replayed.
 */
export interface PushDevice {
  /** Stable digest of the endpoint. What `push:unsubscribe` takes. */
  id: string
  /** What the device called itself when it registered. */
  label: string
  /** The push service's host — `web.push.apple.com`, `fcm.googleapis.com`, … */
  service: string
  createdAt: number
  /** Epoch ms of the last successful delivery, or null. */
  lastPushAt: number | null
  /** Why the last delivery failed, or null. Never a reason to prune on its own. */
  lastError: string | null
}

export interface PushStatus {
  /**
   * The VAPID public key, which a browser needs in order to subscribe.
   * Its private half never leaves the main process — not to a renderer, not
   * to the web bundle, not into a log.
   */
  vapidPublicKey: string
  devices: PushDevice[]
  error: string | null
}

/** Exactly what `PushSubscription.toJSON()` yields, plus a name for the row. */
export interface PushSubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** How the device should be listed. Trimmed and length-capped by main. */
  label?: string
}

export interface PushInvokeMap {
  'push:status': { args: []; result: PushStatus }
  /** Register or refresh this device. Idempotent per endpoint. */
  'push:subscribe': { args: [subscription: PushSubscriptionInput]; result: PushStatus }
  /** Forget one device, by endpoint (what a browser knows) or by id (what the pane shows). */
  'push:unsubscribe': { args: [endpointOrId: string]; result: PushStatus }
  /** Forget every device. The way out when a phone is lost. */
  'push:forget-all': { args: []; result: PushStatus }
  /**
   * Does this Mac still hold a subscription for `endpoint`? Returns its device
   * id, or null.
   *
   * A browser can only see its OWN side of the registration. The Mac's side can
   * disappear underneath it — the user taps Forget in the pane, the push
   * service reports the endpoint gone, or a corrupt VAPID pair is replaced and
   * takes every subscription with it. Without this the phone believes it is
   * registered forever and offers no way to fix it. The caller already holds
   * the endpoint it is asking about, so this exposes nothing new.
   */
  'push:device-id': { args: [endpoint: string]; result: string | null }
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
  status: AgentStatus | 'unknown'
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
  PromptsInvokeMap &
  RemoteInvokeMap &
  PushInvokeMap &
  SttInvokeMap &
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
  RemoteEventMap &
  SessionEventMap &
  ModelsEventMap
