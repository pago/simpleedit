/**
 * Model layer: compose Ollama's live truth (installed, tool-capable) with a
 * curated on-ramp (recommended), both annotated with how well they fit this
 * machine. Consumed by the `models:*` IPC handlers.
 */
import type { ModelDescriptor, RecommendedModel } from '../../shared/ipc-types'
import { listInstalled, isToolCapable } from './ollama'
import { detectHardware } from './hardware'
import { RECOMMENDED_MODELS, computeFit } from './recommendations'

export { isAvailable, pull } from './ollama'
export { detectHardware } from './hardware'
export { getModelConfig, setModelConfig } from './config'
export { CLAUDE_MODELS } from './claude-catalog'

const GB = 1024 ** 3
// Context/runtime overhead on top of raw weights, added to every estimate.
const CONTEXT_OVERHEAD_BYTES = 1.5 * GB

/** Effective bytes-per-parameter at a given quantization level (heuristic, tunable). */
function bytesPerParam(quant?: string): number {
  const q = (quant ?? '').toUpperCase()
  if (q.includes('Q2')) return 0.4
  if (q.includes('Q3')) return 0.5
  if (q.includes('Q4')) return 0.6
  if (q.includes('Q5')) return 0.7
  if (q.includes('Q6')) return 0.85
  if (q.includes('Q8')) return 1.1
  if (q.includes('F16') || q.includes('FP16') || q.includes('BF16')) return 2.2
  return 0.6 // assume ~Q4 when unknown
}

/**
 * Estimate min RAM from a parameter-size string like "7.6B" or "500M".
 * Returns undefined when the size can't be parsed (fit falls back to 'fits').
 * e.g. 7B-Q4 ≈ 4-5 GB, 32B-Q4 ≈ 20 GB.
 */
export function estimateMinRam(paramSize?: string, quant?: string): number | undefined {
  if (!paramSize) return undefined
  const match = paramSize.match(/([\d.]+)\s*([BM])?/i)
  if (!match) return undefined
  const value = parseFloat(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = (match[2] ?? 'B').toUpperCase()
  const params = unit === 'M' ? value * 1e6 : value * 1e9
  return Math.round(params * bytesPerParam(quant) + CONTEXT_OVERHEAD_BYTES)
}

/**
 * All installed Ollama models, annotated with hardware fit and whether they're
 * tool-capable. Non-tool models aren't dropped: the UI surfaces them as "review
 * only" (usable for bounded tasks like Review/Tour, which don't need tool
 * calling) but not for the interactive agent.
 */
export async function listInstalledModels(): Promise<ModelDescriptor[]> {
  const { totalRamBytes } = detectHardware()
  const installed = await listInstalled()
  const out: ModelDescriptor[] = []
  for (const m of installed) {
    // A model whose capabilities can't be probed is treated as non-tool.
    const toolCapable = await isToolCapable(m.name).catch(() => false)
    const minRamBytes = estimateMinRam(m.paramSize, m.quantization)
    out.push({
      name: m.name,
      paramSize: m.paramSize,
      quantization: m.quantization,
      minRamBytes,
      fit: minRamBytes === undefined ? 'fits' : computeFit(minRamBytes, totalRamBytes),
      installed: true,
      toolCapable,
    })
  }
  return out
}

/** Curated recommendations minus what's already installed, annotated with fit. */
export async function listRecommendedModels(): Promise<RecommendedModel[]> {
  const { totalRamBytes } = detectHardware()
  let installedNames = new Set<string>()
  try {
    installedNames = new Set((await listInstalled()).map((m) => m.name))
  } catch {
    // Ollama unreachable — still show the on-ramp, none marked installed.
  }
  return RECOMMENDED_MODELS.filter((m) => !installedNames.has(m.name)).map((m) => ({
    name: m.name,
    label: m.label,
    notes: m.notes,
    minRamBytes: m.minRamBytes,
    fit: computeFit(m.minRamBytes, totalRamBytes),
    installed: false,
    toolCapable: true,
  }))
}
