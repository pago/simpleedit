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

export function spawnTerminal(
  options: PtySpawnOptions,
  webContents: WebContents
): void {
  const { id, worktreePath } = options

  if (terminals.has(id)) {
    return
  }

  const shell = defaultShell()
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: worktreePath,
    env: process.env as Record<string, string>
  })

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
  if (term) {
    term.resize(cols, rows)
  }
}

export function killTerminal(id: string): void {
  const term = terminals.get(id)
  if (term) {
    term.kill()
    terminals.delete(id)
  }
}

export function killAllTerminals(): void {
  for (const [id, term] of terminals) {
    term.kill()
    terminals.delete(id)
  }
}
