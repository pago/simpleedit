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
import { spawn, type ChildProcess } from 'child_process'
import { isReasoningEffort, type OpenCodeModel } from '../../shared/ipc-types'
import { findJsonObjectEnd } from '../lib/json-scanner'
import { resolveOpenCodePath } from '../lib/shell-path'
import { openCodeBaseEnv } from '../lib/opencode-env'

let cached: OpenCodeModel[] | null = null

/**
 * Discovery children that haven't exited yet, tracked for the same reason as
 * Codex's (see `codex-catalog.ts`): a child still holding its stdio pipes at
 * quit can hang Electron's shutdown. `opencode models` is one-shot and short,
 * so the window is narrower than `codex app-server`'s — but it is a window,
 * and a wedged or auth-prompting binary widens it without bound.
 */
const inflight = new Set<ChildProcess>()

/**
 * Bumped by `cancelOpenCodeDiscovery`. A discovery still resolving the opencode
 * path when the cancel lands must not go on to spawn, or the spawn arrives
 * after the quit hooks already ran and recreates the hang the kill prevents.
 * Only that in-flight discovery is abandoned: a later call (macOS reopening a
 * window after window-all-closed) starts a new generation and spawns normally.
 */
let cancelGeneration = 0

/** Kill any in-flight model discovery. Wired into the app's quit path. */
export function cancelOpenCodeDiscovery(): void {
  cancelGeneration++
  for (const proc of inflight) {
    // SIGKILL: this is teardown, there is nothing to flush, and a child that
    // ignores SIGTERM would put the shutdown hang right back.
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }
  inflight.clear()
}

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
    const proc = spawn(bin, ['models', '--verbose'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Same pinning argument as the interactive launch: a catalog fetch must
      // not be the thing that silently upgrades the binary out from under it.
      env: { ...process.env, ...openCodeBaseEnv() } as Record<string, string>,
    })
    inflight.add(proc)
    // Untracked on 'error' as well as 'close': a spawn that fails outright
    // (missing binary, EACCES) may never emit 'close', and the entry would
    // otherwise sit in the set until the next cancel.
    const untrack = (): boolean => inflight.delete(proc)
    let out = ''
    let err = ''
    proc.stdout.on('data', (c: Buffer) => { out += c.toString() })
    proc.stderr.on('data', (c: Buffer) => { err += c.toString() })
    proc.on('error', (e) => { untrack(); reject(e) })
    proc.on('close', (code) => {
      untrack()
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
    const generation = cancelGeneration
    const bin = await resolveOpenCodePath()
    if (generation !== cancelGeneration) throw new Error('opencode model discovery cancelled')
    const models = parseOpenCodeModels(await runModels(bin))
    if (models.length > 0) cached = models
    return models
  } catch {
    return []
  }
}
