import type { ModelRef, TaskTarget } from '../../shared/ipc-types'
import { ClaudeCodeRunner, CodexRunner, DirectRunner, OpenCodeRunner, type Runner } from './runner'

export interface TaskExecution {
  runner: Runner
  model?: ModelRef
  concurrency: number
}

export interface TaskExecutionContext {
  cwd: string
  selfContained?: boolean
}

export function targetFromModelRef(ref: ModelRef | undefined): TaskTarget {
  if (!ref) return { runner: 'claude' }
  switch (ref.provider) {
    case 'anthropic': return { runner: 'claude', model: ref.model }
    case 'ollama': return { runner: 'ollama', model: ref.model, ...(ref.endpoint ? { endpoint: ref.endpoint } : {}) }
    case 'openai': return { runner: 'codex', ...(ref.model ? { model: ref.model } : {}), ...(ref.reasoningEffort ? { reasoningEffort: ref.reasoningEffort } : {}) }
    case 'opencode': return { runner: 'opencode', ...(ref.model ? { model: ref.model } : {}), ...(ref.reasoningEffort ? { reasoningEffort: ref.reasoningEffort } : {}) }
  }
}

export function createTaskExecution(target: TaskTarget, context: TaskExecutionContext): TaskExecution {
  switch (target.runner) {
    case 'claude':
      return {
        runner: new ClaudeCodeRunner({ cwd: context.cwd }),
        model: target.model ? { provider: 'anthropic', model: target.model } : undefined,
        concurrency: 4,
      }
    case 'codex':
      return {
        runner: new CodexRunner({
          cwd: context.cwd,
          ...(target.model ? { model: target.model } : {}),
          ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
          ...(context.selfContained ? { skipGitRepoCheck: true } : {}),
        }),
        model: { provider: 'openai', ...(target.model ? { model: target.model } : {}), ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}) },
        concurrency: 4,
      }
    case 'opencode':
      return {
        runner: new OpenCodeRunner({
          cwd: context.cwd,
          ...(target.model ? { model: target.model } : {}),
          ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
        }),
        model: { provider: 'opencode', ...(target.model ? { model: target.model } : {}), ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}) },
        concurrency: 4,
      }
    case 'ollama': {
      const model: ModelRef = { provider: 'ollama', model: target.model, ...(target.endpoint ? { endpoint: target.endpoint } : {}) }
      return { runner: new DirectRunner(), model, concurrency: 1 }
    }
  }
}
