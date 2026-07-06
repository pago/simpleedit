/**
 * Ollama HTTP client. Talks to the local daemon's REST API for detection,
 * model listing, capability probing, and streaming pulls. Uses Electron's
 * `net.fetch` (same surface used by asset-protocol.ts).
 */
import { net } from 'electron'

const DEFAULT_ENDPOINT = 'http://localhost:11434'

/**
 * The endpoint to reach Ollama at. A constant for now; the plan calls for
 * making this config-overridable later, so callers pass it explicitly where a
 * per-model endpoint applies.
 */
export function getEndpoint(): string {
  return DEFAULT_ENDPOINT
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

async function ollamaFetch(path: string, endpoint: string | undefined, init?: RequestInit): Promise<Response> {
  const base = endpoint ?? getEndpoint()
  return net.fetch(`${base}${path}`, init)
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** GET /api/version — also serves as the "is Ollama running?" probe. */
export async function isAvailable(endpoint?: string): Promise<boolean> {
  try {
    const res = await ollamaFetch('/api/version', endpoint)
    return res.ok
  } catch {
    return false
  }
}

export interface InstalledTag {
  name: string
  paramSize?: string
  quantization?: string
}

/** GET /api/tags — the installed models with a couple of size hints. */
export async function listInstalled(endpoint?: string): Promise<InstalledTag[]> {
  const res = await ollamaFetch('/api/tags', endpoint)
  if (!res.ok) throw new Error(`Ollama /api/tags failed: ${res.status}`)
  const data: unknown = await res.json()
  const models = isRecord(data) && Array.isArray(data.models) ? data.models : []
  const out: InstalledTag[] = []
  for (const m of models) {
    if (!isRecord(m) || typeof m.name !== 'string') continue
    const details = isRecord(m.details) ? m.details : undefined
    out.push({
      name: m.name,
      paramSize:
        details && typeof details.parameter_size === 'string' ? details.parameter_size : undefined,
      quantization:
        details && typeof details.quantization_level === 'string' ? details.quantization_level : undefined,
    })
  }
  return out
}

/** POST /api/show — the model's `capabilities` array (e.g. `tools`, `vision`). */
export async function getCapabilities(model: string, endpoint?: string): Promise<string[]> {
  const res = await ollamaFetch('/api/show', endpoint, jsonPost({ model }))
  if (!res.ok) throw new Error(`Ollama /api/show failed for ${model}: ${res.status}`)
  const data: unknown = await res.json()
  if (isRecord(data) && Array.isArray(data.capabilities)) {
    return data.capabilities.filter((c): c is string => typeof c === 'string')
  }
  return []
}

/** The harness is useless without tool-calling, so this is the usability gate. */
export async function isToolCapable(model: string, endpoint?: string): Promise<boolean> {
  return (await getCapabilities(model, endpoint)).includes('tools')
}

export interface PullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
}

/**
 * Yield trimmed, non-empty lines from a streaming response body. Buffers across
 * chunk boundaries so a JSON object split mid-line is never handed out partial.
 */
async function* streamLines(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) yield line
    }
  }
  buffer += decoder.decode()
  const last = buffer.trim()
  if (last) yield last
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatStreamOptions {
  model: string
  messages: ChatMessage[]
  /**
   * Context window. Ollama defaults to 4096, which silently truncates a review
   * diff; bounded tasks pass something generous (e.g. 32768).
   */
  numCtx?: number
  endpoint?: string
  signal?: AbortSignal
}

/**
 * POST /api/chat with `stream: true`, yielding the assistant message `content`
 * as it streams. This is Ollama's **native** endpoint — never the Anthropic-compat
 * `/v1/messages`, which hangs after Claude Code's `count_tokens` probe (Ollama
 * #13949) and is the whole reason local bounded tasks route through here.
 *
 * Reasoning models (e.g. gpt-oss) emit their chain-of-thought in a separate
 * `message.thinking`/`message.reasoning` field; we deliberately ignore it and
 * yield only `content`, which carries the answer (here, the NDJSON findings).
 */
export async function* chatStream(o: ChatStreamOptions): AsyncGenerator<string> {
  const body = {
    model: o.model,
    messages: o.messages,
    stream: true,
    options: { num_ctx: o.numCtx ?? 32768 },
  }
  const res = await ollamaFetch('/api/chat', o.endpoint, { ...jsonPost(body), signal: o.signal })
  if (!res.ok) throw new Error(`Ollama /api/chat failed: ${res.status}`)

  for await (const line of streamLines(res)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    if (typeof parsed.error === 'string') throw new Error(parsed.error)
    const message = isRecord(parsed.message) ? parsed.message : undefined
    const content = message && typeof message.content === 'string' ? message.content : ''
    if (content) yield content
  }
}

/**
 * POST /api/pull — stream NDJSON progress lines, invoking `onProgress` per
 * line. Resolves once the stream ends; rejects on transport error or an
 * `{ error }` line from the daemon.
 */
export async function pull(
  name: string,
  onProgress: (progress: PullProgress) => void,
  endpoint?: string
): Promise<void> {
  // Send both keys: newer Ollama expects `model`, older accepts `name`.
  const res = await ollamaFetch('/api/pull', endpoint, jsonPost({ model: name, name }))
  if (!res.ok) throw new Error(`Ollama /api/pull failed for ${name}: ${res.status}`)

  for await (const line of streamLines(res)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    if (typeof parsed.error === 'string') throw new Error(parsed.error)
    onProgress({
      status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
      digest: typeof parsed.digest === 'string' ? parsed.digest : undefined,
      total: typeof parsed.total === 'number' ? parsed.total : undefined,
      completed: typeof parsed.completed === 'number' ? parsed.completed : undefined,
    })
  }
}
