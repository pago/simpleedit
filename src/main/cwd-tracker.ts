/**
 * Session location tracking. Spawned Claude sessions are launched with a hook
 * settings file (see pty.ts) that POSTs every hook event's input JSON to the
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
import { sep } from 'path'
import type { WorktreeInfo } from '../shared/ipc-types'

/** Parsed signal from a hook POST body. Null when the body is unusable. */
export interface HookSignal {
  sessionId: string
  cwd: string
}

/**
 * Extract the location signal from a hook event body. Hooks fire for many
 * event types (PostToolUse, UserPromptSubmit, …); every one carries
 * `session_id` + `cwd`, which is all we need — we ignore the event kind.
 */
export function parseHookBody(body: unknown): HookSignal | null {
  if (typeof body !== 'object' || body === null) return null
  const rec = body as Record<string, unknown>
  const sessionId = rec['session_id']
  const cwd = rec['cwd']
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (typeof cwd !== 'string' || !cwd) return null
  return { sessionId, cwd }
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

// ── session_id → terminalId registry ────────────────────────────────────────
// The hook body carries the Claude session_id (the uuid we pinned at spawn),
// but the rest of SimpleEdit routes by terminalId. We pin the mapping at spawn
// (where both ids are known) so hook POSTs resolve without scraping anything.

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
