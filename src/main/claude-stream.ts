import type { WebContents } from 'electron'
import type { ClaudeStatus } from '../shared/ipc-types'

interface TerminalAttachment {
  worktreePath: string
  webContents: WebContents
  buffer: string
  removeListener: () => void
}

/**
 * Tracks which terminals are being monitored for Claude Code stream-json output.
 */
const attachments = new Map<string, TerminalAttachment>()

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

// Strip ANSI escape codes that the PTY layer adds around the JSON output
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]|\x1b[>=<]|\x0f/g

/**
 * Try to extract relevant events from a single JSON line of Claude Code stream-json output.
 */
function processJsonLine(
  line: string,
  worktreePath: string,
  webContents: WebContents
): void {
  const clean = line.replace(ANSI_RE, '').trim()
  if (!clean.startsWith('{')) return

  let parsed: unknown
  try {
    parsed = JSON.parse(clean)
  } catch {
    // Not valid JSON — expected for most terminal output
    return
  }

  if (typeof parsed !== 'object' || parsed === null) return

  const obj = parsed as Record<string, unknown>
  const type = obj['type']

  if (type === 'assistant') {
    // Emit running status
    sendStatus(webContents, worktreePath, 'running')

    // Check for tool_use with file paths
    const message = obj['message'] as Record<string, unknown> | undefined
    if (message && Array.isArray(message['content'])) {
      for (const block of message['content'] as unknown[]) {
        if (typeof block !== 'object' || block === null) continue
        const content = block as Record<string, unknown>
        if (content['type'] === 'tool_use') {
          const toolName = content['name']
          if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
            const input = content['input'] as Record<string, unknown> | undefined
            const filePath = input?.['file_path']
            if (typeof filePath === 'string') {
              sendFileTouch(webContents, worktreePath, filePath)
            }
          }
        }
      }
    }
  } else if (type === 'result') {
    sendStatus(webContents, worktreePath, 'idle')
  }
}

function sendStatus(
  webContents: WebContents,
  worktreePath: string,
  status: ClaudeStatus
): void {
  if (!webContents.isDestroyed()) {
    webContents.send('claude:status', { worktreePath, status })
  }
}

function sendFileTouch(
  webContents: WebContents,
  worktreePath: string,
  filePath: string
): void {
  if (!webContents.isDestroyed()) {
    webContents.send('claude:file-touch', { worktreePath, filePath })
  }
}

/**
 * Start monitoring a terminal's PTY output for Claude Code stream-json events.
 */
export function attachToTerminal(
  terminalId: string,
  worktreePath: string,
  webContents: WebContents
): void {
  // Don't double-attach
  if (attachments.has(terminalId)) return

  let buffer = ''

  const removeListener = onPtyData(terminalId, (data: string) => {
    buffer += data

    // Process complete lines
    const lines = buffer.split('\n')
    // Keep the last incomplete chunk in the buffer
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      processJsonLine(trimmed, worktreePath, webContents)
    }
  })

  attachments.set(terminalId, {
    worktreePath,
    webContents,
    buffer: '',
    removeListener
  })
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
}

/**
 * Clean up all terminal attachments.
 */
export function detachAll(): void {
  for (const [id, attachment] of attachments) {
    attachment.removeListener()
    attachments.delete(id)
  }
}
