/**
 * Pluggable interactive-agent providers. A provider is a main-process adapter
 * capturing everything that varies per agent (launch command/env, status
 * signal, resume/fork, tracking/MCP wiring) plus a capability descriptor so the
 * UI can degrade gracefully. Claude Code and Codex self-register from their
 * provider modules.
 */
import type { AgentCapabilities, AgentProviderId, AgentStatus, InteractiveTarget, ModelRef, ReasoningEffort } from '../../shared/ipc-types'
import type { HookSignal } from '../cwd-tracker'

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

/**
 * What a provider's post-spawn control channel reports back.
 *
 * Deliberately the SAME currency the hook-driven providers already speak: a
 * `HookSignal` goes through the identical handler a Claude or Codex hook POST
 * would, so an attached provider inherits cwd tracking, the touched-repo trail
 * and agent-to-agent messaging without reimplementing any of it. Only `status`
 * is separate, because a provider that reports status precisely should not have
 * to fake a hook event to say so.
 */
export interface AgentAttachSink {
  status(status: AgentStatus, message?: string): void
  signal(signal: HookSignal): void
  /** The provider-native session id, once known (minted server-side). */
  sessionId(sessionId: string): void
  /**
   * The agent's own name for this conversation, when it has one. Serves the
   * same purpose as Claude's OSC session-label — it just does not arrive over
   * the terminal, so it cannot ride `detectStatus`.
   */
  title(title: string): void
}

export interface AgentProvider {
  id: AgentProviderId
  /**
   * May be async: a provider can need real work before it knows its own
   * command line. OpenCode has to reserve a free TCP port to hand its embedded
   * server, and the OS is the only authority on which port is free. Providers
   * that need nothing (Claude, Codex) stay synchronous.
   */
  buildLaunch(ctx: LaunchContext): LaunchPlan | Promise<LaunchPlan>
  /** Turn a raw PTY output chunk into a status, or null when unrecognised. */
  detectStatus?(chunk: string): AgentStatus | null
  /**
   * Open a post-spawn control channel for a launched session.
   *
   * Claude and Codex report their lifecycle by calling *into* SimpleEdit (HTTP
   * hooks), so they need nothing here. OpenCode is the inverse: it exposes an
   * HTTP server on the port we launched it with, and SimpleEdit has to dial
   * *out* and subscribe. `buildLaunch` alone cannot express that — it returns
   * before the process exists — hence this seam.
   *
   * Called once after the PTY is spawned. The returned disposer runs on exit or
   * kill, in addition to `LaunchPlan.cleanup`.
   */
  attach?(plan: LaunchPlan, ctx: LaunchContext, sink: AgentAttachSink): () => void
  /**
   * Deliver text to a live session out-of-band, without writing PTY bytes.
   * Used by agent-to-agent messaging for providers that have no hook whose
   * response body can carry mail. Returns false when delivery is impossible.
   */
  deliverMessage?(terminalId: string, text: string): Promise<boolean>
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
 * Look up a provider without throwing. For callers where a provider is an
 * enhancement rather than a requirement — e.g. terminal attachment, which owns
 * the terminal→worktree mapping and only *also* wants status detection.
 */
export function tryGetProvider(id: string | undefined): AgentProvider | undefined {
  return id ? providers.get(id) : undefined
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
