import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { _resetAllowlistedModelsForTests, loadAllowlistedModels, refreshAllowlistedModelsOnFocus, resolveSpawnModelRef, targetKey } from '../agentModels'

function stubModels(allowlist: string[], over: Record<string, unknown> = {}): void {
  const answers: Record<string, unknown> = {
    'models:config-get': { defaults: {}, submenuAllowlist: allowlist },
    'models:claude': [{ model: 'claude-opus', displayName: 'Opus' }],
    'models:codex': [{ model: 'gpt-5.5', displayName: 'GPT-5.5' }],
    'models:opencode': [{ provider: 'opencode', model: 'anthropic/sonnet', displayName: 'Sonnet', supportedReasoningEfforts: [] }],
    'models:installed': [
      { name: 'qwen3:8b', toolCapable: true },
      { name: 'gemma:2b', toolCapable: false },
    ],
    ...over,
  }
  vi.stubGlobal('api', {
    invoke: vi.fn(async (channel: string) => {
      const answer = answers[channel]
      if (answer instanceof Error) throw answer
      return answer
    }),
  })
}

beforeEach(() => _resetAllowlistedModelsForTests())
afterEach(() => vi.unstubAllGlobals())

describe('loadAllowlistedModels', () => {
  it('resolves the allowlist in its own order across every catalog, skipping what no longer resolves', async () => {
    stubModels(['qwen3:8b', 'anthropic/sonnet', 'gone-model', 'gemma:2b', 'gpt-5.5', 'claude-opus'])
    expect(await loadAllowlistedModels()).toEqual([
      { key: 'qwen3:8b', label: 'Claude · qwen3:8b', target: { provider: 'claude', model: { provider: 'ollama', model: 'qwen3:8b' } } },
      { key: 'anthropic/sonnet', label: 'OpenCode · Sonnet', target: { provider: 'opencode', model: 'anthropic/sonnet' } },
      { key: 'gpt-5.5', label: 'Codex · GPT-5.5', target: { provider: 'codex', model: 'gpt-5.5' } },
      { key: 'claude-opus', label: 'Claude · Opus', target: { provider: 'claude', model: { provider: 'anthropic', model: 'claude-opus' } } },
    ])
  })

  it('does without Codex, OpenCode or Ollama when they fail', async () => {
    stubModels(['qwen3:8b', 'gpt-5.5', 'claude-opus'], {
      'models:codex': new Error('no codex'),
      'models:opencode': new Error('no opencode'),
      'models:installed': new Error('Ollama is not running'),
    })
    expect((await loadAllowlistedModels()).map((m) => m.key)).toEqual(['claude-opus'])
  })

  it('shares a load in flight, and refreshes on window focus at most every 30 s', async () => {
    stubModels(['claude-opus'])
    const invoke = (window as unknown as { api: { invoke: ReturnType<typeof vi.fn> } }).api.invoke
    const configCalls = (): number => invoke.mock.calls.filter((c) => c[0] === 'models:config-get').length
    const first = loadAllowlistedModels()
    expect(loadAllowlistedModels()).toBe(first)
    expect(refreshAllowlistedModelsOnFocus()).toBe(first)
    await first
    expect(configCalls()).toBe(1)
    expect(refreshAllowlistedModelsOnFocus(Date.now() + 1_000)).toBeNull()
    await refreshAllowlistedModelsOnFocus(Date.now() + 31_000)
    expect(configCalls()).toBe(2)
    // The picker's own focus always rereads.
    await loadAllowlistedModels()
    expect(configCalls()).toBe(3)
  })
})

describe('targetKey', () => {
  it('gives the same key whatever order the fields come in', () => {
    expect(targetKey({ provider: 'claude', model: { provider: 'anthropic', model: 'x' } })).toBe(
      targetKey({ model: { model: 'x', provider: 'anthropic' }, provider: 'claude' }),
    )
    expect(targetKey(null)).toBe('')
  })
})

describe('resolveSpawnModelRef', () => {
  it('resolves prefixed and bare ids as spawn_session always has', async () => {
    stubModels([])
    expect(await resolveSpawnModelRef('anthropic:claude-opus')).toEqual({ provider: 'anthropic', model: 'claude-opus' })
    expect(await resolveSpawnModelRef('claude-opus')).toEqual({ provider: 'anthropic', model: 'claude-opus' })
    expect(await resolveSpawnModelRef('ollama:qwen3:8b')).toEqual({ provider: 'ollama', model: 'qwen3:8b' })
    expect(await resolveSpawnModelRef('qwen3:8b')).toEqual({ provider: 'ollama', model: 'qwen3:8b' })
    expect(await resolveSpawnModelRef('openai:gpt-5.5')).toEqual({ provider: 'openai', model: 'gpt-5.5' })
    expect(await resolveSpawnModelRef('gpt-5.5')).toEqual({ provider: 'openai', model: 'gpt-5.5' })
    expect(await resolveSpawnModelRef('openai:configured-default')).toEqual({ provider: 'openai' })
  })

  it('takes anything else as an Anthropic model', async () => {
    stubModels([])
    // Not tool-capable, so not a local model an agent can run on.
    expect(await resolveSpawnModelRef('gemma:2b')).toEqual({ provider: 'anthropic', model: 'gemma:2b' })
    expect(await resolveSpawnModelRef('claude-9')).toEqual({ provider: 'anthropic', model: 'claude-9' })
  })

  it('keeps the rest when Codex or Ollama is down, and falls back whole when Claude is', async () => {
    stubModels([], { 'models:codex': new Error('no codex'), 'models:installed': new Error('ollama down') })
    expect(await resolveSpawnModelRef('anthropic:claude-opus')).toEqual({ provider: 'anthropic', model: 'claude-opus' })
    expect(await resolveSpawnModelRef('qwen3:8b')).toEqual({ provider: 'anthropic', model: 'qwen3:8b' })
    stubModels([], { 'models:claude': new Error('claude down') })
    expect(await resolveSpawnModelRef('qwen3:8b')).toEqual({ provider: 'anthropic', model: 'qwen3:8b' })
    expect(await resolveSpawnModelRef('gpt-5.5')).toEqual({ provider: 'anthropic', model: 'gpt-5.5' })
  })
})
