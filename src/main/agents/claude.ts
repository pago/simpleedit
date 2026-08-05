/**
 * The Claude Code agent provider. Owns everything Claude-specific about a
 * launch: the `claude` binary + flags, the `--session-id`/`--resume`/
 * `--fork-session` branching, the MCP gen-UI bridge (`--mcp-config`) and the
 * location-tracking hooks (`--settings`), plus their temp-file cleanup. The
 * generic PTY plumbing (spawn, backlog, onData/onExit) stays in `pty.ts`; this
 * module just produces `LaunchPlan`s and the capability descriptor.
 */
import { app } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ClaudeStatus } from '../../shared/ipc-types'
import { extractOscTitles, statusFromTitle } from '../claude-stream'
import { registerSession, unregisterTerminal } from '../cwd-tracker'
import { registerProvider, type AgentProvider, type LaunchContext, type LaunchPlan } from './provider'

const mcpConfigPaths = new Map<string, string>()
/** Hook settings files written at spawn (parallel to mcpConfigPaths). */
const hookSettingsPaths = new Map<string, string>()

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
  // Stop carries the agent-messaging channel (see agent-bus.ts): its response
  // body can deliver queued peer mail, and its `last_assistant_message` is how
  // the turn's answer gets routed back to whoever asked.
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [endpoint] }],
      PostToolUse: [{ hooks: [endpoint] }],
      Stop: [{ hooks: [endpoint] }],
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

/**
 * Cleanup run on PTY exit or kill: drop the temp MCP-config + hook-settings
 * files and forget the session→terminal hook routing. All three are no-ops when
 * nothing was wired (no bridge), matching the previous unconditional cleanup.
 */
function makeCleanup(terminalId: string): () => void {
  return () => {
    cleanupMcpConfig(terminalId)
    cleanupHookSettings(terminalId)
    unregisterTerminal(terminalId)
  }
}

/**
 * Build the launch plan for a fresh or resumed Claude session.
 *
 * No `--output-format stream-json`: the flag is silently ignored when stdin is
 * a TTY (which node-pty always provides) on CLI 2.1.148+. Session id capture
 * flows through `--session-id <uuid>`; see #95.
 *
 * We pin the session id we want claude to use. For fresh tabs we generate a
 * UUID and tell claude to use it via `--session-id`; for resumed tabs the id is
 * already known from the resume arg. Either way the session id is known to
 * SimpleEdit *before* claude has written anything. Note: claude rejects
 * `--session-id <new>` alongside `--resume <existing>` unless `--fork-session`
 * is also passed; the resume path therefore does not set `--session-id` and
 * reuses the resumed id directly.
 *
 * The FORK branch (`forkSession` + `resumeSessionId`) is deliberately distinct
 * from resume: it mints a FRESH id AND adds `--fork-session`, so the source
 * session is branched into a new, independent, full-context session with the
 * source left intact. Reusing the resume branch (id = source, `--resume` alone)
 * would silently APPEND to the source and corrupt the parent — so this must
 * never fall through to it.
 */
function buildLaunch(ctx: LaunchContext): LaunchPlan {
  const { terminalId, resumeSessionId, forkSession, bridgePort, bridgeToken, model, initialPrompt } = ctx

  let command = 'claude'
  // Only `ollama` swaps the brain via an inline env override. It is prefixed
  // INLINE on the command string (not the pty env object) so a login shell's
  // ~/.zshrc can't clobber ANTHROPIC_BASE_URL/API_KEY after the env is set.
  // Both endpoint and model land in a shell `-c` string, so validate before
  // interpolating — treat them as injection surface.
  //
  // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 is required for local Ollama:
  // Claude Code otherwise probes `/v1/messages/count_tokens`, which Ollama 404s,
  // and that 404 poisons Ollama's `/v1/messages` handler so every subsequent
  // request hangs indefinitely (Ollama #13949). Disabling the non-essential
  // probe sidesteps the poison entirely — verified: without it the session hangs
  // with no output; with it a local session works.
  if (model?.provider === 'ollama') {
    const endpoint = model.endpoint ?? 'http://localhost:11434'
    if (!/^https?:\/\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._~/-]*)?$/.test(endpoint)) {
      throw new Error(`Invalid Ollama endpoint: ${endpoint}`)
    }
    command = `ANTHROPIC_BASE_URL=${endpoint} ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY= CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude`
  }

  let sessionId: string
  let sessionFlag: string
  const validResume = !!resumeSessionId && /^[A-Za-z0-9_-]+$/.test(resumeSessionId)
  if (forkSession && validResume) {
    // Fork: fresh id forks the source. NOT the resume/append branch — mixing
    // them up corrupts the parent (see the doc comment above).
    sessionId = randomUUID()
    sessionFlag = ` --session-id ${sessionId} --resume ${resumeSessionId} --fork-session`
  } else if (validResume) {
    sessionId = resumeSessionId!
    sessionFlag = ` --resume ${resumeSessionId}`
  } else {
    sessionId = randomUUID()
    sessionFlag = ` --session-id ${sessionId}`
  }

  // MCP config + location-tracking hooks (Stage 2). Registers the
  // session_id → terminalId mapping so hook POSTs route back here.
  command += buildBridgeFlags(terminalId, sessionId, bridgePort, bridgeToken)
  command += sessionFlag

  if (model?.model) {
    if (!/^[A-Za-z0-9._:/-]+$/.test(model.model)) throw new Error(`Invalid model id: ${model.model}`)
    command += ` --model ${model.model}`
  }

  // Positional prompt = claude's first interactive message (seeds "Discuss with
  // Agent" with the review brief). MUST be last. Single-quote and escape so the
  // multi-line brief survives the login-shell `-c` string as one literal arg.
  if (initialPrompt) {
    command += ` '${initialPrompt.replace(/'/g, "'\\''")}'`
  }

  return { command, sessionId, env: messagingEnv(), cleanup: makeCleanup(terminalId) }
}

/**
 * Env the agent-messaging channel needs.
 *
 * `MCP_TOOL_TIMEOUT` — `send_message(wait_for_reply)` parks up to
 * MAX_REPLY_WAIT_S (600s) waiting on a peer's turn to finish, which far exceeds
 * the CLI's default tool timeout; without this the call is killed mid-wait.
 *
 * `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` — each delivery consumes one consecutive
 * Stop-hook block, and the default cap is 8. Raising it keeps a long exchange
 * from tripping the CLI's runaway-hook guard. It only ever fires when a hook
 * blocks repeatedly, which for us means real queued mail.
 */
function messagingEnv(): Record<string, string> {
  return {
    MCP_TOOL_TIMEOUT: String(660_000),
    CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '32',
  }
}

/**
 * Build the launch plan for `claude agents` — the interactive TUI for
 * inspecting / managing Claude Code agents. Unlike a normal Claude spawn this
 * wires no MCP bridge, no hooks, and captures no session id: agents is purely
 * TUI-driven and emits no machine-readable stream.
 */
export function buildAgentsLaunch(): { command: string } {
  return { command: 'claude agents' }
}

export const claudeProvider: AgentProvider = {
  id: 'claude',
  buildLaunch,
  detectStatus(chunk: string): ClaudeStatus | null {
    let status: ClaudeStatus | null = null
    for (const title of extractOscTitles(chunk)) {
      const s = statusFromTitle(title)
      if (s !== null) status = s
    }
    return status
  },
  capabilities: {
    status: 'osc',
    resume: true,
    fork: true,
    tracking: 'full',
    mcp: true,
    modelOverride: 'env',
  },
}

registerProvider(claudeProvider)
