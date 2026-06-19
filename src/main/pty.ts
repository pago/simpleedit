import * as pty from 'node-pty'
import { app, type WebContents } from 'electron'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ClaudeSpawnOptions as ClaudeSpawnOptionsShared, PtySpawnOptions } from '../shared/ipc-types'
import { emitPtyData } from './claude-stream'
import { registerSession, unregisterTerminal } from './cwd-tracker'

type IPty = pty.IPty

const terminals = new Map<string, IPty>()
const mcpConfigPaths = new Map<string, string>()
/** Hook settings files written at spawn (parallel to mcpConfigPaths). */
const hookSettingsPaths = new Map<string, string>()

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

/**
 * Write a Claude settings file wiring location-tracking hooks to the bridge.
 * Verified on CLI 2.1.175 (Stage 2 Part A): `--settings <path>` accepts a
 * `hooks` config; `type: "http"` hooks POST the hook input JSON (carrying
 * `session_id`, `cwd`, and — on `PostToolUse` — `tool_input`) to `url`. We
 * point both UserPromptSubmit (cheap, fires on every turn) and PostToolUse at
 * the bridge's `/<token>/hooks` endpoint — the token in the path authenticates
 * the same way the MCP tool-call route does. PostToolUse earns its keep twice:
 * it catches cwd moves (Bash `cd`/worktree tools) AND the `file_path` of a file
 * the agent read/edited in a sibling repo it never `cd`'d into (see
 * cwd-tracker's parseHookBody / mcp-bridge's handleHook).
 */
function writeHookSettings(terminalId: string, bridgePort: number, bridgeToken: string): string {
  const settingsPath = join(tmpdir(), `simpleedit-hooks-${terminalId}.json`)
  const endpoint = { type: 'http', url: `http://127.0.0.1:${bridgePort}/${bridgeToken}/hooks`, timeout: 5 }
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [endpoint] }],
      PostToolUse: [{ hooks: [endpoint] }],
    },
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return settingsPath
}

function cleanupHookSettings(terminalId: string): void {
  const settingsPath = hookSettingsPaths.get(terminalId)
  if (settingsPath) {
    try { unlinkSync(settingsPath) } catch { /* file may already be gone */ }
    hookSettingsPaths.delete(terminalId)
  }
}

/**
 * Wire MCP config + location-tracking hooks for a Claude spawn and register
 * the session_id → terminalId mapping so hook POSTs route back. Returns the
 * extra CLI flags to append. No-op (empty string) when no bridge is available
 * (e.g. tests, or a window whose bridge failed to start).
 */
function buildBridgeFlags(
  terminalId: string,
  sessionId: string,
  bridgePort: number | undefined,
  bridgeToken: string | undefined,
): string {
  if (bridgePort == null || bridgeToken == null) return ''
  let flags = ''
  const configPath = writeMcpConfig(terminalId, bridgePort, bridgeToken)
  mcpConfigPaths.set(terminalId, configPath)
  flags += ` --mcp-config ${configPath}`
  const settingsPath = writeHookSettings(terminalId, bridgePort, bridgeToken)
  hookSettingsPaths.set(terminalId, settingsPath)
  flags += ` --settings ${settingsPath}`
  registerSession(sessionId, terminalId)
  return flags
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
function claudeShellArgs(cmd: string): string[] {
  return process.env['SIMPLEEDIT_E2E'] === '1' ? ['-c', cmd] : ['-i', '-l', '-c', cmd]
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

export function spawnClaudeTerminal(
  options: ClaudeSpawnOptions,
  webContents: WebContents
): void {
  const { id, worktreePath, bridgePort, bridgeToken, resumeSessionId } = options

  if (terminals.has(id)) {
    return
  }
  if (!guardCwd(id, worktreePath, webContents)) return

  // No `--output-format stream-json`: the flag is silently ignored when stdin
  // is a TTY (which node-pty always provides) on CLI 2.1.148+. Session id
  // capture now flows through `--session-id <uuid>` below; see #95.
  let claudeCmd = 'claude'

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
  let sessionFlag: string
  if (resumeSessionId && /^[A-Za-z0-9_-]+$/.test(resumeSessionId)) {
    sessionId = resumeSessionId
    sessionFlag = ` --resume ${resumeSessionId}`
  } else {
    sessionId = randomUUID()
    sessionFlag = ` --session-id ${sessionId}`
  }

  // MCP config + location-tracking hooks (Stage 2). Registers the
  // session_id → terminalId mapping so hook POSTs route back here.
  claudeCmd += buildBridgeFlags(id, sessionId, bridgePort, bridgeToken)
  claudeCmd += sessionFlag

  const shell = defaultShell()
  // -i -l: interactive login shell so both ~/.zprofile and ~/.zshrc are sourced,
  // ensuring claude is on PATH regardless of how it was installed.
  const term = pty.spawn(shell, claudeShellArgs(claudeCmd), getPtyOptions(worktreePath))

  terminals.set(id, term)

  if (!webContents.isDestroyed()) {
    webContents.send('claude:session-id', { terminalId: id, sessionId })
  }

  term.onData((data: string) => {
    emitPtyData(id, data)
    const offset = recordBacklog(id, data)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:data', { id, data, offset })
    }
  })

  term.onExit(({ exitCode }: { exitCode: number }) => {
    cleanupMcpConfig(id)
    cleanupHookSettings(id)
    unregisterTerminal(id)
    terminals.delete(id)
    if (!webContents.isDestroyed()) {
      // Clear the worktree's Claude status so the worktree picker (#87) and
      // sidebar badges don't show stale 'running' for an exited tab. The
      // status is per-worktreePath, so this only fires when the LAST Claude
      // tab for this worktree exits — earlier exits leave the status as
      // whichever still-alive tab last reported. Acceptable: the indicator
      // tracks "is *any* Claude active here", not "is this specific tab".
      webContents.send('claude:status', { worktreePath, status: 'idle', terminalId: id })
      webContents.send('pty:exit', { id, exitCode })
    }
  })
}

/**
 * Spawn a forked Claude session in `targetWorktreePath`, resuming from
 * `sourceSessionId` and pinning the new session to `forkUuid`.
 *
 * The CLI silently no-ops (just appends to the source) if forkUuid ===
 * sourceSessionId — the caller (handler in index.ts) MUST verify they differ
 * before invoking us. We assert defensively here too.
 *
 * No MCP bridge is wired up: the fork's session id is already known (it's
 * `forkUuid`), so the renderer skips the broken-on-2.1.148 stream-json
 * session-id scrape entirely and populates sessionRestoreStore directly.
 * The stream parser IS attached by the caller (claude-fork.ts:performFork
 * via attachToTerminal) so OSC-title status events still drive the
 * worktree's Claude status indicator — see #103.
 */
export function spawnForkedClaudeTerminal(
  args: {
    placeholderTabId: string
    sourceSessionId: string
    targetWorktreePath: string
    forkUuid: string
    bridgePort?: number
    bridgeToken?: string
  },
  webContents: WebContents,
): void {
  const { placeholderTabId, sourceSessionId, targetWorktreePath, forkUuid, bridgePort, bridgeToken } = args

  if (forkUuid === sourceSessionId) {
    // Programmer error — would silently append to the source instead of
    // forking. Caller has primary responsibility, but defending here too.
    throw new Error(
      `spawnForkedClaudeTerminal: forkUuid must differ from sourceSessionId (${forkUuid})`,
    )
  }
  if (terminals.has(placeholderTabId)) return
  if (!guardCwd(placeholderTabId, targetWorktreePath, webContents)) return

  // Flag order verified empirically on CLI 2.1.148 (critic's pre-PR4 audit §4):
  // all three orderings of --session-id / --resume / --fork-session work.
  // Using the form that reads "fork the source session as a new id".
  // No `--output-format stream-json`: it's silently ignored under a TTY on
  // 2.1.148+ (see #95/#106), and session-id is pinned via --session-id below,
  // so the flag was dead weight. (#107)
  // MCP config + location-tracking hooks for the fork, same as a fresh spawn
  // (Stage 2) — the fork's session id is `forkUuid`, registered for hook
  // routing. The bridge wasn't previously wired here (see #87 history); it is
  // now so the fork's UI-driving tools and cwd tracking work like any session.
  const bridgeFlags = buildBridgeFlags(placeholderTabId, forkUuid, bridgePort, bridgeToken)

  const claudeCmd =
    `claude --session-id ${forkUuid}` +
    ` --resume ${sourceSessionId}` +
    ` --fork-session` +
    bridgeFlags

  const shell = defaultShell()
  const term = pty.spawn(shell, claudeShellArgs(claudeCmd), getPtyOptions(targetWorktreePath))

  terminals.set(placeholderTabId, term)

  term.onData((data: string) => {
    emitPtyData(placeholderTabId, data)
    const offset = recordBacklog(placeholderTabId, data)
    if (!webContents.isDestroyed()) {
      webContents.send('pty:data', { id: placeholderTabId, data, offset })
    }
  })

  term.onExit(({ exitCode }: { exitCode: number }) => {
    cleanupMcpConfig(placeholderTabId)
    cleanupHookSettings(placeholderTabId)
    unregisterTerminal(placeholderTabId)
    terminals.delete(placeholderTabId)
    if (!webContents.isDestroyed()) {
      webContents.send('claude:status', {
        worktreePath: targetWorktreePath,
        status: 'idle',
        terminalId: placeholderTabId,
      })
      webContents.send('pty:exit', { id: placeholderTabId, exitCode })
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
  if (!guardCwd(id, worktreePath, webContents)) return

  const shell = defaultShell()
  const term = pty.spawn(shell, claudeShellArgs('claude agents'), getPtyOptions(worktreePath))

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
  // the config and backlog still need dropping when the session closes.
  cleanupMcpConfig(id)
  cleanupHookSettings(id)
  unregisterTerminal(id)
  backlogs.delete(id)
}

export function getActiveTerminalIds(): string[] {
  return Array.from(terminals.keys())
}

export function killAllTerminals(): void {
  for (const [id, term] of terminals) {
    try { term.kill() } catch { /* process may already be dead */ }
    cleanupMcpConfig(id)
    cleanupHookSettings(id)
    unregisterTerminal(id)
    terminals.delete(id)
  }
  backlogs.clear()
}
