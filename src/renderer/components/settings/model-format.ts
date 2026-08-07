/** Small formatting helpers shared by the settings model panes. */
import type { ModelFit, ModelRef } from '../../../shared/ipc-types'

const GB = 1024 ** 3

/** "32 GB" — whole gigabytes, for RAM totals and estimates. */
export function formatGb(bytes: number): string {
  return `${Math.round(bytes / GB)} GB`
}

/** "~24 GB" min-RAM estimate, or '' when unknown. */
export function formatEstimate(bytes?: number): string {
  return bytes === undefined ? '' : `~${formatGb(bytes)}`
}

/** UI copy for a fit bucket. Cloud models don't have a local footprint. */
export function fitLabel(fit: ModelFit): string {
  switch (fit) {
    case 'fits':
      return 'fits'
    case 'marginal':
      return 'marginal'
    case 'too-big':
      return 'too big'
  }
}

/** Tailwind classes for a fit badge, matching the app's dark palette. */
export function fitClasses(fit: ModelFit): string {
  switch (fit) {
    case 'fits':
      return 'bg-green-950/60 text-green-400'
    case 'marginal':
      return 'bg-amber-950/60 text-amber-400'
    case 'too-big':
      return 'bg-red-950/60 text-red-400'
  }
}

/**
 * Stable string key for a ModelRef — used as <select> option values.
 *
 * The effort is keyed off whether the ref CAN carry one rather than off a named
 * provider: a picker offers one option per supported effort, so a provider
 * whose effort is dropped here collapses every variant of a model onto one key,
 * and the options silently overwrite each other in the lookup map.
 */
export function refKey(ref: ModelRef): string {
  // Narrowed by excluding the arms that cannot carry an effort, so every
  // effort-bearing provider keys the same way. Testing `'reasoningEffort' in
  // ref` instead would read false when the field is merely absent, changing
  // the key of an existing `{ provider: 'openai' }` ref and orphaning the
  // "Configured default" option it is matched against.
  const carriesEffort = ref.provider !== 'anthropic' && ref.provider !== 'ollama'
  const effort = carriesEffort ? (ref.reasoningEffort ?? 'default') : ''
  return `${ref.provider}:${ref.model ?? 'configured-default'}:${effort}`
}
