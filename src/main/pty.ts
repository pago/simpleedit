import * as pty from 'node-pty'
import { app, type WebContents } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ClaudeSpawnOptions as ClaudeSpawnOptionsShared, PtySpawnOptions } from '../shared/ipc-types'
import { emitPtyData } from './claude-stream'

type IPty = pty.IPty

const terminals = new Map<string, IPty>()
const mcpConfigPaths = new Map<string, string>()

export interface ClaudeSpawnOptions extends ClaudeSpawnOptionsShared {
  bridgePort?: number
  bridgeToken?: string
}

function getMcpServerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'mcp-server', 'index.mjs')
  }
  return join(app.getAppPath(), 'out', 'mcp-server', 'index.mjs')
}

function writeMcpConfig(terminalId: string, bridgePort: number, bridgeToken: string): string {
  const configPath = join(tmpdir(), `simpleedit-mcp-${terminalId}.json`)
  const config = {
    mcpServers: {
      simpleedit: {
        type: 'stdio',
        command: 'node',
        args: [getMcpServerPath()],
        env: {
          SIMPLEEDIT_BRIDGE_PORT: String(bridgePort),
          SIMPLEEDIT_BRIDGE_TOKEN: bridgeToken,
          SIMPLEEDIT_TERMINAL_ID: terminalId
        }
      }
    }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  return configPath
}

function cleanupMcpConfig(terminalId: string): void {
  const configPath = mcpConfigPaths.get(terminalId)
  if (configPath) {
    try { unlinkSync(configPath) } catch { /* file may already be gone */ }
    mcpConfigPaths.delete(terminalId)
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env['COMSPEC'] ?? 'cmd.exe'
  }
  return process.env['SHELL'] ?? '/bin/zsh'
}

function getPtyOptions(worktreePath: string): pty.IPtyForkOptions {
  return {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: worktreePath,
    env: process.env as Record<string, string>
  }
}

export function spawnTerminal(
  options: PtySpawnOptions,
  webContents: WebContents
): void {
  const { id, worktreePath } = options

  if (terminals.has(id)) {
    return
  }

  const shell = defaultShell()
  const term = pty.spawn(shell, ['-l'], getPtyOptions(worktreePath))

  terminals.set(id, term)

  term.onData((data: string) => {
    emitPtyData(id, data)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:data', { id, data })
    }
  })

  term.onExit(({ exitCode }: { exitCode: number }) => {
    terminals.delete(id)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:exit', { id, exitCode })
    }
  })
}

export function spawnClaudeTerminal(
  options: ClaudeSpawnOptions,
  webContents: WebContents
): void {
  const { id, worktreePath, bridgePort, bridgeToken, resumeSessionId } = options

  if (terminals.has(id)) {
    return
  }

  // No `--output-format stream-json`: the flag is silently ignored when stdin
  // is a TTY (which node-pty always provides) on CLI 2.1.148+. Session id
  // capture now flows through `--session-id <uuid>` below; see #95.
  let claudeCmd = 'claude'

  if (bridgePort != null && bridgeToken != null) {
    const configPath = writeMcpConfig(id, bridgePort, bridgeToken)
    mcpConfigPaths.set(id, configPath)
    claudeCmd += ` --mcp-config ${configPath}`
  }

  // Pin the session id we want claude to use. For fresh tabs we generate a
  // UUID and tell claude to use it via `--session-id` (CLI flag added in
  // 2.x); for resumed tabs the id is already known from the resume arg.
  // Either way the session id is known to SimpleEdit *before* claude has
  // written anything — we're not discovering it from stdout or the JSONL,
  // we generated it. The `claude:session-id` IPC fires immediately below
  // and downstream consumers (rename-restore for #93, Fork-into-worktree
  // for #87) get the mapping with no race.
  // Note: claude rejects `--session-id <new>` alongside `--resume <existing>`
  // unless `--fork-session` is also passed; the resume path therefore does
  // not set `--session-id` and reuses the resumed id directly.
  let sessionId: string
  if (resumeSessionId && /^[A-Za-z0-9_-]+$/.test(resumeSessionId)) {
    sessionId = resumeSessionId
    claudeCmd += ` --resume ${resumeSessionId}`
  } else {
    sessionId = randomUUID()
    claudeCmd += ` --session-id ${sessionId}`
  }

  const shell = defaultShell()
  // -i -l: interactive login shell so both ~/.zprofile and ~/.zshrc are sourced,
  // ensuring claude is on PATH regardless of how it was installed.
  const term = pty.spawn(shell, ['-i', '-l', '-c', claudeCmd], getPtyOptions(worktreePath))

  terminals.set(id, term)

  if (!webContents.isDestroyed()) {
    webContents.send('claude:session-id', { terminalId: id, sessionId })
  }

  term.onData((data: string) => {
    emitPtyData(id, data)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:data', { id, data })
    }
  })

  term.onExit(({ exitCode }: { exitCode: number }) => {
    cleanupMcpConfig(id)
    terminals.delete(id)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:exit', { id, exitCode })
    }
  })
}

/**
 * Spawn `claude agents` — the interactive TUI for inspecting / managing
 * Claude Code agents. Unlike `spawnClaudeTerminal`, this does NOT use
 * `--output-format stream-json`, attach the stream parser, or wire up the
 * MCP bridge: agents is purely TUI-driven and emits no machine-readable
 * stream. The PTY is otherwise spawned identically (login shell, same env).
 */
export function spawnAgentsTerminal(
  options: PtySpawnOptions,
  webContents: WebContents
): void {
  const { id, worktreePath } = options

  if (terminals.has(id)) {
    return
  }

  const shell = defaultShell()
  const term = pty.spawn(shell, ['-i', '-l', '-c', 'claude agents'], getPtyOptions(worktreePath))

  terminals.set(id, term)

  term.onData((data: string) => {
    emitPtyData(id, data)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:data', { id, data })
    }
  })

  term.onExit(({ exitCode }: { exitCode: number }) => {
    terminals.delete(id)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:exit', { id, exitCode })
    }
  })
}

export function writeToTerminal(id: string, data: string): void {
  const term = terminals.get(id)
  if (term) {
    term.write(data)
  }
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const term = terminals.get(id)
  if (term && cols > 0 && rows > 0) {
    term.resize(cols, rows)
  }
}

export function killTerminal(id: string): void {
  const term = terminals.get(id)
  if (term) {
    try { term.kill() } catch { /* process may already be dead */ }
    cleanupMcpConfig(id)
    terminals.delete(id)
  }
}

export function getActiveTerminalIds(): string[] {
  return Array.from(terminals.keys())
}

export function killAllTerminals(): void {
  for (const [id, term] of terminals) {
    try { term.kill() } catch { /* process may already be dead */ }
    cleanupMcpConfig(id)
    terminals.delete(id)
  }
}
