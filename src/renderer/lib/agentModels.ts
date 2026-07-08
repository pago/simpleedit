/**
 * The models an interactive agent session can run on — the Claude cloud catalog
 * plus tool-capable installed Ollama models (review-only local models can't drive
 * the interactive agent, so they're excluded). Shared by the model split buttons.
 */
import type { ClaudeModel, ModelDescriptor, ModelRef } from '../../shared/ipc-types'

export interface AgentModel {
  id: string
  label: string
  tier: 'cloud' | 'local'
  /** Absent = the CLI's default model (no `--model` flag). */
  ref?: ModelRef
}

export async function loadAgentModels(): Promise<AgentModel[]> {
  const [claude, installed]: [ClaudeModel[], ModelDescriptor[]] = await Promise.all([
    window.api.invoke('models:claude'),
    window.api.invoke('models:installed').catch(() => [] as ModelDescriptor[]),
  ])
  const cloud: AgentModel[] = claude.map((m) => ({
    id: `anthropic:${m.model}`,
    label: m.displayName,
    tier: 'cloud',
    ref: { provider: 'anthropic', model: m.model },
  }))
  const local: AgentModel[] = installed
    .filter((m) => m.toolCapable)
    .map((m) => ({ id: `ollama:${m.name}`, label: m.name, tier: 'local', ref: { provider: 'ollama', model: m.name } }))
  return [...cloud, ...local]
}
