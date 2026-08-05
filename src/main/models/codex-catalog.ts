import { app } from 'electron'
import { spawn } from 'child_process'
import * as readline from 'readline'
import { isReasoningEffort, type CodexModel } from '../../shared/ipc-types'
import { resolveCodexPath } from '../lib/shell-path'

let cached: CodexModel[] | null = null

interface RpcResponse { id?: number; result?: Record<string, unknown>; error?: unknown }

export function parseCodexModelPage(result: Record<string, unknown> | undefined): { models: CodexModel[]; nextCursor: string | null } {
  const models: CodexModel[] = []
  const data = Array.isArray(result?.['data']) ? result['data'] : []
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (entry['hidden'] === true) continue
    const model = typeof entry['model'] === 'string' ? entry['model'] : entry['id']
    if (typeof model !== 'string') continue
    // Codex types reasoning effort as an open string, so anything it advertises
    // that we don't model is dropped rather than cast into our union — an
    // unknown effort would otherwise reach the launch flags and the settings UI
    // as a value nothing can handle.
    const efforts = Array.isArray(entry['supportedReasoningEfforts'])
      ? entry['supportedReasoningEfforts'].flatMap((e) => {
          const value = e && typeof e === 'object' ? (e as Record<string, unknown>)['reasoningEffort'] : undefined
          return isReasoningEffort(value) ? [value] : []
        })
      : []
    models.push({
      provider: 'openai',
      displayName: typeof entry['displayName'] === 'string' ? entry['displayName'] : model,
      model,
      supportedReasoningEfforts: efforts,
      ...(isReasoningEffort(entry['defaultReasoningEffort']) ? { defaultReasoningEffort: entry['defaultReasoningEffort'] } : {}),
      isDefault: entry['isDefault'] === true,
    })
  }
  return { models, nextCursor: typeof result?.['nextCursor'] === 'string' ? result['nextCursor'] : null }
}

/**
 * The Codex model catalog, discovered once and then cached.
 *
 * A failure is NOT cached: `codex` may not be installed yet, may be mid-upgrade,
 * or its app-server may have hiccupped, and caching `[]` for the process
 * lifetime would leave the model picker permanently empty until a restart —
 * with no way for the user to tell why. An empty successful result isn't cached
 * either, for the same reason.
 */
export async function listCodexModels(): Promise<CodexModel[]> {
  if (cached) return cached
  try {
    const models = await discover()
    if (models.length > 0) cached = models
    return models
  } catch {
    return []
  }
}

async function discover(): Promise<CodexModel[]> {
  const bin = await resolveCodexPath()
  const proc = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })
  let nextId = 1
  const pending = new Map<number, { resolve: (value: RpcResponse) => void; reject: (err: Error) => void }>()
  const fail = (err: Error): void => { for (const waiter of pending.values()) waiter.reject(err); pending.clear() }
  rl.on('line', (line) => {
    try {
      const message = JSON.parse(line) as RpcResponse
      if (typeof message.id !== 'number') return
      const waiter = pending.get(message.id)
      if (waiter) { pending.delete(message.id); waiter.resolve(message) }
    } catch { /* ignore notifications/diagnostics */ }
  })
  proc.on('error', fail)
  proc.on('close', (code) => fail(new Error(`codex app-server exited with code ${code}`)))
  const request = (method: string, params: Record<string, unknown>): Promise<RpcResponse> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    })
  }
  const timeout = setTimeout(() => fail(new Error('codex model discovery timed out')), 5000)
  try {
    const initialized = await request('initialize', {
      clientInfo: { name: 'simpleedit', title: 'SimpleEdit', version: app.getVersion() },
    })
    if (initialized.error) throw new Error('Codex app-server initialization failed')
    proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    const models: CodexModel[] = []
    let cursor: string | null = null
    do {
      const response = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
      if (response.error) throw new Error('Codex model catalog is unavailable')
      const page = parseCodexModelPage(response.result)
      models.push(...page.models)
      cursor = page.nextCursor
    } while (cursor)
    return models
  } finally {
    clearTimeout(timeout)
    rl.close()
    try { proc.kill() } catch { /* already gone */ }
  }
}
