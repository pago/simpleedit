/**
 * Pluggable interactive-agent providers. A provider is a main-process adapter
 * capturing everything that varies per agent (launch command/env, status
 * signal, resume/fork, tracking/MCP wiring) plus a capability descriptor so the
 * UI can degrade gracefully. Claude Code is the first (and, today, only)
 * provider — see `claude.ts`, which self-registers on import.
 */
import type { ClaudeStatus, ModelRef } from '../../shared/ipc-types'

/** Inputs for a fresh (or resumed) agent launch. */
export interface LaunchContext {
  terminalId: string
  worktreePath: string
  resumeSessionId?: string
  /**
   * Full-context fork: with `resumeSessionId`, mint a fresh session id that
   * forks the source (`--fork-session`) rather than continuing it. Distinct
   * from a plain resume. Ignored without `resumeSessionId`.
   */
  forkSession?: boolean
  bridgePort?: number
  bridgeToken?: string
  /**
   * Which brain to run against (fresh-spawn only). `ollama` prefixes the
   * ANTHROPIC_BASE_URL env override inline on the command; `anthropic` just
   * adds `--model` and keeps normal cloud auth. Absent = cloud default.
   */
  model?: ModelRef
  /** Seed the session with this first message (appended as claude's positional
   *  prompt arg). Fresh spawn only. */
  initialPrompt?: string
}

/**
 * Everything the PTY layer needs to launch an agent: the shell command, any
 * extra env to merge over `process.env`, the session id (known before launch),
 * and a cleanup to run when the PTY exits or is killed (e.g. removing temp
 * config files and unregistering hook routing).
 */
export interface LaunchPlan {
  command: string
  env?: Record<string, string>
  sessionId: string
  cleanup?: () => void
}

export interface AgentCapabilities {
  status: 'osc' | 'basic'
  resume: boolean
  fork: boolean
  tracking: 'full' | 'cwd-only' | 'none'
  mcp: boolean
  modelOverride: 'env' | 'native' | 'none'
}

export interface AgentProvider {
  id: 'claude' | 'opencode' | 'antigravity'
  buildLaunch(ctx: LaunchContext): LaunchPlan
  /** Turn a raw PTY output chunk into a status, or null when unrecognised. */
  detectStatus?(chunk: string): ClaudeStatus | null
  capabilities: AgentCapabilities
}

const providers = new Map<string, AgentProvider>()

export function registerProvider(provider: AgentProvider): void {
  providers.set(provider.id, provider)
}

export function getProvider(id: string): AgentProvider {
  const provider = providers.get(id)
  if (!provider) {
    throw new Error(`Unknown agent provider: ${id}`)
  }
  return provider
}
