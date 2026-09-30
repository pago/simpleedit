/**
 * Every prompt whose instructions a person may override. An entry owns only the
 * default *instruction* text; the output contract and the input framing stay in
 * the task module that builds the prompt, so no override can drop them.
 *
 * `defaultVersion` is bumped when the default instructions change in a release —
 * it drives the `outdated` status of overrides customized from an older default.
 * (`*_PROMPT_VERSION` in the task modules still covers contract/framing changes.)
 */
import type { PromptGroup, PromptId } from '../../shared/ipc-types'
import { DEEP_LENS_LABEL, DEEP_LENS_ORDER } from '../../shared/screenprs'
import { TRIAGE_INSTRUCTIONS } from '../tasks/triage-task'
import { LENS_INSTRUCTIONS, SYNTHESIS_INSTRUCTIONS } from '../tasks/deep-review-lenses'

export interface PromptDefinition {
  id: PromptId
  title: string
  description: string
  group: PromptGroup
  defaultInstructions: string
  defaultVersion: number
}

export const PROMPTS: readonly PromptDefinition[] = [
  {
    id: 'triage',
    title: 'Triage',
    description: 'The fast, diff-only pass that rates impact and flags concerns for every PR in the queue.',
    group: 'screening',
    defaultInstructions: TRIAGE_INSTRUCTIONS,
    defaultVersion: 1,
  },
  ...DEEP_LENS_ORDER.map((lens): PromptDefinition => ({
    id: `deep-review/${lens}`,
    title: DEEP_LENS_LABEL[lens],
    description: `What the ${DEEP_LENS_LABEL[lens]} lens looks for.`,
    group: 'deep-review',
    defaultInstructions: LENS_INSTRUCTIONS[lens],
    defaultVersion: 1,
  })),
  {
    id: 'deep-review/synthesis',
    title: 'Synthesis',
    description: 'How the lens findings are merged, ranked and pruned into the final review.',
    group: 'deep-review',
    defaultInstructions: SYNTHESIS_INSTRUCTIONS,
    defaultVersion: 1,
  },
]

/**
 * The definition for `id`. Throws on an unknown id: ids arrive over IPC (the
 * phone included) and become file paths, so only registered ones may pass.
 */
export function promptDefinition(id: string): PromptDefinition {
  const def = PROMPTS.find((p) => p.id === id)
  if (!def) throw new Error(`Unknown prompt: ${id}`)
  return def
}
