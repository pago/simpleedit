import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ModelConfig } from '../../shared/ipc-types'

// review.ts → runner.ts → models/ollama.ts imports `net` from electron.
vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}))
vi.mock('../models/config', () => ({
  getModelConfig: vi.fn(),
}))

import { getModelConfig } from '../models/config'
import { selectRunner } from '../review'
import { ClaudeCodeRunner, DirectRunner } from '../agent-tasks/runner'

const getModelConfigMock = vi.mocked(getModelConfig)

function config(review?: ModelConfig['defaults']['review']): ModelConfig {
  return { defaults: review ? { review } : {}, submenuAllowlist: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('selectRunner', () => {
  it('unset default ⇒ ClaudeCodeRunner with no model (byte-for-byte cloud path)', () => {
    getModelConfigMock.mockReturnValue(config(undefined))
    const { runner, model } = selectRunner('/wt')
    expect(runner).toBeInstanceOf(ClaudeCodeRunner)
    expect(model).toBeUndefined()
  })

  it('anthropic default ⇒ ClaudeCodeRunner carrying the chosen model', () => {
    getModelConfigMock.mockReturnValue(config({ provider: 'anthropic', model: 'claude-opus' }))
    const { runner, model } = selectRunner('/wt')
    expect(runner).toBeInstanceOf(ClaudeCodeRunner)
    expect(model).toEqual({ provider: 'anthropic', model: 'claude-opus' })
  })

  it('ollama default ⇒ DirectRunner carrying the local model', () => {
    getModelConfigMock.mockReturnValue(config({ provider: 'ollama', model: 'gpt-oss:20b' }))
    const { runner, model } = selectRunner('/wt')
    expect(runner).toBeInstanceOf(DirectRunner)
    expect(model).toEqual({ provider: 'ollama', model: 'gpt-oss:20b' })
  })
})
