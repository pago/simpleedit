import * as pty from 'node-pty'
import { type WebContents } from 'electron'
import { existsSync } from 'fs'
import type { AgentSpawnOptions as AgentSpawnOptionsShared, PtySpawnOptions } from '../shared/ipc-types'
import { emitPtyData } from './claude-stream'
import { getProvider, type LaunchPlan } from './agents/provider'
import { buildAgentsLaunch } from './agents/claude'
import './agents/codex'

type IPty = pty.IPty

const terminals = new Map<string, IPty>()
/**
 * Per-terminal cleanup thunks supplied by an agent provider's LaunchPlan (temp
 * config/hook files, hook routing). Run once on PTY exit or kill. Absent for
 * plain terminals and Agent-View tabs, which wire nothing to clean up.
 */
const agentCleanups = new Map<string, () => void>()

function runAgentCleanup(id: string): void {
  const cleanup = agentCleanups.get(id)
  if (cleanup) {
    cleanup()
    agentCleanups.delete(id)
  }
}

/**
 * Capped per-terminal output backlog. The renderer's xterm attaches only
 * after its component mounts — output emitted before that (notably ALL
 * output of a process that crashes at spawn) would otherwise be lost.
 * pty:data events carry their chunk's absolute byte offset; the renderer
 * replays the backlog on mount and dedups live chunks against it. The
 * backlog deliberately survives process exit and is dropped on kill.
 */
const BACKLOG_CAP = 256 * 1024
interface PtyBacklog {
  data: string
  /** Absolute offset of data[0] (> 0 once the cap has trimmed the front). */
  start: number
  end: number
}
const backlogs = new Map<string, PtyBacklog>()

/** Append a chunk; returns the chunk's absolute offset. */
function recordBacklog(id: string, data: string): number {
  let b = backlogs.get(id)
  if (!b) {
    b = { data: '', start: 0, end: 0 }
    backlogs.set(id, b)
  }
  const offset = b.end
  b.data += data
  b.end += data.length
  if (b.data.length > BACKLOG_CAP) {
    const excess = b.data.length - BACKLOG_CAP
    b.data = b.data.slice(excess)
    b.start += excess
  }
  return offset
}

export function getTerminalBacklog(id: string): PtyBacklog {
  const b = backlogs.get(id)
  return b ? { ...b } : { data: '', start: 0, end: 0 }
}

/**
 * pty.spawn with a nonexistent cwd dies instantly with exit code 1 and zero
 * output — indistinguishable from a crashing process (e.g. a stale worktree
 * whose directory was deleted). Fail with a readable message instead: the
 * text lands in the backlog/terminal and the session shows the exited state.
 * Returns true when the cwd is usable.
 */
function guardCwd(id: string, worktreePath: string, webContents: WebContents): boolean {
  if (existsSync(worktreePath)) return true
  const msg =
    `SimpleEdit: cannot start session — the directory does not exist:\r\n` +
    `  ${worktreePath}\r\n` +
    `The worktree may have been deleted outside SimpleEdit. Pick another worktree and start a new session.\r\n`
  const offset = recordBacklog(id, msg)
  if (!webContents.isDestroyed()) {
    webContents.send('pty:data', { id, data: msg, offset })
    webContents.send('pty:exit', { id, exitCode: 1 })
  }
  return false
}

export interface AgentSpawnOptions extends AgentSpawnOptionsShared {
  bridgePort?: number
  bridgeToken?: string
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env['COMSPEC'] ?? 'cmd.exe'
  }
  return process.env['SHELL'] ?? '/bin/zsh'
}

/**
 * Shell args to run `cmd`. Production uses an interactive login shell
 * (`-i -l`) so the user's profile is sourced and `claude` is found on PATH
 * however it was installed. Under E2E (SIMPLEEDIT_E2E=1) the test harness
 * already controls PATH (the e2e fake-claude dir is prepended), and the
 * login shell's profile re-sourcing would non-deterministically shadow the
 * fake with a real claude on the dev machine — so drop `-i -l` to make the
 * prepended PATH authoritative. Flag-gated: no effect on production spawns.
 */
function agentShellArgs(cmd: string): string[] {
  return process.env['SIMPLEEDIT_E2E'] === '1' ? ['-c', cmd] : ['-i', '-l', '-c', cmd]
}

function agentShell(): string {
  // zsh reads ~/.zshenv even without -i/-l and may replace the fixture PATH.
  // Keep E2E launches hermetic so the fake provider binaries always win.
  return process.env['SIMPLEEDIT_E2E'] === '1' && process.platform !== 'win32'
    ? '/bin/bash'
    : defaultShell()
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Render a structured plan only at the login-shell boundary. */
export function renderLaunchCommand(plan: Pick<LaunchPlan, 'executable' | 'args' | 'env'>): string {
  const env = Object.entries(plan.env ?? {}).map(([key, value]) => `${key}=${shellQuote(value)}`)
  return [...(env.length ? ['env', ...env] : []), shellQuote(plan.executable), ...plan.args.map(shellQuote)].join(' ')
}

function getPtyOptions(
  worktreePath: string,
  extraEnv?: Record<string, string>,
): pty.IPtyForkOptions {
  return {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: worktreePath,
    env: extraEnv
      ? { ...(process.env as Record<string, string>), ...extraEnv }
      : (process.env as Record<string, string>)
  }
}

/**
 * Shared spawn path for provider-driven agent terminals (Claude and Codex).
 * Runs the plan's command in a login shell, records the backlog, taps PTY data
 * for the stream parser, and wires exit cleanup — the same wiring the hardwired
 * Claude spawns used, now parameterised by the LaunchPlan.
 *
 * `emitSessionId` publishes an identity known at spawn time. Degraded PTY
 * lifecycle events are replaced by provider-native reporting once available.
 *
 * Callers MUST run the `terminals.has(id)` / `guardCwd` checks before building
 * the plan — a provider's `buildLaunch` can have side effects (writing temp
 * config, registering hook routing) that must not happen for a spawn that never
 * starts.
 */
function spawnAgentTerminal(
  id: string,
  worktreePath: string,
  plan: Pick<LaunchPlan, 'executable' | 'args' | 'env' | 'sessionId' | 'cleanup'>,
  opts: { emitSessionId?: boolean; clearStatusOnExit?: boolean },
  webContents: WebContents,
): void {
  const shell = agentShell()
  // -i -l: interactive login shell so both ~/.zprofile and ~/.zshrc are sourced,
  // ensuring the agent binary is on PATH regardless of how it was installed.
  const command = renderLaunchCommand(plan)
  const term = pty.spawn(shell, agentShellArgs(command), getPtyOptions(worktreePath))

  terminals.set(id, term)
  const cleanup = 'cleanup' in plan ? plan.cleanup : undefined
  if (cleanup) agentCleanups.set(id, cleanup)

  if (opts.emitSessionId && plan.sessionId && !webContents.isDestroyed()) {
    webContents.send('agent:session-id', { terminalId: id, sessionId: plan.sessionId })
  }

  term.onData((data: string) => {
    emitPtyData(id, data)
    const offset = recordBacklog(id, data)
    if (!webContents.isDestroyed()) {
      webContents.send('agent:status', { worktreePath, status: 'running', terminalId: id, precise: false })
      webContents.send('pty:data', { id, data, offset })
    }
  })

  term.onExit(({ exitCode }: { exitCode: number }) => {
    runAgentCleanup(id)
    terminals.delete(id)
    if (!webContents.isDestroyed()) {
      if (opts.clearStatusOnExit) {
        // Clear the worktree's Claude status so the worktree picker (#87) and
        // sidebar badges don't show stale 'running' for an exited tab. The
        // status is per-worktreePath, so this only fires when the LAST Claude
        // tab for this worktree exits — earlier exits leave the status as
        // whichever still-alive tab last reported. Acceptable: the indicator
        // tracks "is *any* Claude active here", not "is this specific tab".
        webContents.send('agent:status', { worktreePath, status: 'exited', terminalId: id, precise: false })
      }
      webContents.send('pty:exit', { id, exitCode })
    }
  })
}

export function spawnTerminal(
  options: PtySpawnOptions,
  webContents: WebContents
): void {
  const { id, worktreePath } = options

  if (terminals.has(id)) {
    return
  }
  if (!guardCwd(id, worktreePath, webContents)) return

  const shell = defaultShell()
  const term = pty.spawn(shell, ['-l'], getPtyOptions(worktreePath))

  terminals.set(id, term)

  term.onData((data: string) => {
    emitPtyData(id, data)
    const offset = recordBacklog(id, data)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:data', { id, data, offset })
    }
  })

  term.onExit(({ exitCode }: { exitCode: number }) => {
    terminals.delete(id)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:exit', { id, exitCode })
    }
  })
}

export function spawnAgentTerminalForProvider(
  options: AgentSpawnOptions,
  webContents: WebContents
): void {
  const { id, worktreePath, bridgePort, bridgeToken, resumeSessionId, forkSession, model, initialPrompt, target } = options

  if (terminals.has(id)) return
  if (!guardCwd(id, worktreePath, webContents)) return

  const provider = getProvider(target.provider)
  const plan = provider.buildLaunch({
    provider: target.provider,
    target,
    terminalId: id,
    worktreePath,
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(forkSession ? { forkSession } : {}),
    ...(bridgePort != null ? { bridgePort } : {}),
    ...(bridgeToken != null ? { bridgeToken } : {}),
    ...(model ? { model } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
  })

  if (!webContents.isDestroyed()) {
    webContents.send('agent:status', { worktreePath, status: 'initializing', terminalId: id, precise: false })
  }
  spawnAgentTerminal(id, worktreePath, plan, { emitSessionId: !!plan.sessionId, clearStatusOnExit: true }, webContents)
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
  if (!guardCwd(id, worktreePath, webContents)) return

  spawnAgentTerminal(
    id,
    worktreePath,
    buildAgentsLaunch(),
    { emitSessionId: false, clearStatusOnExit: false },
    webContents,
  )
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
  // The PTY may already have exited on its own (terminals entry gone) —
  // the provider cleanup and backlog still need dropping when the session
  // closes. runAgentCleanup is a no-op if nothing was wired (plain terminals).
  runAgentCleanup(id)
  backlogs.delete(id)
}

export function getActiveTerminalIds(): string[] {
  return Array.from(terminals.keys())
}

export function killAllTerminals(): void {
  for (const [id, term] of terminals) {
    try { term.kill() } catch { /* process may already be dead */ }
    runAgentCleanup(id)
    terminals.delete(id)
  }
  backlogs.clear()
}
