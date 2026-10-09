/**
 * The fields of a provider/model/reasoning picker, and the `InteractiveTarget`
 * they stand for. Whether a provider takes an effort is what its descriptor
 * says; Claude is the one provider whose model is a structured `ModelRef`.
 */
import type { AgentCapabilities, AgentProviderId, InteractiveTarget, ModelRef, ReasoningEffort } from '../../shared/ipc-types'

export interface TargetFields {
  provider: AgentProviderId
  modelId: string
  /** '' = the model's default. */
  reasoningEffort: string
  /**
   * The Claude model the fields were read from. Kept so a model the picker
   * can't express — a local Ollama one, an endpoint — survives a save that
   * didn't change it, instead of coming back as an Anthropic id.
   */
  ref?: ModelRef
}

export function fieldsFromTarget(target: InteractiveTarget | undefined, fallback: AgentProviderId = 'claude'): TargetFields {
  if (!target) return { provider: fallback, modelId: '', reasoningEffort: '' }
  if (target.provider === 'claude') {
    return { provider: 'claude', modelId: target.model?.model ?? '', reasoningEffort: '', ...(target.model ? { ref: target.model } : {}) }
  }
  return { provider: target.provider, modelId: target.model ?? '', reasoningEffort: target.reasoningEffort ?? '' }
}

export function targetFromFields(fields: TargetFields, caps: AgentCapabilities | undefined): InteractiveTarget {
  const modelId = fields.modelId.trim()
  if (fields.provider === 'claude') {
    if (!modelId) return { provider: 'claude' }
    const model: ModelRef = fields.ref && fields.ref.model === modelId ? fields.ref : { provider: 'anthropic', model: modelId }
    return { provider: 'claude', model }
  }
  // Capabilities not loaded yet: keep what was picked rather than guess it away.
  const takesEffort = caps ? caps.reasoningEffort : true
  return {
    provider: fields.provider,
    ...(modelId ? { model: modelId } : {}),
    ...(takesEffort && fields.reasoningEffort ? { reasoningEffort: fields.reasoningEffort as ReasoningEffort } : {}),
  }
}
