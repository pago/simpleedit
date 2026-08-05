import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ModelConfig } from '../../../shared/ipc-types'

const tmpRoot = mkdtempSync(join(tmpdir(), 'simpleedit-models-test-'))

// Deep-review defaults injected by config.ts (mostly-local; types/architecture off).
const DEEP_DEFAULTS = {
  lenses: {
    soundness: { enabled: true },
    intent: { enabled: true },
    tests: { enabled: true },
    types: { enabled: false },
    architecture: { enabled: false },
  },
}

vi.mock('electron', () => ({
  app: { getPath: (_: string) => tmpRoot },
}))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

let getModelConfig: typeof import('../config').getModelConfig
let setModelConfig: typeof import('../config').setModelConfig

beforeEach(async () => {
  const mod = await import('../config')
  getModelConfig = mod.getModelConfig
  setModelConfig = mod.setModelConfig
})

describe('model config persistence', () => {
  it('returns defaults when no file exists', () => {
    expect(getModelConfig()).toEqual({ defaults: {}, submenuAllowlist: [], deepReview: DEEP_DEFAULTS })
  })

  it('round-trips a full config', () => {
    const cfg: ModelConfig = {
      defaults: {
        review: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
        interactive: { provider: 'anthropic', model: 'claude-sonnet' },
        tour: { provider: 'openai', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      },
      submenuAllowlist: ['qwen2.5-coder:7b', 'claude-sonnet'],
      lastUsed: { provider: 'openai', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
      deepReview: {
        lenses: { soundness: { enabled: true, model: { provider: 'anthropic', model: 'claude-sonnet' } } },
        synthesisModel: { provider: 'openai' },
      },
    }
    const saved = setModelConfig(cfg)
    expect(saved).toEqual(cfg)
    expect(getModelConfig()).toEqual(cfg)
  })

  it('merges partial updates over existing config', () => {
    setModelConfig({ submenuAllowlist: ['a', 'b'] })
    setModelConfig({ defaults: { tour: { provider: 'anthropic', model: 'claude-haiku' } } })
    const cfg = getModelConfig()
    expect(cfg.submenuAllowlist).toEqual(['a', 'b'])
    expect(cfg.defaults.tour).toEqual({ provider: 'anthropic', model: 'claude-haiku' })
  })

  it('persists lastUsed and preserves it across unrelated updates', () => {
    setModelConfig({ lastUsed: { provider: 'anthropic', model: 'claude-opus' } })
    setModelConfig({ submenuAllowlist: ['x'] })
    expect(getModelConfig().lastUsed).toEqual({ provider: 'anthropic', model: 'claude-opus' })
  })
})

describe('retired model migration', () => {
  // Written the way an older app version left it — the migration is a read-time
  // rewrite, so going through setModelConfig would hide what's under test.
  function writeRawConfig(config: unknown): void {
    mkdirSync(join(tmpRoot, 'config'), { recursive: true })
    writeFileSync(join(tmpRoot, 'config', 'models.json'), JSON.stringify(config), 'utf-8')
  }

  it('rewrites every ref pointing at a model dropped from the catalog', () => {
    writeRawConfig({
      defaults: {
        review: { provider: 'anthropic', model: 'claude-opus-4-8' },
        tour: { provider: 'ollama', model: 'claude-opus-4-8' },
      },
      submenuAllowlist: ['claude-opus-4-8', 'claude-sonnet-5'],
      lastUsed: { provider: 'anthropic', model: 'claude-opus-4-8' },
      deepReview: {
        lenses: { soundness: { enabled: true, model: { provider: 'anthropic', model: 'claude-opus-4-8' } } },
        synthesisModel: { provider: 'anthropic', model: 'claude-opus-4-8' },
      },
    })

    const cfg = getModelConfig()

    expect(cfg.defaults.review).toEqual({ provider: 'anthropic', model: 'claude-opus-5' })
    expect(cfg.submenuAllowlist).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(cfg.lastUsed).toEqual({ provider: 'anthropic', model: 'claude-opus-5' })
    expect(cfg.deepReview?.lenses.soundness?.model).toEqual({ provider: 'anthropic', model: 'claude-opus-5' })
    expect(cfg.deepReview?.synthesisModel).toEqual({ provider: 'anthropic', model: 'claude-opus-5' })
    // An Ollama model that happens to share the name is a different model.
    expect(cfg.defaults.tour).toEqual({ provider: 'ollama', model: 'claude-opus-4-8' })
  })

  it('leaves current models untouched', () => {
    const cfg: ModelConfig = {
      defaults: { review: { provider: 'anthropic', model: 'claude-opus-5' } },
      submenuAllowlist: ['claude-opus-5'],
      lastUsed: { provider: 'anthropic', model: 'claude-opus-5' },
      deepReview: DEEP_DEFAULTS,
    }
    writeRawConfig(cfg)
    expect(getModelConfig()).toEqual(cfg)
  })
})
