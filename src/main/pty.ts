import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import type { PtySpawnOptions } from '../shared/ipc-types'
import { emitPtyData } from './claude-stream'

type IPty = pty.IPty

const terminals = new Map<string, IPty>()

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
  options: PtySpawnOptions,
  webContents: WebContents
): void {
  const { id, worktreePath } = options

  if (terminals.has(id)) {
    return
  }

  const shell = defaultShell()
  // -i -l: interactive login shell so both ~/.zprofile and ~/.zshrc are sourced,
  // ensuring claude is on PATH regardless of how it was installed.
  const term = pty.spawn(shell, ['-i', '-l', '-c', 'claude --output-format stream-json'], getPtyOptions(worktreePath))

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
    terminals.delete(id)
  }
}

export function getActiveTerminalIds(): string[] {
  return Array.from(terminals.keys())
}

export function killAllTerminals(): void {
  for (const [id, term] of terminals) {
    try { term.kill() } catch { /* process may already be dead */ }
    terminals.delete(id)
  }
}
