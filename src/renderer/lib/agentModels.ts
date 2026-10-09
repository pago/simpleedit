/**
 * The models an interactive agent session can run on — the Claude cloud catalog
 * plus tool-capable installed Ollama models (review-only local models can't drive
 * the interactive agent, so they're excluded). Shared by the model split buttons.
 */
import type { ClaudeModel, CodexModel, InteractiveTarget, ModelDescriptor, ModelRef, OpenCodeModel } from '../../shared/ipc-types'

export interface AgentModel {
  id: string
  label: string
  tier: 'cloud' | 'local'
  /** Absent = the CLI's default model (no `--model` flag). */
  ref?: ModelRef
  target: InteractiveTarget
}

export async function loadAgentModels(): Promise<AgentModel[]> {
  const [claude, codex, installed]: [ClaudeModel[], CodexModel[], ModelDescriptor[]] = await Promise.all([
    window.api.invoke('models:claude'),
    window.api.invoke('models:codex').catch(() => [] as CodexModel[]),
    window.api.invoke('models:installed').catch(() => [] as ModelDescriptor[]),
  ])
  const cloud: AgentModel[] = claude.map((m) => ({
    id: `anthropic:${m.model}`,
    label: m.displayName,
    tier: 'cloud',
    ref: { provider: 'anthropic', model: m.model },
    target: { provider: 'claude', model: { provider: 'anthropic', model: m.model } },
  }))
  const codexCloud: AgentModel[] = [
    { id: 'openai:configured-default', label: 'Codex · configured default', tier: 'cloud', ref: { provider: 'openai' }, target: { provider: 'codex' } },
    ...codex.map((m) => ({
      id: `openai:${m.model}`,
      label: `Codex · ${m.displayName}`,
      tier: 'cloud' as const,
      ref: { provider: 'openai' as const, model: m.model },
      target: { provider: 'codex' as const, model: m.model },
    })),
  ]
  const local: AgentModel[] = installed
    .filter((m) => m.toolCapable)
    .map((m) => ({ id: `ollama:${m.name}`, label: m.name, tier: 'local' as const, ref: { provider: 'ollama' as const, model: m.name }, target: { provider: 'claude' as const, model: { provider: 'ollama' as const, model: m.name } } }))
  return [...cloud, ...codexCloud, ...local]
}

/** A model the user picked in Settings → Models for the new-session menu. */
export interface AllowlistedModel {
  /** The allowlist entry: a catalog model id, or an installed Ollama model's name. */
  key: string
  /** E.g. `Claude · Opus`. */
  label: string
  target: InteractiveTarget
}

/**
 * Resolve the Settings → Models allowlist (`submenuAllowlist`) against the live
 * catalogs, in allowlist order. A Claude, Codex or OpenCode entry's key is its
 * model id; an installed Ollama model's key is its name (tool-capable ones only:
 * review-only models can't drive the interactive agent). Keys that no longer
 * resolve (uninstalled, dropped from a catalog) are skipped. Rejects when the
 * config or the Claude catalog can't be read; a missing Codex, OpenCode or
 * Ollama only drops its entries.
 *
 * Discovery shells out to CLIs, so callers share one load while it runs.
 */
export function loadAllowlistedModels(): Promise<AllowlistedModel[]> {
  if (!allowlistLoad) {
    lastAllowlistLoad = Date.now()
    allowlistLoad = resolveAllowlist().finally(() => (allowlistLoad = null))
  }
  return allowlistLoad
}

/** Window focus comes often; a catalog that changed meanwhile can wait this long. */
const FOCUS_REFRESH_MS = 30_000
let allowlistLoad: Promise<AllowlistedModel[]> | null = null
let lastAllowlistLoad = -Infinity

/** `loadAllowlistedModels` for a window-focus refresh: null when the last load is under 30 s old. */
export function refreshAllowlistedModelsOnFocus(now = Date.now()): Promise<AllowlistedModel[]> | null {
  if (!allowlistLoad && now - lastAllowlistLoad < FOCUS_REFRESH_MS) return null
  return loadAllowlistedModels()
}

export function _resetAllowlistedModelsForTests(): void {
  allowlistLoad = null
  lastAllowlistLoad = -Infinity
}

async function resolveAllowlist(): Promise<AllowlistedModel[]> {
  const [config, claude, codex, openCode, installed]: [
    { submenuAllowlist: string[] },
    ClaudeModel[],
    CodexModel[],
    OpenCodeModel[],
    ModelDescriptor[],
  ] = await Promise.all([
    window.api.invoke('models:config-get'),
    window.api.invoke('models:claude'),
    window.api.invoke('models:codex').catch(() => [] as CodexModel[]),
    window.api.invoke('models:opencode').catch(() => [] as OpenCodeModel[]),
    // Throws while Ollama is down.
    window.api.invoke('models:installed').catch(() => [] as ModelDescriptor[]),
  ])
  const resolver = new Map<string, Omit<AllowlistedModel, 'key'>>()
  for (const m of claude) {
    resolver.set(m.model, { target: { provider: 'claude', model: { provider: 'anthropic', model: m.model } }, label: `Claude · ${m.displayName}` })
  }
  for (const m of codex) resolver.set(m.model, { target: { provider: 'codex', model: m.model }, label: `Codex · ${m.displayName}` })
  for (const m of openCode) resolver.set(m.model, { target: { provider: 'opencode', model: m.model }, label: `OpenCode · ${m.displayName}` })
  // Tool-capable local models are startable interactively now that the
  // Ollama #13949 hang is fixed (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).
  for (const m of installed) {
    if (!m.toolCapable) continue
    resolver.set(m.name, { target: { provider: 'claude', model: { provider: 'ollama', model: m.name } }, label: `Claude · ${m.name}` })
  }
  return config.submenuAllowlist.flatMap((key) => {
    const hit = resolver.get(key)
    return hit ? [{ key, ...hit }] : []
  })
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
  )
}

/**
 * A target as a `<select>` value: `''` for none (the default agent). Keys are
 * sorted, so main's copy of a target (rebuilt field by field) and the picker's
 * give the same key.
 */
export function targetKey(target: InteractiveTarget | null | undefined): string {
  return target ? JSON.stringify(canonical(target)) : ''
}

/** How a model picker names `target`, including one it doesn't list. */
export function targetLabel(
  target: InteractiveTarget | null | undefined,
  models: readonly { target: InteractiveTarget; label: string }[],
): string {
  if (!target) return 'Default'
  const key = targetKey(target)
  const listed = models.find((m) => targetKey(m.target) === key)
  if (listed) return listed.label
  const model = target.provider === 'claude' ? target.model?.model : target.model
  const agent = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }[target.provider]
  return `${agent} · ${model ?? 'default'}`
}
