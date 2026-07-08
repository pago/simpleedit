import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
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
      },
      submenuAllowlist: ['qwen2.5-coder:7b', 'claude-sonnet'],
      lastUsed: { provider: 'ollama', model: 'qwen2.5-coder:7b', endpoint: 'http://localhost:11434' },
      deepReview: {
        lenses: { soundness: { enabled: true, model: { provider: 'anthropic', model: 'claude-sonnet' } } },
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
