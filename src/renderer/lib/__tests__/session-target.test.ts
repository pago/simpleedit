import { describe, it, expect } from 'vitest'
import { fieldsFromTarget, targetFromFields } from '../session-target'
import type { AgentCapabilities } from '../../../shared/ipc-types'

const native = { modelSelector: 'model-id', reasoningEffort: true } as AgentCapabilities
const claude = { modelSelector: 'model-ref', reasoningEffort: false } as AgentCapabilities

describe('session target fields', () => {
  it('keeps the picked native provider instead of assuming Codex', () => {
    expect(targetFromFields({ provider: 'opencode', modelId: 'deepseek', reasoningEffort: 'high' }, native)).toEqual({
      provider: 'opencode',
      model: 'deepseek',
      reasoningEffort: 'high',
    })
  })

  it('makes a Claude model a ModelRef and drops an effort it does not take', () => {
    expect(targetFromFields({ provider: 'claude', modelId: ' opus ', reasoningEffort: 'high' }, claude)).toEqual({
      provider: 'claude',
      model: { provider: 'anthropic', model: 'opus' },
    })
  })

  it('keeps a local Claude model it was read from, and makes a typed one Anthropic', () => {
    const local = { provider: 'claude' as const, model: { provider: 'ollama' as const, model: 'qwen3:8b', endpoint: 'http://box:11434' } }
    expect(targetFromFields(fieldsFromTarget(local), claude)).toEqual(local)
    expect(targetFromFields({ ...fieldsFromTarget(local), modelId: 'opus' }, claude)).toEqual({
      provider: 'claude',
      model: { provider: 'anthropic', model: 'opus' },
    })
  })

  it('builds the picked provider even before its capabilities load', () => {
    expect(targetFromFields({ provider: 'codex', modelId: 'gpt-5.5', reasoningEffort: 'high' }, undefined)).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    })
  })

  it('round-trips a target', () => {
    const t = { provider: 'codex' as const, model: 'gpt-5.5', reasoningEffort: 'low' as const }
    expect(targetFromFields(fieldsFromTarget(t), native)).toEqual(t)
    expect(fieldsFromTarget(undefined, 'codex')).toEqual({ provider: 'codex', modelId: '', reasoningEffort: '' })
  })
})
