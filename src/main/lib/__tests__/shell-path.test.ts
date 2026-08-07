/**
 * Executable resolution caching. The point of interest is the NEGATIVE case:
 * caching "not installed" forever means installing an agent CLI while
 * SimpleEdit runs leaves it invisible until a restart.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ execFile }))

import { resolveExecutable, isExecutableAvailable, resetExecutableCache } from '../shell-path'

/** Next `command -v` result: a path, or null for "not found". */
function reply(path: string | null): void {
  execFile.mockImplementationOnce((_shell, _args, cb) => {
    cb(path ? null : new Error('not found'), path ?? '', '')
  })
}

// Drive the miss window off an explicit clock rather than fake timers — the
// TTL is compared against Date.now(), not scheduled on a timer.
let now = 1_000_000
beforeEach(() => {
  resetExecutableCache()
  execFile.mockReset()
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => vi.restoreAllMocks())

describe('resolveExecutable', () => {
  it('caches a successful resolution and stops shelling out', async () => {
    reply('/usr/local/bin/codex')
    expect(await resolveExecutable('codex')).toBe('/usr/local/bin/codex')
    expect(await resolveExecutable('codex')).toBe('/usr/local/bin/codex')
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent lookups into one shell invocation', async () => {
    reply('/usr/local/bin/claude')
    const [a, b] = await Promise.all([resolveExecutable('claude'), resolveExecutable('claude')])
    expect(a).toBe('/usr/local/bin/claude')
    expect(b).toBe('/usr/local/bin/claude')
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('does not re-probe immediately after a miss', async () => {
    reply(null)
    expect(await resolveExecutable('codex')).toBeNull()
    expect(await resolveExecutable('codex')).toBeNull()
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('re-probes after the miss window, so installing the CLI later is picked up', async () => {
    reply(null)
    expect(await isExecutableAvailable('codex')).toBe(false)

    // The user installs codex while SimpleEdit is running.
    now += 31_000
    reply('/opt/homebrew/bin/codex')
    expect(await isExecutableAvailable('codex')).toBe(true)
    expect(await resolveExecutable('codex')).toBe('/opt/homebrew/bin/codex')
    // Two probes: the initial miss and the one after the window expired. The
    // final call is served from cache.
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('keeps each executable independent', async () => {
    reply('/bin/claude')
    reply(null)
    expect(await resolveExecutable('claude')).toBe('/bin/claude')
    expect(await resolveExecutable('codex')).toBeNull()
  })
})
