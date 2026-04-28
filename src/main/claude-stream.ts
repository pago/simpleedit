import type { WebContents } from 'electron'
import type { ClaudeStatus } from '../shared/ipc-types'

interface TerminalAttachment {
  worktreePath: string
  webContents: WebContents
  removeListener: () => void
}

/**
 * Tracks which terminals are being monitored for Claude Code stream-json output.
 */
const attachments = new Map<string, TerminalAttachment>()

/** Captured session_id per terminal (extracted from claude's stream-json init event). */
const sessionIds = new Map<string, string>()

/** Per-terminal line buffer for incremental JSON parsing. */
const jsonBuffers = new Map<string, string>()

/**
 * Callback registry: pty.ts will call these when data arrives.
 * We use this instead of IPC listeners to avoid coupling with the renderer's
 * pty:data channel — we tap into the raw data before it's sent.
 */
type DataCallback = (data: string) => void
const dataCallbacks = new Map<string, Set<DataCallback>>()

/**
 * Register a callback to receive PTY data for a terminal.
 * Called by claude-stream internally; the pty module calls `emitPtyData` to push data.
 */
export function onPtyData(terminalId: string, cb: DataCallback): () => void {
  let callbacks = dataCallbacks.get(terminalId)
  if (!callbacks) {
    callbacks = new Set()
    dataCallbacks.set(terminalId, callbacks)
  }
  callbacks.add(cb)
  return () => {
    callbacks!.delete(cb)
    if (callbacks!.size === 0) {
      dataCallbacks.delete(terminalId)
    }
  }
}

/**
 * Called by pty.ts whenever data arrives on a terminal.
 */
export function emitPtyData(terminalId: string, data: string): void {
  const callbacks = dataCallbacks.get(terminalId)
  if (callbacks) {
    for (const cb of callbacks) {
      cb(data)
    }
  }
}

/**
 * Claude Code updates the terminal title via OSC 0 sequences to reflect its status.
 * Extract all title strings from a raw PTY data chunk.
 *
 * Examples seen in the wild:
 *   \x1b]0;✳ Claude Code\x07          — idle, waiting for input
 *   \x1b]0;⠂ Claude Code\x07          — thinking/running (braille spinner)
 *   \x1b]0;✳ My session title\x07     — session done
 *   \x1b]0;⠐ My session title\x07     — session running
 */
function extractOscTitles(data: string): string[] {
  const re = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
  const titles: string[] = []
  let match
  while ((match = re.exec(data)) !== null) {
    if (match[1]) titles.push(match[1])
  }
  return titles
}

/**
 * Derive Claude status from a terminal title emitted by Claude Code.
 * Returns null if the title is unrecognised (e.g. a shell title).
 */
function statusFromTitle(title: string): ClaudeStatus | null {
  const firstCp = title.codePointAt(0) ?? 0
  if (firstCp === 0x2733) {
    // ✳ U+2733 eight-spoked asterisk — Claude's idle indicator
    return 'idle'
  }
  if (firstCp >= 0x2800 && firstCp <= 0x28FF) {
    // Braille pattern block (⠂ ⠐ ⠠ …) — Claude's progress spinner
    return 'running'
  }
  return null
}

function sendStatus(
  webContents: WebContents,
  terminalId: string,
  worktreePath: string,
  status: ClaudeStatus
): void {
  if (!webContents.isDestroyed()) {
    webContents.send('claude:status', { worktreePath, status, terminalId })
  }
}

/**
 * Strip ANSI control sequences so JSON line scans aren't confused by terminal
 * escape codes interleaved with stream-json output.
 */
function stripAnsi(s: string): string {
  // CSI (\x1b[...) sequences and OSC (\x1b]...) sequences terminated by BEL or ESC \
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

/**
 * Look for a `session_id` field in the first complete JSON line on the
 * stream-json output. Calls `onFound` once, then becomes a no-op for that
 * terminal. Buffers partial lines across PTY chunks.
 */
function tryExtractSessionId(
  terminalId: string,
  data: string,
  onFound: (sessionId: string) => void
): void {
  if (sessionIds.has(terminalId)) return

  const prev = jsonBuffers.get(terminalId) ?? ''
  const combined = prev + stripAnsi(data)
  const lines = combined.split(/\r?\n/)
  // Last element is incomplete — keep it for next chunk. Cap buffer to avoid
  // unbounded growth if claude never emits a newline (shouldn't happen with
  // stream-json, but defensive).
  const tail = lines.pop() ?? ''
  jsonBuffers.set(terminalId, tail.length > 64 * 1024 ? tail.slice(-32 * 1024) : tail)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed) as unknown
      if (obj && typeof obj === 'object' && 'session_id' in obj) {
        const sid = (obj as { session_id: unknown }).session_id
        if (typeof sid === 'string' && sid.length > 0) {
          sessionIds.set(terminalId, sid)
          jsonBuffers.delete(terminalId)
          onFound(sid)
          return
        }
      }
    } catch { /* not a complete/valid JSON line — keep scanning */ }
  }
}

/** Returns the session_id captured for a terminal, or null if none observed yet. */
export function getSessionId(terminalId: string): string | null {
  return sessionIds.get(terminalId) ?? null
}

/**
 * Look up the worktree path for a terminal by its ID.
 * Returns null if the terminal is not attached.
 */
export function getWorktreeForTerminal(terminalId: string): string | null {
  return attachments.get(terminalId)?.worktreePath ?? null
}

/**
 * Start monitoring a terminal's PTY output for Claude Code TUI events.
 */
export function attachToTerminal(
  terminalId: string,
  worktreePath: string,
  webContents: WebContents
): void {
  // Don't double-attach
  if (attachments.has(terminalId)) return

  const removeListener = onPtyData(terminalId, (data: string) => {
    for (const title of extractOscTitles(data)) {
      const status = statusFromTitle(title)
      if (status !== null) {
        sendStatus(webContents, terminalId, worktreePath, status)
      }
    }

    tryExtractSessionId(terminalId, data, (sessionId) => {
      if (!webContents.isDestroyed()) {
        webContents.send('claude:session-id', { terminalId, sessionId })
      }
    })
  })

  attachments.set(terminalId, { worktreePath, webContents, removeListener })
}

/**
 * Stop monitoring a terminal.
 */
export function detachFromTerminal(terminalId: string): void {
  const attachment = attachments.get(terminalId)
  if (attachment) {
    attachment.removeListener()
    attachments.delete(terminalId)
  }
  jsonBuffers.delete(terminalId)
  sessionIds.delete(terminalId)
}

/**
 * Clean up all terminal attachments.
 */
export function detachAll(): void {
  for (const [id, attachment] of attachments) {
    attachment.removeListener()
    attachments.delete(id)
  }
  jsonBuffers.clear()
  sessionIds.clear()
}
