/**
 * Static list of Claude cloud models offered in the picker. Unlike Ollama's
 * live `/api/tags`, there's no local API to enumerate cloud models, so the set
 * is curated here. Each entry doubles as an `anthropic` ModelRef (`model` is the
 * `--model` value passed to the CLI) plus a display name for the UI.
 */
import type { ClaudeModel, ModelRef } from '../../shared/ipc-types'

// VERIFY these --model values against the installed Claude CLI.
export const CLAUDE_MODELS: ClaudeModel[] = [
  { provider: 'anthropic', displayName: 'Opus 5', model: 'claude-opus-5' },
  { provider: 'anthropic', displayName: 'Sonnet 5', model: 'claude-sonnet-5' },
  { provider: 'anthropic', displayName: 'Haiku 4.5', model: 'claude-haiku-4-5-20251001' },
  { provider: 'anthropic', displayName: 'Fable 5', model: 'claude-fable-5' },
]

/**
 * Fallback triage model when the user hasn't picked a Screen PRs default: Haiku,
 * not the CLI's implicit default. Triage is high-frequency, low-stakes, diff-only
 * work — the cheapest capable Claude model is the right call. Deep-review lenses
 * inherit this too unless individually escalated.
 */
export const DEFAULT_TRIAGE_MODEL: ModelRef = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }
