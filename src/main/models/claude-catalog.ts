/**
 * The Claude model catalog, asked of the installed CLI itself.
 *
 * `claude -p --input-format stream-json` speaks the Agent SDK control protocol,
 * and its `initialize` response carries the models THIS install offers — the
 * same list as the CLI's own `/model` picker, so it tracks CLI upgrades and the
 * account/provider (subscription, API key, Bedrock/Vertex) without a release of
 * ours. Each entry doubles as an `anthropic` ModelRef: `model` is the value the
 * CLI accepts for `--model`, which may be an alias (`opus`) that floats to the
 * newest model of that family.
 */
import { spawn, type ChildProcess } from 'child_process'
import { homedir } from 'os'
import * as readline from 'readline'
import type { ClaudeModel, ModelRef } from '../../shared/ipc-types'
import { resolveClaudePath } from '../lib/shell-path'

/**
 * Served when discovery fails, so the Claude picker is never empty — Claude is
 * the one agent the app cannot run without. Aliases lead because they can't go
 * stale; the pinned ids are the ones earlier releases offered, kept so a stored
 * ref to one still renders in the picker instead of as a blank.
 */
export const CLAUDE_FALLBACK_MODELS: ClaudeModel[] = [
  { provider: 'anthropic', displayName: 'Opus', model: 'opus' },
  { provider: 'anthropic', displayName: 'Sonnet', model: 'sonnet' },
  { provider: 'anthropic', displayName: 'Haiku', model: 'haiku' },
  { provider: 'anthropic', displayName: 'Fable 5.1', model: 'claude-fable-5-1' },
  { provider: 'anthropic', displayName: 'Opus 5', model: 'claude-opus-5' },
  { provider: 'anthropic', displayName: 'Sonnet 5', model: 'claude-sonnet-5' },
  { provider: 'anthropic', displayName: 'Fable 5', model: 'claude-fable-5' },
]

/**
 * Fallback triage model when the user hasn't picked a Screen PRs default: Haiku,
 * not the CLI's implicit default. Triage is high-frequency, low-stakes, diff-only
 * work — the cheapest capable Claude model is the right call. Deep-review lenses
 * inherit this too unless individually escalated.
 */
export const DEFAULT_TRIAGE_MODEL: ModelRef = { provider: 'anthropic', model: 'haiku' }

/**
 * Fallback PR Overview model: Sonnet. The overview is run on demand, one PR at
 * a time, and has to read a diff plus discussion and key files well enough to
 * say where the risk is. That is worth more than Haiku, and it is independent
 * of the triage and deep-review models.
 */
export const DEFAULT_OVERVIEW_MODEL: ModelRef = { provider: 'anthropic', model: 'sonnet' }

let cached: ClaudeModel[] | null = null

/**
 * The discovery in progress, shared by every caller that arrives while it runs:
 * a window's pickers all ask on mount, and each ask would otherwise start its
 * own CLI (a full Node process that loads auth) for the same answer.
 */
let pending: Promise<ClaudeModel[]> | null = null

/**
 * Discovery children that haven't exited yet, tracked for the same reason as
 * Codex's (see `codex-catalog.ts`): a child still holding its stdio pipes at
 * quit can hang Electron's shutdown.
 */
const inflight = new Set<ChildProcess>()

/**
 * Bumped by `cancelClaudeDiscovery`, so a discovery still resolving the claude
 * path when quit lands doesn't go on to spawn after the quit hooks ran.
 */
let cancelGeneration = 0

/** Kill any in-flight model discovery. Wired into the app's quit path. */
export function cancelClaudeDiscovery(): void {
  cancelGeneration++
  for (const proc of inflight) {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }
  inflight.clear()
}

export function parseClaudeModels(models: unknown): ClaudeModel[] {
  if (!Array.isArray(models)) return []
  return models.flatMap((raw): ClaudeModel[] => {
    if (!raw || typeof raw !== 'object') return []
    const entry = raw as Record<string, unknown>
    const value = entry['value']
    // `default` is "no --model flag", which every picker already offers as its
    // absent-ref entry; listing it too would show the CLI default twice.
    if (typeof value !== 'string' || value === '' || value === 'default') return []
    const displayName = typeof entry['displayName'] === 'string' && entry['displayName'] ? entry['displayName'] : value
    return [{ provider: 'anthropic', displayName, model: value }]
  })
}

/**
 * The Claude catalog: discovered once and cached, or the fallback list. Like
 * the other catalogs, neither a failure nor an empty result is cached, so a CLI
 * installed or logged into after launch is picked up on the next ask.
 */
export function listClaudeModels(): Promise<ClaudeModel[]> {
  if (cached) return Promise.resolve(cached)
  pending ??= discover()
    .then((models) => {
      if (models.length === 0) return CLAUDE_FALLBACK_MODELS
      cached = models
      return models
    })
    .catch(() => CLAUDE_FALLBACK_MODELS)
    .finally(() => { pending = null })
  return pending
}

async function discover(): Promise<ClaudeModel[]> {
  const generation = cancelGeneration
  const bin = await resolveClaudePath()
  if (generation !== cancelGeneration) throw new Error('claude model discovery cancelled')
  // A throwaway session must leave no trace: no transcript to show up under
  // --resume, and no user SessionStart hooks (which may register sessions or
  // notify). `--bare` would do both but also drops OAuth, and with it the
  // subscription's model list.
  const proc = spawn(
    bin,
    [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--settings', JSON.stringify({ disableAllHooks: true }),
    ],
    { cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'] }
  )
  inflight.add(proc)
  const untrack = (): boolean => inflight.delete(proc)
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })
  try {
    return await new Promise<ClaudeModel[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('claude model discovery timed out')), 10_000)
      const settle = (fn: () => void): void => { clearTimeout(timeout); fn() }
      rl.on('line', (line) => {
        let message: Record<string, unknown>
        try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
        if (message['type'] !== 'control_response') return
        const response = message['response'] as Record<string, unknown> | undefined
        if (response?.['request_id'] !== 'models') return
        if (response['subtype'] !== 'success') {
          settle(() => reject(new Error('claude initialize failed')))
          return
        }
        const payload = response['response'] as Record<string, unknown> | undefined
        settle(() => resolve(parseClaudeModels(payload?.['models'])))
      })
      proc.on('error', (err) => { untrack(); settle(() => reject(err)) })
      proc.on('close', (code) => { untrack(); settle(() => reject(new Error(`claude exited with code ${code}`))) })
      proc.stdin?.on('error', () => { /* child died; 'close' reports it */ })
      proc.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`)
    })
  } finally {
    rl.close()
    try { proc.kill() } catch { /* already gone */ }
  }
}
