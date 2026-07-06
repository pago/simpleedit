/**
 * Curated on-ramp of coding-suited, tool-calling Ollama models. There is no
 * local API to browse the remote library, so a first-run user with an empty
 * `/api/tags` needs a starter list. Keep the specific names here (not buried in
 * logic) so they're easy to revise as the field moves.
 */
import type { ModelFit } from '../../shared/ipc-types'

const GB = 1024 ** 3

export interface CuratedModel {
  /** Ollama pull name (`family:tag`). */
  name: string
  /** Human label for the picker. */
  label: string
  /** Rough RAM to run at a useful context — see estimateMinRam heuristic. */
  minRamBytes: number
  notes: string
}

// VERIFY model names/sizes — may be stale. Selection criteria: tool-calling
// capable, coding-tuned, runnable at ~64k context on typical dev hardware.
export const RECOMMENDED_MODELS: CuratedModel[] = [
  {
    name: 'qwen2.5-coder:7b',
    label: 'Qwen2.5 Coder 7B',
    minRamBytes: 6 * GB,
    notes: 'Strong small coding model with tool-calling. Good default on 16GB+.',
  },
  {
    name: 'qwen2.5-coder:14b',
    label: 'Qwen2.5 Coder 14B',
    minRamBytes: 12 * GB,
    notes: 'Noticeably stronger; wants ~24GB for comfortable context.',
  },
  {
    name: 'qwen2.5-coder:32b',
    label: 'Qwen2.5 Coder 32B',
    minRamBytes: 24 * GB,
    notes: 'Best of the Qwen coders; needs a 32GB+ machine.',
  },
  {
    name: 'llama3.1:8b',
    label: 'Llama 3.1 8B',
    minRamBytes: 8 * GB,
    notes: 'General-purpose with reliable tool-calling.',
  },
  {
    name: 'mistral-nemo:12b',
    label: 'Mistral Nemo 12B',
    minRamBytes: 10 * GB,
    notes: 'Long-context, tool-calling capable.',
  },
  {
    name: 'devstral:24b',
    label: 'Devstral 24B',
    minRamBytes: 18 * GB,
    notes: 'Agentic-coding tuned (SWE-bench); tool-calling. Wants 32GB.',
  },
]

/**
 * Bucket a model by whether it comfortably fits this machine's RAM. Heuristic
 * and tunable: fits under 70% of total, marginal up to 100%, too-big beyond.
 * (No headroom modeling for the OS / other apps beyond the 70% cushion.)
 */
export function computeFit(minRamBytes: number, totalRamBytes: number): ModelFit {
  if (minRamBytes <= totalRamBytes * 0.7) return 'fits'
  if (minRamBytes <= totalRamBytes) return 'marginal'
  return 'too-big'
}
