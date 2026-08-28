import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cachedDiff, fetchDiff, verdictChoice } from '../prs.svelte'

/**
 * The diff arrives on demand, so the fetch has to behave: one request per PR at
 * a head SHA however many times it is asked for, a fresh one when the head
 * moves, and a failure that can be retried rather than cached.
 */
let invoke: ReturnType<typeof vi.fn>
let diffs: Map<string, string | Error>

beforeEach(() => {
  diffs = new Map()
  invoke = vi.fn(async (channel: string, pr: { url: string }) => {
    if (channel !== 'screenprs:pr-diff') return undefined
    const value = diffs.get(pr.url)
    if (value instanceof Error) throw value
    return value ?? ''
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })
})

describe('fetchDiff', () => {
  it('runs one request for concurrent asks — a double tap is not two `gh pr diff`s', async () => {
    diffs.set('u1', 'DIFF')
    const [a, b] = await Promise.all([fetchDiff('u1', 'sha'), fetchDiff('u1', 'sha')])
    expect(a).toBe('DIFF')
    expect(b).toBe('DIFF')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('serves a second visit from the cache', async () => {
    diffs.set('u2', 'DIFF')
    await fetchDiff('u2', 'sha')
    expect(cachedDiff('u2', 'sha')).toBe('DIFF')
    await fetchDiff('u2', 'sha')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('refetches when the head moves — line numbers must match the code shown', async () => {
    diffs.set('u3', 'OLD')
    await fetchDiff('u3', 'sha1')
    diffs.set('u3', 'NEW')
    expect(await fetchDiff('u3', 'sha2')).toBe('NEW')
    expect(cachedDiff('u3', 'sha2')).toBe('NEW')
  })

  it('does not cache a failure, so a retry can succeed', async () => {
    diffs.set('u4', new Error('gh exploded'))
    await expect(fetchDiff('u4', 'sha')).rejects.toThrow('gh exploded')
    diffs.set('u4', 'DIFF')
    expect(await fetchDiff('u4', 'sha')).toBe('DIFF')
  })
})

describe('verdictChoice', () => {
  it('starts unmade, survives until reset, and is per PR', () => {
    expect(verdictChoice.made('p1')).toBe(false)
    verdictChoice.make('p1')
    expect(verdictChoice.made('p1')).toBe(true)
    expect(verdictChoice.made('p2')).toBe(false)
    verdictChoice.reset('p1')
    expect(verdictChoice.made('p1')).toBe(false)
  })
})
