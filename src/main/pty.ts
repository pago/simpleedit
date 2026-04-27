import * as pty from 'node-pty'
import { app, type WebContents } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
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

  let claudeCmd = 'claude --output-format stream-json'

  if (bridgePort != null && bridgeToken != null) {
    const configPath = writeMcpConfig(id, bridgePort, bridgeToken)
    mcpConfigPaths.set(id, configPath)
    claudeCmd += ` --mcp-config ${configPath}`
  }

  if (resumeSessionId && /^[A-Za-z0-9_-]+$/.test(resumeSessionId)) {
    claudeCmd += ` --resume ${resumeSessionId}`
  }

  const shell = defaultShell()
  // -i -l: interactive login shell so both ~/.zprofile and ~/.zshrc are sourced,
  // ensuring claude is on PATH regardless of how it was installed.
  const term = pty.spawn(shell, ['-i', '-l', '-c', claudeCmd], getPtyOptions(worktreePath))

  terminals.set(id, term)

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
