/**
 * Static list of Claude cloud models offered in the picker. Unlike Ollama's
 * live `/api/tags`, there's no local API to enumerate cloud models, so the set
 * is curated here. Each entry doubles as an `anthropic` ModelRef (`model` is the
 * `--model` value passed to the CLI) plus a display name for the UI.
 */
import type { ClaudeModel } from '../../shared/ipc-types'

// VERIFY these --model values against the installed Claude CLI.
export const CLAUDE_MODELS: ClaudeModel[] = [
  { provider: 'anthropic', displayName: 'Opus 4.8', model: 'claude-opus-4-8' },
  { provider: 'anthropic', displayName: 'Sonnet 5', model: 'claude-sonnet-5' },
  { provider: 'anthropic', displayName: 'Haiku 4.5', model: 'claude-haiku-4-5-20251001' },
  { provider: 'anthropic', displayName: 'Fable 5', model: 'claude-fable-5' },
]
