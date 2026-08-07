/**
 * The models an interactive agent session can run on — the Claude cloud catalog
 * plus tool-capable installed Ollama models (review-only local models can't drive
 * the interactive agent, so they're excluded). Shared by the model split buttons.
 */
import type { ClaudeModel, CodexModel, InteractiveTarget, ModelDescriptor, ModelRef } from '../../shared/ipc-types'

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
