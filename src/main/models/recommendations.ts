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

// Verified against the Ollama library, July 2026. These are all agent-capable
// (tool-calling works on Ollama) — the two gates that go stale fastest are
// currency and tool-calling, so the app still confirms `tools` live via
// /api/show at install rather than trusting this list. Notable exclusions:
// qwen3.5 (tool-calling broken on Ollama, issue #14493 — usable for Review/Tour
// but not the interactive agent), codestral (no reliable tools + 32k context),
// deepseek-coder (no native tools). Revise as the field moves — names churn fast.
export const RECOMMENDED_MODELS: CuratedModel[] = [
  {
    name: 'gpt-oss:20b',
    label: 'gpt-oss 20B',
    minRamBytes: 16 * GB,
    notes: 'Best small tool-capable coder; MoE, fast, runs on 16GB. Great starter.',
  },
  {
    name: 'qwen3-coder:30b',
    label: 'Qwen3 Coder 30B',
    minRamBytes: 24 * GB,
    notes: 'Top local agentic coder — 256K context, MoE (fast). Recommended default on 32GB+.',
  },
  {
    name: 'devstral-small-2:24b',
    label: 'Devstral Small 2 24B',
    minRamBytes: 22 * GB,
    notes: 'SWE-bench-tuned agent; dense, reliable tool loops. Wants ~32GB.',
  },
  {
    name: 'gpt-oss:120b',
    label: 'gpt-oss 120B',
    minRamBytes: 80 * GB,
    notes: 'Strongest gpt-oss; workstation only (~96GB+). MoE.',
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
