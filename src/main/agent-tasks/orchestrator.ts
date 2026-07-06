/**
 * Bounded-task orchestrator. Minimal for now: a single task, one model, one
 * runner. (Fan-out for screen-PRs lands later — see plans/bounded-tasks.md.)
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
