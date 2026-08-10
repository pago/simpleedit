import { app } from 'electron'
import { join } from 'path'
import type { ReasoningEffort } from '../../shared/ipc-types'
import { registerProvider, type AgentProvider, type LaunchContext, type LaunchPlan } from './provider'

function mcpServerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'mcp-server', 'index.mjs')
    : join(app.getAppPath(), 'out', 'mcp-server', 'index.mjs')
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function config(key: string, value: string): string[] {
  return ['-c', `${key}=${value}`]
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(', ')} }`
}

/**
 * Lifecycle events we ask Codex to report. Each goes in its own single-element
 * `-c hooks.<Event>=[…]`, so every trust key ends `:0:0` and this order does not
 * affect them.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const

/**
 * The hook command Codex is asked to run. It must stay byte-identical across
 * launches.
 *
 * Codex refuses to run a hook whose `trustStatus` isn't `trusted`, silently,
 * and records a grant as `trusted_hash` under
 * `[hooks.state."<source>:<snake_event>:<group>:<handler>"]`. The command is an
 * input to that hash — not the only one; the six events here produce six
 * different hashes from one identical command, so the event is mixed in too.
 * What matters is that the hash is STABLE for a given command: put anything
 * session-specific (bridge port, token, terminal id) in it and every launch
 * re-rolls it, permanently invalidating the grant the user just made. Hence the
 * reporter takes its bridge coordinates from the environment instead.
 *
 * Verified against codex-cli 0.146.0 over the app-server `hooks/list` RPC:
 * identical command ⇒ identical `currentHash` across sessions with differing
 * bridge env, and exactly six persisted grants rather than six per launch.
 */
export function hookCommand(serverPath: string): string {
  return `node ${shellQuote(serverPath)} --codex-hook-reporter`
}

/** The bridge coordinates the hook reporter and MCP server both need. */
function bridgeEnvFor(ctx: LaunchContext): Record<string, string> {
  return {
    SIMPLEEDIT_BRIDGE_PORT: String(ctx.bridgePort),
    SIMPLEEDIT_BRIDGE_TOKEN: String(ctx.bridgeToken),
    SIMPLEEDIT_TERMINAL_ID: ctx.terminalId,
  }
}

function bridgeArgs(ctx: LaunchContext): string[] {
  if (ctx.bridgePort == null || ctx.bridgeToken == null) return []

  const server = mcpServerPath()
  const args = [
    ...config('mcp_servers.simpleedit.command', tomlString('node')),
    ...config('mcp_servers.simpleedit.args', JSON.stringify([server])),
    ...config('mcp_servers.simpleedit.env', tomlInlineTable(bridgeEnvFor(ctx))),
  ]

  // timeout 3, not 5: Codex clamps SessionEnd to 3s and warns about anything
  // higher, and a uniform value keeps every event's trust hash identical.
  const hook = `[{ hooks = [{ type = "command", command = ${tomlString(hookCommand(server))}, timeout = 3 }] }]`
  for (const event of HOOK_EVENTS) {
    args.push(...config(`hooks.${event}`, hook))
  }
  return args
}

function validId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:/-]+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
}

function buildLaunch(ctx: LaunchContext): LaunchPlan {
  const model = ctx.target?.provider === 'codex' ? ctx.target.model : undefined
  const effort: ReasoningEffort | undefined =
    ctx.target?.provider === 'codex' ? ctx.target.reasoningEffort : ctx.reasoningEffort
  const args = ['-C', ctx.worktreePath, ...bridgeArgs(ctx)]

  if (model) args.push('--model', validId(model, 'model id'))
  if (effort) args.push(...config('model_reasoning_effort', tomlString(effort)))

  if (ctx.resumeSessionId) {
    args.push(ctx.forkSession ? 'fork' : 'resume', validId(ctx.resumeSessionId, 'session id'))
  }
  if (ctx.initialPrompt) args.push(ctx.initialPrompt)

  // The bridge coordinates ride in the env rather than the hook command so the
  // command — and therefore its trust hash — stays stable (see hookCommand).
  // `renderLaunchCommand` prefixes these inline at the login-shell boundary, so
  // a user's ~/.zshrc cannot clobber them, and Codex's hook subprocesses
  // inherit them.
  const env = ctx.bridgePort != null && ctx.bridgeToken != null ? bridgeEnvFor(ctx) : undefined

  return { executable: 'codex', args, ...(env ? { env } : {}) }
}

export const codexProvider = {
  id: 'codex',
  buildLaunch,
  capabilities: {
    status: 'precise',
    resume: true,
    fork: true,
    tracking: 'full',
    mcp: true,
    modelOverride: 'native',
    shiftEnter: 'native',
    droppedPath: 'at-reference',
    gracefulShutdown: true,
    displayName: 'Codex',
    // Codex's OSC title is the working directory (prefixed with a braille
    // spinner while busy), not a conversation name — verified against
    // codex-cli 0.146.0. Letting it through would rename the session to the
    // directory on every turn.
    oscTitle: 'directory',
    // Codex will not run our hooks until the user trusts their command hash
    // once (and trusts the project directory once). Until then reporting
    // falls back to coarse PTY signals.
    reportingSetup: 'user-granted',
    modelSelector: 'model-id',
    reasoningEffort: true,
    modelCatalog: true,
    reportsSessionTitle: false,
  },
} satisfies AgentProvider

registerProvider(codexProvider)
