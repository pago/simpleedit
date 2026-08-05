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

function bridgeArgs(ctx: LaunchContext): string[] {
  if (ctx.bridgePort == null || ctx.bridgeToken == null) return []

  const server = mcpServerPath()
  const bridgeEnv = {
    SIMPLEEDIT_BRIDGE_PORT: String(ctx.bridgePort),
    SIMPLEEDIT_BRIDGE_TOKEN: ctx.bridgeToken,
    SIMPLEEDIT_TERMINAL_ID: ctx.terminalId,
  }
  const args = [
    ...config('mcp_servers.simpleedit.command', tomlString('node')),
    ...config('mcp_servers.simpleedit.args', JSON.stringify([server])),
    ...config('mcp_servers.simpleedit.env', tomlInlineTable(bridgeEnv)),
  ]

  const reporter = [
    `SIMPLEEDIT_BRIDGE_PORT=${shellQuote(String(ctx.bridgePort))}`,
    `SIMPLEEDIT_BRIDGE_TOKEN=${shellQuote(ctx.bridgeToken)}`,
    `SIMPLEEDIT_TERMINAL_ID=${shellQuote(ctx.terminalId)}`,
    'node',
    shellQuote(server),
    '--codex-hook-reporter',
  ].join(' ')
  const hook = `[{ hooks = [{ type = "command", command = ${tomlString(reporter)}, timeout = 5 }] }]`
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd']) {
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

  return { executable: 'codex', args }
}

export const codexProvider: AgentProvider = {
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
  },
}

registerProvider(codexProvider)
