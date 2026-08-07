/**
 * Provider-agnostic execution layer for bounded tasks. A task assembles a
 * prompt; a `Runner` turns it into a stream of validated result items. Two
 * strategies share one interface:
 *
 * - `ClaudeCodeRunner` — spawns `claude --print --output-format stream-json …`,
 *   the full harness (real file/LSP access). This is the current Review path,
 *   lifted verbatim out of `review.ts`.
 * - `DirectRunner` — POSTs straight to Ollama's **native** `/api/chat`, no
 *   harness. Never the Anthropic-compat `/v1/messages` endpoint, which hangs
 *   (Ollama #13949) — routing local tasks here is why they work at all.
 *
 * Both extract NDJSON result objects from the model's text with the same
 * `json-scanner`, so a task's validator (`parse`) is reused unchanged.
 */
import { spawn } from 'child_process'
import * as readline from 'readline'
import type { ModelRef } from '../../shared/ipc-types'
import { findJsonObjectEnd } from '../lib/json-scanner'
import { resolveClaudePath } from '../lib/shell-path'
import { resolveCodexPath, resolveOpenCodePath } from '../lib/shell-path'
import { chatStream, type ChatMessage } from '../models/ollama'

export interface RunRequest<Item> {
  system: string
  user: string
  /**
   * Validate one scanned JSON object into an Item, or return null to skip it.
   * Stands in for the design's `schema: JSONSchema`: there is no schema-
   * validation lib in play, and the existing Review path validates by hand, so
   * the "schema" is carried as a validator reused across both runners.
   */
  parse: (obj: unknown) => Item | null
  /** A chosen model. `anthropic` adds `--model`; `ollama` targets `/api/chat`. */
  model?: ModelRef
}

export interface RunOptions {
  signal?: AbortSignal
}

export interface Runner {
  run<Item>(req: RunRequest<Item>, opts?: RunOptions): AsyncIterable<Item>
}

/**
 * Accumulate streamed model text and progressively extract complete JSON
 * objects, validating each with `parse`. Handles both snapshot chunks (each a
 * growing prefix of the whole response) and delta chunks (only the new text) —
 * the same dual behaviour the inline Review parser relied on.
 */
function createFindingScanner<Item>(parse: (obj: unknown) => Item | null): (chunk: string) => Item[] {
  let accumulated = ''
  let scanPos = 0
  return (chunk: string): Item[] => {
    accumulated = chunk.startsWith(accumulated) ? chunk : accumulated + chunk
    const items: Item[] = []
    let pos = scanPos
    while (pos < accumulated.length) {
      const start = accumulated.indexOf('{', pos)
      if (start === -1) break
      const end = findJsonObjectEnd(accumulated, start)
      if (end === -1) break // incomplete — wait for more text
      const json = accumulated.slice(start, end + 1)
      try {
        const item = parse(JSON.parse(json) as unknown)
        if (item !== null) items.push(item)
      } catch {
        /* not a complete/valid object */
      }
      scanPos = end + 1
      pos = scanPos
    }
    return items
  }
}

interface PushStream<T> {
  push(item: T): void
  close(): void
  fail(err: unknown): void
  iterable: AsyncIterable<T>
}

/**
 * Bridge a callback/event source (a child process) into an `AsyncIterable`.
 * Buffers items pushed before they're pulled, and surfaces `fail()` as a
 * rejection once the buffer drains.
 */
function createPushStream<T>(): PushStream<T> {
  const queue: T[] = []
  let waiting: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null = null
  let done = false
  let failed = false
  let failure: unknown

  return {
    push(item: T): void {
      if (done) return
      if (waiting) {
        const w = waiting
        waiting = null
        w.resolve({ value: item, done: false })
      } else {
        queue.push(item)
      }
    },
    close(): void {
      if (done) return
      done = true
      if (waiting) {
        const w = waiting
        waiting = null
        w.resolve({ value: undefined as never, done: true })
      }
    },
    fail(err: unknown): void {
      if (done) return
      done = true
      failed = true
      failure = err
      if (waiting) {
        const w = waiting
        waiting = null
        w.reject(err)
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift() as T, done: false })
            if (failed) return Promise.reject(failure)
            if (done) return Promise.resolve({ value: undefined as never, done: true })
            return new Promise((resolve, reject) => {
              waiting = { resolve, reject }
            })
          },
        }
      },
    },
  }
}

export interface ClaudeCodeRunnerOptions {
  /** Working directory for the spawned harness (the worktree under review). */
  cwd: string
}

/**
 * Today's Review path: spawn `claude --print --output-format stream-json …`,
 * pipe the user prompt to stdin, parse `stream_event`/`result` line by line,
 * and extract NDJSON items. Behaviour-identical to the former inline `review.ts`
 * flow when `req.system` is empty and no model is chosen.
 */
export class ClaudeCodeRunner implements Runner {
  constructor(private readonly opts: ClaudeCodeRunnerOptions) {}

  run<Item>(req: RunRequest<Item>, opts?: RunOptions): AsyncIterable<Item> {
    const stream = createPushStream<Item>()
    // `run()` returns immediately; if spawn's synchronous setup throws (bad
    // args, stdin.write on a dead pipe), a bare `void` would swallow it and the
    // stream would never settle — hanging the review on 'running'. Route any
    // such rejection to fail() so it surfaces as an error instead.
    this.spawn(req, stream, opts).catch((err) => stream.fail(err))
    return stream.iterable
  }

  private async spawn<Item>(req: RunRequest<Item>, stream: PushStream<Item>, opts?: RunOptions): Promise<void> {
    let claudeBin: string
    try {
      claudeBin = await resolveClaudePath()
    } catch (err) {
      stream.fail(err)
      return
    }

    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if (req.model?.provider === 'anthropic' && req.model.model) args.push('--model', req.model.model)
    if (req.system) args.push('--append-system-prompt', req.system)

    const proc = spawn(claudeBin, args, {
      cwd: this.opts.cwd,
      env: process.env as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const onAbort = (): void => {
      try {
        proc.kill()
      } catch {
        /* already dead */
      }
    }
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    proc.stdin.write(req.user, 'utf8')
    proc.stdin.end()

    const scan = createFindingScanner<Item>(req.parse)

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) return
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>
        // Each stream_event carries a growing snapshot of the assistant text.
        if (ev['type'] === 'stream_event') {
          const inner = ev['event'] as Record<string, unknown> | undefined
          if (inner?.['type'] === 'content_block_delta') {
            const delta = inner['delta'] as Record<string, unknown> | undefined
            if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) {
              for (const item of scan(delta['text'] as string)) stream.push(item)
            }
          }
        }
        // Final result — catches anything not yet scanned.
        if (ev['type'] === 'result' && typeof ev['result'] === 'string') {
          for (const item of scan(ev['result'] as string)) stream.push(item)
        }
      } catch {
        /* non-event line */
      }
    })

    let stderrBuf = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
    })

    proc.on('close', (code) => {
      rl.close()
      opts?.signal?.removeEventListener('abort', onAbort)
      if (stderrBuf) console.error('[runner] claude stderr:', stderrBuf.slice(0, 500))
      if (code === 0) stream.close()
      else stream.fail(new Error(`claude exited with code ${code}`))
    })

    proc.on('error', (err: Error) => {
      rl.close()
      opts?.signal?.removeEventListener('abort', onAbort)
      stream.fail(err)
    })
  }
}

/**
 * Harness-free path for local models: stream Ollama's **native** `/api/chat`
 * and extract NDJSON items with the same scanner. Refuses any non-Ollama model
 * — the Anthropic-compat endpoint hangs (Ollama #13949), so we never touch it.
 */
export class DirectRunner implements Runner {
  async *run<Item>(req: RunRequest<Item>, opts?: RunOptions): AsyncIterable<Item> {
    const model = req.model
    if (!model || model.provider !== 'ollama') {
      throw new Error('DirectRunner requires an Ollama model (native /api/chat); refusing to run')
    }

    const messages: ChatMessage[] = req.system
      ? [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ]
      : [{ role: 'user', content: req.user }]

    const scan = createFindingScanner<Item>(req.parse)
    for await (const chunk of chatStream({
      model: model.model,
      messages,
      endpoint: model.endpoint,
      // num_ctx default (past Ollama's truncating 4096) lives in chatStream.
      signal: opts?.signal,
    })) {
      for (const item of scan(chunk)) yield item
    }
  }
}

export interface CodexRunnerOptions {
  cwd: string
  model?: string
  reasoningEffort?: import('../../shared/ipc-types').ReasoningEffort
  skipGitRepoCheck?: boolean
}

/**
 * Args for a bounded, read-only analysis run.
 *
 * `approval_policy` goes through `exec`'s own `-c` rather than the top-level
 * `--ask-for-approval` flag: that flag is NOT an option of `codex exec` (it only
 * exists on the root command), so passing it ahead of the subcommand relies on
 * clap propagating it inward. The config override is the same setting by its
 * documented name, accepted by `exec` directly — no propagation assumption. It
 * matters because a run that stopped to ask for approval would hang forever
 * with no one to answer.
 */
export function buildCodexExecArgs(opts: CodexRunnerOptions): string[] {
  const args = [
    'exec', '--json', '--ephemeral', '--sandbox', 'read-only',
    '-c', 'approval_policy="never"',
  ]
  if (opts.skipGitRepoCheck) args.push('--skip-git-repo-check')
  if (opts.model) args.push('--model', opts.model)
  if (opts.reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`)
  // `-` reads the prompt from stdin; must stay last.
  args.push('-')
  return args
}

export function codexPrompt(system: string, user: string): string {
  return system ? `${system}\n\n${user}` : user
}

/**
 * The assistant text from a completed `agent_message` item.
 *
 * Gated on `item.completed`: Codex's `--json` stream also emits `item.started`
 * and `item.updated` for the same item (verified against codex-cli 0.146.0),
 * carrying partial text. Accepting those too would feed the finding scanner
 * prefixes of a message it is about to receive in full.
 */
export function codexAgentText(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  const record = event as Record<string, unknown>
  if (record['type'] !== 'item.completed') return null
  const item = record['item']
  if (!item || typeof item !== 'object' || (item as Record<string, unknown>)['type'] !== 'agent_message') return null
  const text = (item as Record<string, unknown>)['text'] ?? (item as Record<string, unknown>)['message']
  return typeof text === 'string' ? text : null
}

/**
 * The failure message from a `turn.failed` event, if this is one.
 *
 * A turn can fail (rate limit, refusal, tool error) without `codex exec` itself
 * exiting non-zero, and the run would then look like a clean pass that simply
 * found nothing — the worst outcome for a review task. Surfacing it turns a
 * silent empty result into a reported error.
 */
export function codexTurnFailure(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  const record = event as Record<string, unknown>
  if (record['type'] !== 'turn.failed') return null
  const error = record['error']
  const message = error && typeof error === 'object' ? (error as Record<string, unknown>)['message'] : undefined
  return typeof message === 'string' && message ? message : 'codex reported a failed turn'
}

/** Read-only, non-interactive Codex execution for bounded analysis tasks. */
export interface OpenCodeRunnerOptions {
  cwd: string
  model?: string
  reasoningEffort?: import('../../shared/ipc-types').ReasoningEffort
}

/**
 * Args for a bounded, read-only OpenCode analysis run.
 *
 * `run --format json` is the `codex exec --json` analogue: it emits one NDJSON
 * frame per event and exits, with no TUI. The prompt is positional here —
 * unlike the interactive command, whose positional is the project path — and
 * must stay last.
 *
 * Read-only is enforced through `OPENCODE_PERMISSION` (see
 * `openCodeReadOnlyEnv`) rather than a flag: OpenCode has no `--sandbox`
 * equivalent, and its only CLI-level control is `--auto`, which approves
 * everything. Passing the permission ruleset denies the mutating tools outright.
 */
export function buildOpenCodeRunArgs(opts: OpenCodeRunnerOptions): string[] {
  const args = ['run', '--format', 'json']
  if (opts.model) args.push('--model', opts.model)
  if (opts.reasoningEffort) args.push('--variant', opts.reasoningEffort)
  return args
}

/**
 * A permission ruleset denying every tool that can change the world, for
 * bounded review/tour tasks. `read`/`grep`/`glob`/`list`/`lsp` stay allowed:
 * an analysis task must be able to look at the tree it is reviewing.
 *
 * `bash` is denied outright. It is the one tool whose read-only-ness cannot be
 * decided from the call — `bash("git log")` and `bash("git push")` are the same
 * tool — so allowing it would make the read-only claim untrue.
 */
export function openCodeReadOnlyEnv(): Record<string, string> {
  return {
    OPENCODE_PERMISSION: JSON.stringify({
      read: 'allow',
      grep: 'allow',
      glob: 'allow',
      list: 'allow',
      lsp: 'allow',
      webfetch: 'deny',
      websearch: 'deny',
      edit: 'deny',
      bash: 'deny',
      task: 'deny',
      external_directory: 'deny',
    }),
  }
}

/**
 * The assistant text from an OpenCode `run --format json` frame.
 *
 * Gated on `type === 'text'`, whose `part.text` is the complete block — verified
 * against a captured 1.17.13 stream, whose frames are `step_start`, `tool_use`,
 * `step_finish` and `text`. Reasoning frames are deliberately excluded: feeding
 * the model's thinking to the finding scanner would let a JSON object it merely
 * *considered* be reported as a finding.
 */
export function openCodeAgentText(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  const record = event as Record<string, unknown>
  if (record['type'] !== 'text') return null
  const part = record['part']
  if (!part || typeof part !== 'object') return null
  const text = (part as Record<string, unknown>)['text']
  return typeof text === 'string' ? text : null
}

/**
 * Bounded, read-only OpenCode execution for review/tour lenses.
 *
 * Mirrors `CodexRunner`, with the prompt passed as an argument rather than on
 * stdin: `opencode run` takes its message positionally and does not read stdin.
 */
export class OpenCodeRunner implements Runner {
  constructor(private readonly opts: OpenCodeRunnerOptions) {}

  run<Item>(req: RunRequest<Item>, opts?: RunOptions): AsyncIterable<Item> {
    const stream = createPushStream<Item>()
    this.spawn(req, stream, opts).catch((err) => stream.fail(err))
    return stream.iterable
  }

  private async spawn<Item>(req: RunRequest<Item>, stream: PushStream<Item>, opts?: RunOptions): Promise<void> {
    const bin = await resolveOpenCodePath()
    const args = [...buildOpenCodeRunArgs(this.opts), codexPrompt(req.system, req.user)]

    const proc = spawn(bin, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...openCodeReadOnlyEnv() } as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onAbort = (): void => { try { proc.kill() } catch { /* already dead */ } }
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    const scan = createFindingScanner<Item>(req.parse)
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      try {
        const text = openCodeAgentText(JSON.parse(line))
        if (text) for (const parsed of scan(text)) stream.push(parsed)
      } catch {
        // Ignore diagnostics and malformed frames; exit status stays authoritative.
      }
    })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      rl.close()
      opts?.signal?.removeEventListener('abort', onAbort)
      if (code !== 0) {
        stream.fail(new Error(`opencode exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 1000)}` : ''}`))
      } else {
        stream.close()
      }
    })
    proc.on('error', (err: Error) => {
      rl.close()
      opts?.signal?.removeEventListener('abort', onAbort)
      stream.fail(err)
    })
  }
}

export class CodexRunner implements Runner {
  constructor(private readonly opts: CodexRunnerOptions) {}

  run<Item>(req: RunRequest<Item>, opts?: RunOptions): AsyncIterable<Item> {
    const stream = createPushStream<Item>()
    this.spawn(req, stream, opts).catch((err) => stream.fail(err))
    return stream.iterable
  }

  private async spawn<Item>(req: RunRequest<Item>, stream: PushStream<Item>, opts?: RunOptions): Promise<void> {
    const codexBin = await resolveCodexPath()
    const args = buildCodexExecArgs(this.opts)

    const proc = spawn(codexBin, args, {
      cwd: this.opts.cwd,
      env: process.env as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const onAbort = (): void => { try { proc.kill() } catch { /* already dead */ } }
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    const prompt = codexPrompt(req.system, req.user)
    proc.stdin.end(prompt, 'utf8')
    const scan = createFindingScanner<Item>(req.parse)
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })
    let turnFailure: string | null = null
    rl.on('line', (line) => {
      try {
        const event: unknown = JSON.parse(line)
        turnFailure ??= codexTurnFailure(event)
        const text = codexAgentText(event)
        if (text) for (const parsed of scan(text)) stream.push(parsed)
      } catch {
        // Ignore diagnostics and malformed events; the exit status remains authoritative.
      }
    })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      rl.close()
      opts?.signal?.removeEventListener('abort', onAbort)
      if (code !== 0) {
        stream.fail(new Error(`codex exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 1000)}` : ''}`))
      } else if (turnFailure) {
        // Exit 0 with a failed turn: report it rather than letting the caller
        // read "no findings" as a clean pass.
        stream.fail(new Error(`codex turn failed: ${turnFailure}`))
      } else {
        stream.close()
      }
    })
    proc.on('error', (err: Error) => {
      rl.close()
      opts?.signal?.removeEventListener('abort', onAbort)
      stream.fail(err)
    })
  }
}
