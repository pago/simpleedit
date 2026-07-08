import { describe, it, expect } from 'vitest'
import { runFanout, type Task, type FanoutEvent } from '../orchestrator'
import type { Runner, RunRequest, RunOptions } from '../runner'

// ── helpers ─────────────────────────────────────────────────────────────────

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of it) out.push(item)
  return out
}

/** Flush pending microtasks + one macrotask turn, so worker progress settles. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * A trivial task whose prompt carries the numeric input; the mock runners
 * decide what items come back, so `parse` is identity and never really used.
 */
const idTask: Task<number, { n: number }, string> = {
  name: 'id',
  async buildContext(n) {
    return { n }
  },
  buildPrompt(ctx) {
    return { system: '', user: String(ctx.n) }
  },
  parse: (o) => (typeof o === 'string' ? o : null),
}

/** Yields a fixed number of items per run, derived from the prompt. */
class YieldRunner implements Runner {
  constructor(private readonly perRun = 1) {}
  run<Item>(req: RunRequest<Item>): AsyncIterable<Item> {
    const { perRun } = this
    const user = req.user
    return (async function* () {
      for (let i = 0; i < perRun; i++) yield (`${user}:${i}` as unknown as Item)
    })()
  }
}

/** Blocks each run on a releaser so the test can drive concurrency by hand. */
class GateRunner implements Runner {
  active = 0
  peak = 0
  releasers: Array<() => void> = []
  run<Item>(req: RunRequest<Item>): AsyncIterable<Item> {
    const self = this
    const user = req.user
    return (async function* () {
      self.active++
      self.peak = Math.max(self.peak, self.active)
      await new Promise<void>((res) => self.releasers.push(res))
      yield (`${user}` as unknown as Item)
      self.active--
    })()
  }
}

/** Throws from the runner for a chosen prompt value. */
class ThrowRunner implements Runner {
  constructor(private readonly failUser: string) {}
  run<Item>(req: RunRequest<Item>, _opts?: RunOptions): AsyncIterable<Item> {
    const failUser = this.failUser
    const user = req.user
    return (async function* () {
      if (user === failUser) throw new Error(`boom:${user}`)
      yield (`${user}` as unknown as Item)
    })()
  }
}

const byIndex = (a: FanoutEvent<number, string>, b: FanoutEvent<number, string>): number =>
  a.index - b.index

// ── tests ─────────────────────────────────────────────────────────────────

describe('runFanout', () => {
  it('emits start → item(s) → done for every input', async () => {
    const events = await collect(runFanout(idTask, [10, 20], { runner: new YieldRunner(2) }))

    for (const idx of [0, 1]) {
      const forIdx = events.filter((e) => e.index === idx)
      expect(forIdx.map((e) => e.kind)).toEqual(['start', 'item', 'item', 'done'])
    }
    // The input value is echoed on every event.
    expect(events.filter((e) => e.index === 0).every((e) => e.input === 10)).toBe(true)
    // Item payloads flow through untouched.
    const items = events.filter((e) => e.index === 1 && e.kind === 'item').map((e) => e.item)
    expect(items).toEqual(['20:0', '20:1'])
  })

  it('covers all inputs exactly once', async () => {
    const events = await collect(runFanout(idTask, [1, 2, 3, 4, 5], { runner: new YieldRunner(1), concurrency: 2 }))
    const starts = events.filter((e) => e.kind === 'start').sort(byIndex)
    expect(starts.map((e) => e.input)).toEqual([1, 2, 3, 4, 5])
    expect(events.filter((e) => e.kind === 'done')).toHaveLength(5)
  })

  it('never runs more than `concurrency` tasks at once', async () => {
    const runner = new GateRunner()
    const done = collect(runFanout(idTask, [1, 2, 3, 4, 5], { runner, concurrency: 2 }))

    await tick()
    // Only two workers exist, so at most two runs are ever blocked/in-flight.
    expect(runner.releasers.length).toBe(2)
    expect(runner.peak).toBeLessThanOrEqual(2)

    // Drain: releasing lets a worker finish and pick up the next input.
    while (runner.releasers.length) {
      runner.releasers.shift()!()
      await tick()
    }

    const events = await done
    expect(runner.peak).toBe(2)
    expect(events.filter((e) => e.kind === 'done')).toHaveLength(5)
  })

  it('isolates a failing input as its own error event; others still complete', async () => {
    const events = await collect(
      runFanout(idTask, [1, 2, 3], { runner: new ThrowRunner('2'), concurrency: 3 })
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err).toBeDefined()
    expect(err!.input).toBe(2)
    expect(err!.error).toMatch(/boom:2/)
    // 1 and 3 still finish cleanly.
    expect(events.filter((e) => e.kind === 'done').map((e) => e.input).sort()).toEqual([1, 3])
    // The failing input emits no `done`.
    expect(events.filter((e) => e.index === 1 && e.kind === 'done')).toHaveLength(0)
  })

  it('reports a buildContext failure as that input’s error', async () => {
    const task: Task<number, { n: number }, string> = {
      ...idTask,
      async buildContext(n) {
        if (n === 2) throw new Error('ctx-fail')
        return { n }
      },
    }
    const events = await collect(runFanout(task, [1, 2], { runner: new YieldRunner(1), concurrency: 2 }))
    expect(events.find((e) => e.input === 2 && e.kind === 'error')?.error).toMatch(/ctx-fail/)
    expect(events.find((e) => e.input === 1 && e.kind === 'done')).toBeDefined()
  })

  it('handles empty input with no events', async () => {
    const events = await collect(runFanout(idTask, [], { runner: new YieldRunner(1) }))
    expect(events).toEqual([])
  })

  it('treats concurrency < 1 as 1', async () => {
    const runner = new GateRunner()
    const done = collect(runFanout(idTask, [1, 2], { runner, concurrency: 0 }))
    await tick()
    expect(runner.releasers.length).toBe(1) // only one worker
    while (runner.releasers.length) {
      runner.releasers.shift()!()
      await tick()
    }
    expect((await done).filter((e) => e.kind === 'done')).toHaveLength(2)
  })

  it('an already-aborted signal produces no events', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(
      runFanout(idTask, [1, 2, 3], { runner: new YieldRunner(1), signal: controller.signal })
    )
    expect(events).toEqual([])
  })

  it('reports an aborted in-flight run as a neutral done, not an error', async () => {
    const controller = new AbortController()
    // Runner that throws once aborted (how a killed child surfaces).
    const abortRunner: Runner = {
      run<Item>(req: RunRequest<Item>): AsyncIterable<Item> {
        return (async function* () {
          await tick()
          if (controller.signal.aborted) throw new Error('killed')
          yield (`${req.user}` as unknown as Item)
        })()
      },
    }
    const done = collect(runFanout(idTask, [1], { runner: abortRunner, signal: controller.signal }))
    await tick()
    controller.abort()
    const events = await done
    expect(events.some((e) => e.kind === 'error')).toBe(false)
    expect(events.some((e) => e.kind === 'done')).toBe(true)
  })
})
