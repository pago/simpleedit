/**
 * The OpenCode model catalog, from `opencode models --verbose`.
 *
 * The plain `opencode models` output is only a list of qualified ids, which
 * gives the picker nothing to show but a slug. `--verbose` interleaves each id
 * with a JSON blob carrying the display name and — unlike Codex, where the set
 * is global — the reasoning-effort variants THIS model supports. Those differ
 * per model (deepseek-v4-flash-free offers low/high/max; laguna-s-2.1-free
 * offers low/medium/high), so they are read per entry rather than assumed.
 */
import { spawn } from 'child_process'
import { isReasoningEffort, type OpenCodeModel } from '../../shared/ipc-types'
import { findJsonObjectEnd } from '../lib/json-scanner'
import { resolveOpenCodePath } from '../lib/shell-path'

let cached: OpenCodeModel[] | null = null

/**
 * Scan the interleaved `<qualified-id>\n{json}` stream into models.
 *
 * Objects are located with the shared JSON scanner rather than by counting
 * braces, so a brace inside a string (a model name, a URL) cannot desynchronise
 * the parse.
 */
export function parseOpenCodeModels(output: string): OpenCodeModel[] {
  const models: OpenCodeModel[] = []
  let pos = 0
  for (;;) {
    const start = output.indexOf('{', pos)
    if (start === -1) break
    const end = findJsonObjectEnd(output, start)
    if (end === -1) break
    pos = end + 1

    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>
    } catch {
      continue
    }

    const id = entry['id']
    const providerId = entry['providerID']
    if (typeof id !== 'string' || typeof providerId !== 'string') continue
    // Anything not currently servable would fail at launch with a confusing
    // provider error rather than a missing menu entry.
    if (entry['status'] !== undefined && entry['status'] !== 'active') continue

    // `--model` accepts only the fully qualified form, so the catalog stores
    // ids the way they must be passed rather than the bare id.
    const model = `${providerId}/${id}`
    const variants = entry['variants']
    const efforts =
      variants && typeof variants === 'object'
        ? Object.keys(variants).filter(isReasoningEffort)
        : []

    models.push({
      provider: 'opencode',
      displayName: typeof entry['name'] === 'string' ? entry['name'] : model,
      model,
      supportedReasoningEfforts: efforts,
    })
  }
  return models
}

function runModels(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['models', '--verbose'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', (c: Buffer) => { out += c.toString() })
    proc.stderr.on('data', (c: Buffer) => { err += c.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`opencode models exited with ${code}: ${err.trim().slice(0, 500)}`))
    })
  })
}

/**
 * Cached catalog. Only a SUCCESSFUL fetch is cached: caching a failure would
 * pin the picker empty for the rest of the session for someone who installed
 * or authenticated OpenCode after launch.
 */
export async function getOpenCodeModels(): Promise<OpenCodeModel[]> {
  if (cached) return cached
  try {
    const models = parseOpenCodeModels(await runModels(await resolveOpenCodePath()))
    if (models.length > 0) cached = models
    return models
  } catch {
    return []
  }
}
