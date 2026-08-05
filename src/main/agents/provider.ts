/**
 * Pluggable interactive-agent providers. A provider is a main-process adapter
 * capturing everything that varies per agent (launch command/env, status
 * signal, resume/fork, tracking/MCP wiring) plus a capability descriptor so the
 * UI can degrade gracefully. Claude Code and Codex self-register from their
 * provider modules.
 */
import type { AgentCapabilities, AgentProviderId, AgentStatus, InteractiveTarget, ModelRef, ReasoningEffort } from '../../shared/ipc-types'

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
  /** Seed the session with the provider's positional prompt argument. */
  initialPrompt?: string
  provider?: AgentProviderId
  reasoningEffort?: ReasoningEffort
  target?: InteractiveTarget
}

/**
 * Everything the PTY layer needs to launch an agent: the shell command, any
 * extra env to merge over `process.env`, the session id (known before launch),
 * and a cleanup to run when the PTY exits or is killed (e.g. removing temp
 * config files and unregistering hook routing).
 */
export interface LaunchPlan {
  executable: string
  args: string[]
  env?: Record<string, string>
  sessionId?: string
  cleanup?: () => void
}

export interface AgentProvider {
  id: AgentProviderId
  buildLaunch(ctx: LaunchContext): LaunchPlan
  /** Turn a raw PTY output chunk into a status, or null when unrecognised. */
  detectStatus?(chunk: string): AgentStatus | null
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

/**
 * Every provider that has registered itself. The renderer reads this at startup
 * to discover which agents exist and cache their capabilities, so a new
 * provider module surfaces in the UI purely by importing it in `pty.ts` — no
 * renderer-side list to keep in sync.
 */
export function registeredProviderIds(): AgentProviderId[] {
  return [...providers.keys()] as AgentProviderId[]
}
