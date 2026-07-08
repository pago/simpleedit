import { describe, it, expect } from 'vitest'
import { withBackendGate, isLocal } from '../gate'
import type { ModelRef } from '../../../shared/ipc-types'

const local: ModelRef = { provider: 'ollama', model: 'qwen' }
const cloud: ModelRef = { provider: 'anthropic', model: 'sonnet' }
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('isLocal', () => {
  it('is true only for ollama', () => {
    expect(isLocal(local)).toBe(true)
    expect(isLocal(cloud)).toBe(false)
    expect(isLocal(undefined)).toBe(false)
  })
})

describe('withBackendGate — local (GPU-serial)', () => {
  it('runs local work strictly one at a time, in order', async () => {
    const order: string[] = []
    const releasers: Array<() => void> = []
    const run = (id: string): Promise<void> =>
      withBackendGate(local, async () => {
        order.push(`start${id}`)
        await new Promise<void>((r) => releasers.push(r))
        order.push(`end${id}`)
      })
    const all = Promise.all([run('1'), run('2'), run('3')])

    await tick()
    expect(order).toEqual(['start1']) // only the first is running
    expect(releasers.length).toBe(1)

    releasers[0]()
    await tick()
    expect(order).toEqual(['start1', 'end1', 'start2'])

    releasers[1]()
    await tick()
    releasers[2]()
    await all
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2', 'start3', 'end3'])
  })

  it('a failing local task still releases the queue', async () => {
    await expect(withBackendGate(local, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // The next local task must still run (queue not wedged).
    await expect(withBackendGate(local, async () => 'ok')).resolves.toBe('ok')
  })
})

describe('withBackendGate — cloud (parallel)', () => {
  it('runs cloud work concurrently', async () => {
    let active = 0
    let peak = 0
    const releasers: Array<() => void> = []
    const run = (): Promise<void> =>
      withBackendGate(cloud, async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise<void>((r) => releasers.push(r))
        active--
      })
    const all = Promise.all([run(), run(), run()])
    await tick()
    expect(peak).toBe(3) // all three in flight at once
    releasers.forEach((r) => r())
    await all
  })
})
