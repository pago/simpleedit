/**
 * Session location tracking. Agent providers POST lifecycle hook input to the
 * per-window bridge's `/hooks` endpoint. Each event carries `session_id` and
 * `cwd`; we map the cwd to the containing worktree and tell the renderer to
 * repoint that session's workspace.
 *
 * Verified empirically on CLI 2.1.175 (Stage 2 Part A): the hook `cwd` tracks
 * Bash `cd` and persists across separate Bash tool calls, so per-event cwd is
 * a reliable signal — contrary to the earlier Stage 0 note. Paths are
 * symlink-resolved by the CLI (/tmp → /private/tmp on macOS), so we realpath
 * both sides before comparing.
 */
import { realpathSync } from 'fs'
import { isAbsolute, sep } from 'path'
import { simpleGit } from 'simple-git'
import type { WorktreeInfo } from '../shared/ipc-types'

/** Parsed signal from a hook POST body. Null when the body is unusable. */
export interface HookSignal {
  sessionId: string
  /**
   * The terminal this hook belongs to, when the provider's reporter can tell us
   * directly. Codex's reporter stamps `simpleedit_terminal_id` from its
   * environment; Claude's HTTP hooks don't, and are routed by `session_id`
   * through the registry at the bottom of this module.
   */
  terminalId: string | null
  cwd: string
  /**
   * Absolute path of a file the tool touched, when this is a `PostToolUse`
   * event for a file tool (Read/Write/Edit/MultiEdit/NotebookEdit). The agent
   * can read or edit a file in a sibling repo WITHOUT `cd`-ing there, so `cwd`
   * alone never reveals that repo — this is the only signal that does. Null for
   * non-file events (UserPromptSubmit, Bash, …) or relative paths.
   */
  filePath: string | null
  /** `hook_event_name` verbatim ('Stop', 'PostToolUse', …); null if absent. */
  eventName: string | null
  /**
   * On `Stop`/`SubagentStop`, the text of the turn's final assistant message.
   * Both Claude Code and Codex supply this (Claude's schema documents it as
   * avoiding a transcript read), which is what lets a peer's ordinary answer
   * serve as a reply without it calling any tool.
   */
  lastAssistantMessage: string | null
  /**
   * True when this `Stop` follows a turn a Stop hook already continued. Mail
   * must NOT be delivered on such a stop: doing so re-blocks the same turn and
   * the agent never reaches idle (Claude hard-caps this at 8 and then overrides).
   */
  stopHookActive: boolean
}

/**
 * Pull the touched file path out of a tool's input. Read/Write/Edit/MultiEdit
 * use `file_path`; NotebookEdit uses `notebook_path`. Only absolute paths are
 * usable — we resolve them to a repo via git, which needs a real location, and
 * a relative path would resolve against the wrong (bridge) cwd.
 */
function parseToolFilePath(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const rec = toolInput as Record<string, unknown>
  const raw = rec['file_path'] ?? rec['notebook_path'] ?? rec['path']
  if (typeof raw !== 'string' || !raw || !isAbsolute(raw)) return null
  return raw
}

/**
 * Extract the location signal from a hook event body. Hooks fire for many
 * event types (PostToolUse, UserPromptSubmit, …); every one carries
 * `session_id` + `cwd`. `PostToolUse` events for file tools also carry the
 * touched `file_path` under `tool_input`, which we surface so a cross-repo file
 * touch (not just a `cd`) puts that repo on the session's trail.
 */
export function parseHookBody(body: unknown): HookSignal | null {
  if (typeof body !== 'object' || body === null) return null
  const rec = body as Record<string, unknown>
  const sessionId = rec['session_id']
  const terminalId = rec['simpleedit_terminal_id']
  const cwd = rec['cwd']
  const eventName = rec['hook_event_name']
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (typeof cwd !== 'string' || !cwd) return null
  const lastAssistant = rec['last_assistant_message']
  return {
    sessionId,
    terminalId: typeof terminalId === 'string' && terminalId ? terminalId : null,
    cwd,
    filePath: parseToolFilePath(rec['tool_input']),
    eventName: typeof eventName === 'string' && eventName ? eventName : null,
    lastAssistantMessage: typeof lastAssistant === 'string' ? lastAssistant : null,
    stopHookActive: rec['stop_hook_active'] === true,
  }
}

/** realpath that degrades to the input when the path doesn't resolve. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Strip a single trailing separator so prefix math is boundary-correct. */
function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p
}

/**
 * Find the worktree that contains `cwd` (the deepest one, when worktrees nest).
 * Returns the worktree's *original* (non-realpathed) path so it matches the
 * paths the renderer already holds, or null when cwd is outside every worktree.
 *
 * Both sides are realpath-resolved before comparison to absorb the CLI's
 * symlink resolution; matching is on path-segment boundaries so `/a/foo` never
 * matches worktree `/a/foobar`.
 */
export function matchWorktree(cwd: string, worktrees: WorktreeInfo[]): string | null {
  const realCwd = stripTrailingSep(safeRealpath(cwd))

  let best: string | null = null
  let bestLen = -1
  for (const wt of worktrees) {
    const realWt = stripTrailingSep(safeRealpath(wt.path))
    const isMatch = realCwd === realWt || realCwd.startsWith(realWt + sep)
    if (isMatch && realWt.length > bestLen) {
      best = wt.path
      bestLen = realWt.length
    }
  }
  return best
}

/**
 * Resolve the bare repo that owns `cwd` by asking git for its common git dir
 * (the shared dir across a worktree set is the bare repo itself). Returns the
 * realpathed absolute path — matching how matchWorktree compares — or null when
 * cwd isn't inside a git repo.
 *
 * This backs the hook's "agent roamed into a repo the window never opened"
 * path: matchWorktree can only see repos already listed for the window, so when
 * it misses we resolve the repo here, register it, and re-match.
 */
export async function resolveBareRepo(cwd: string): Promise<string | null> {
  try {
    const out = await simpleGit(cwd).raw([
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    const dir = out.trim()
    return dir ? safeRealpath(dir) : null
  } catch {
    return null
  }
}

// ── session_id → terminalId registry ────────────────────────────────────────
// Hook bodies carry a provider session/thread id, while the rest of SimpleEdit
// routes by terminalId. Providers register the mapping once both are known.

const sessionToTerminal = new Map<string, string>()

export function registerSession(sessionId: string, terminalId: string): void {
  sessionToTerminal.set(sessionId, terminalId)
}

export function terminalForSession(sessionId: string): string | null {
  return sessionToTerminal.get(sessionId) ?? null
}

export function unregisterTerminal(terminalId: string): void {
  for (const [sid, tid] of sessionToTerminal) {
    if (tid === terminalId) sessionToTerminal.delete(sid)
  }
}
