/**
 * Backend concurrency gate (plans/bounded-tasks.md §4.2). Concurrency can't be a
 * per-fan-out counter: local models are GPU-bound (Ollama serializes; parallel
 * DirectRunner calls thrash), while cloud calls parallelize freely. So bounded
 * work requests a slot from its *backend's* gate:
 *   - local (Ollama) → one global serial queue, shared by ALL local work
 *   - cloud          → a bounded parallel pool
 * Speed is not the driver — not thrashing the GPU is.
 */
import type { ModelRef } from '../../shared/ipc-types'

/** Serializes: each run waits for the previous to settle (success or failure). */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/** Caps concurrent runs at `max`; excess queue until a slot frees. */
class Semaphore {
  private active = 0
  private waiters: Array<() => void> = []
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}

const localGate = new Mutex()
const cloudGate = new Semaphore(4)

/** True when the model runs against the local GPU (Ollama), which must serialize. */
export function isLocal(model?: ModelRef): boolean {
  return model?.provider === 'ollama'
}

/** Run `fn` under the gate for `model`'s backend (local serial / cloud parallel). */
export function withBackendGate<T>(model: ModelRef | undefined, fn: () => Promise<T>): Promise<T> {
  return isLocal(model) ? localGate.run(fn) : cloudGate.run(fn)
}
