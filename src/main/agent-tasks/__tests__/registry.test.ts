import { describe, expect, it } from 'vitest'
import { ClaudeCodeRunner, CodexRunner, DirectRunner } from '../runner'
import { createTaskExecution, targetFromModelRef } from '../registry'

describe('task runner registry', () => {
  it('dispatches every target without falling through to Claude', () => {
    expect(createTaskExecution({ runner: 'claude' }, { cwd: '/tmp' }).runner).toBeInstanceOf(ClaudeCodeRunner)
    expect(createTaskExecution({ runner: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' }, { cwd: '/tmp', selfContained: true }).runner).toBeInstanceOf(CodexRunner)
    expect(createTaskExecution({ runner: 'ollama', model: 'qwen' }, { cwd: '/tmp' }).runner).toBeInstanceOf(DirectRunner)
  })

  it('maps persisted provider refs losslessly', () => {
    expect(targetFromModelRef({ provider: 'openai', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' })).toEqual({ runner: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' })
    expect(targetFromModelRef({ provider: 'ollama', model: 'qwen', endpoint: 'http://localhost:11434' })).toEqual({ runner: 'ollama', model: 'qwen', endpoint: 'http://localhost:11434' })
  })
})
