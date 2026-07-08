/**
 * Bounded-task orchestrator. Two entry points sharing one `Task`/`Runner` core:
 * `runTask` (a single bounded judgment, streamed) and `runFanout` (N independent
 * judgments over the same task, capped concurrency, results emitted as they land
 * — the substrate path screen-PRs is built on; see plans/bounded-tasks.md).
 */
import type { ModelRef } from '../../shared/ipc-types'
import type { Runner } from './runner'

/**
 * A bounded task: assemble context, build a prompt, validate each streamed
 * result item. `parse` stands in for the design's `schema: JSONSchema` (see
 * runner.ts) — the item validator is reused verbatim across runners.
 */
export interface Task<Input, Ctx, Item> {
  name: string
  buildContext(input: Input): Promise<Ctx>
  buildPrompt(ctx: Ctx): { system: string; user: string }
  parse(obj: unknown): Item | null
}

export interface RunTaskOptions<Ctx> {
  runner: Runner
  model?: ModelRef
  signal?: AbortSignal
  /**
   * A pre-built context. When present, `buildContext` is skipped — lets a caller
   * inspect the context (e.g. short-circuit on an empty diff) without gathering
   * it twice.
   */
  context?: Ctx
}

export async function* runTask<Input, Ctx, Item>(
  task: Task<Input, Ctx, Item>,
  input: Input,
  opts: RunTaskOptions<Ctx>
): AsyncIterable<Item> {
  const ctx = opts.context ?? (await task.buildContext(input))
  const { system, user } = task.buildPrompt(ctx)
  yield* opts.runner.run<Item>(
    { system, user, parse: (obj) => task.parse(obj), model: opts.model },
    { signal: opts.signal }
  )
}

/**
 * One lifecycle event for a single fan-out input. The stream carries the same
 * shape a single task emits (running → items → done/error), tagged with which
 * input (and its `index`) it belongs to — so the renderer treats
 * streaming-within-a-task and results-across-tasks identically:
 * - `start` — the input's task began (show a card/lens in a running state)
 * - `item`  — one validated result item (`item` is set)
 * - `done`  — the input's task finished (also used for a user-initiated abort)
 * - `error` — the input's task threw (`error` is set); other inputs are unaffected
 */
export interface FanoutEvent<Input, Item> {
  input: Input
  index: number
  kind: 'start' | 'item' | 'done' | 'error'
  item?: Item
  error?: string
}

export interface RunFanoutOptions {
  runner: Runner
  model?: ModelRef
  signal?: AbortSignal
  /**
   * Max task-runs in flight at once (default 4, clamped to ≥1). This is an upper
   * bound only — a backend concurrency gate (local-serial for GPU-bound Ollama,
   * parallel for cloud) may constrain it further; see plans/bounded-tasks.md.
   */
  concurrency?: number
  /**
   * Per-input budget in ms. A run exceeding it is aborted and reported as its own
   * `error` event (the fan-out moves on) — so one stuck/slow model call can't
   * freeze the whole batch. Omit for no limit.
   */
  timeoutMs?: number
}

/**
 * Run `task` over every input independently, at most `concurrency` at a time,
 * emitting each input's lifecycle events as they land (not batched, not ordered
 * by input — interleaved as work completes). Each input builds its own context,
 * so `RunTaskOptions.context` has no analogue here. A single input's failure is
 * reported as its own `error` event and never rejects the whole stream.
 */
export async function* runFanout<Input, Ctx, Item>(
  task: Task<Input, Ctx, Item>,
  inputs: Input[],
  opts: RunFanoutOptions
): AsyncIterable<FanoutEvent<Input, Item>> {
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  const total = inputs.length

  // A single-consumer queue bridging the worker pool to this generator. `push`
  // never blocks (buffer just grows); the generator wakes on the next event.
  const buffer: FanoutEvent<Input, Item>[] = []
  let wake: (() => void) | null = null
  const push = (e: FanoutEvent<Input, Item>): void => {
    buffer.push(e)
    if (wake) {
      const w = wake
      wake = null
      w()
    }
  }

  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return
      const index = cursor++
      if (index >= total) return
      const input = inputs[index]
      push({ input, index, kind: 'start' })
      // Per-input abort: fires on the outer signal (user cancel) or the timeout.
      const ac = new AbortController()
      const onOuter = (): void => ac.abort()
      opts.signal?.addEventListener('abort', onOuter, { once: true })
      let timedOut = false
      const timer =
        opts.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true
              ac.abort()
            }, opts.timeoutMs)
          : null
      try {
        // Deliberately not forwarding `context`: each input builds its own.
        for await (const item of runTask(task, input, {
          runner: opts.runner,
          model: opts.model,
          signal: ac.signal,
        })) {
          push({ input, index, kind: 'item', item })
        }
        push({ input, index, kind: 'done' })
      } catch (err: unknown) {
        // User cancel → neutral done (mirrors review.ts). Timeout → error (the
        // batch moves on). Otherwise the runner's real error.
        if (opts.signal?.aborted) push({ input, index, kind: 'done' })
        else if (timedOut) push({ input, index, kind: 'error', error: `timed out after ${opts.timeoutMs}ms` })
        else push({ input, index, kind: 'error', error: err instanceof Error ? err.message : String(err) })
      } finally {
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onOuter)
      }
    }
  }

  let poolDone = false
  const finish = (): void => {
    poolDone = true
    if (wake) {
      const w = wake
      wake = null
      w()
    }
  }
  // Workers catch their own errors, so Promise.all should never reject; the
  // catch is defensive so an unexpected throw settles the generator rather than
  // hanging it.
  void Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker())).then(finish, finish)

  for (;;) {
    if (buffer.length) {
      yield buffer.shift() as FanoutEvent<Input, Item>
      continue
    }
    if (poolDone) return
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }
}
