import { describe, it, expect, beforeEach, vi } from 'vitest'

const electronApp = {
  isPackaged: true,
  getVersion: () => '1.2.3',
  getPath: (name: string) =>
    name === 'exe' ? '/Applications/SimpleEdit.app/Contents/MacOS/SimpleEdit' : '/userData'
}

let existing: string[] = []
const written = new Map<string, string>()
const removed: string[] = []
const opened: Array<{ path: string; flags: string }> = []
let readable = new Map<string, string>()

vi.mock('electron', () => ({ app: electronApp }))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => existing.includes(path),
  writeFileSync: (path: string, data: string) => {
    written.set(path, data)
    existing.push(path)
  },
  rmSync: (path: string) => {
    removed.push(path)
    existing = existing.filter((p) => p !== path)
  },
  readFileSync: (path: string) => {
    const value = readable.get(path)
    if (value === undefined) throw new Error(`ENOENT: ${path}`)
    return value
  },
  openSync: (path: string, flags: string) => {
    opened.push({ path, flags })
    return 42
  },
  closeSync: vi.fn()
}))

const spawned: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
const unref = vi.fn()
let spawnImpl: () => unknown = () => ({ unref })

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawned.push({ cmd, args, opts })
    return spawnImpl()
  }
}))

const ARM_BREW = '/opt/homebrew/bin/brew'
const INTEL_BREW = '/usr/local/bin/brew'
const SCRIPT = '/userData/homebrew-update.sh'
const RESULT = '/userData/homebrew-update.json'
const LOG = '/userData/homebrew-update.log'

async function load() {
  vi.resetModules()
  return import('../homebrew')
}

const realPlatform = process.platform

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  existing = []
  written.clear()
  removed.length = 0
  opened.length = 0
  readable = new Map()
  spawned.length = 0
  unref.mockClear()
  spawnImpl = () => ({ unref })
  electronApp.isPackaged = true
  setPlatform('darwin')
})

describe('isHomebrewManaged', () => {
  it('recognises a Caskroom entry for the running version', async () => {
    existing = ['/opt/homebrew/Caskroom/simpleedit/1.2.3']
    const { isHomebrewManaged } = await load()
    expect(isHomebrewManaged()).toBe(true)
  })

  it('recognises the Intel prefix', async () => {
    existing = ['/usr/local/Caskroom/simpleedit/1.2.3']
    const { isHomebrewManaged } = await load()
    expect(isHomebrewManaged()).toBe(true)
  })

  // A copy the user replaced by hand is no longer brew's to upgrade.
  it('ignores a Caskroom entry for another version', async () => {
    existing = ['/opt/homebrew/Caskroom/simpleedit/0.9.0']
    const { isHomebrewManaged } = await load()
    expect(isHomebrewManaged()).toBe(false)
  })

  it('never fires for an unpackaged build', async () => {
    existing = ['/opt/homebrew/Caskroom/simpleedit/1.2.3']
    electronApp.isPackaged = false
    const { isHomebrewManaged } = await load()
    expect(isHomebrewManaged()).toBe(false)
  })

  it('never fires off macOS', async () => {
    existing = ['/opt/homebrew/Caskroom/simpleedit/1.2.3']
    setPlatform('linux')
    const { isHomebrewManaged } = await load()
    expect(isHomebrewManaged()).toBe(false)
    setPlatform(realPlatform)
  })
})

describe('findBrewBinary', () => {
  it('prefers the Apple silicon prefix', async () => {
    existing = [ARM_BREW, INTEL_BREW]
    const { findBrewBinary } = await load()
    expect(findBrewBinary()).toBe(ARM_BREW)
  })

  it('falls back to the Intel prefix', async () => {
    existing = [INTEL_BREW]
    const { findBrewBinary } = await load()
    expect(findBrewBinary()).toBe(INTEL_BREW)
  })

  it('returns null when brew is nowhere', async () => {
    const { findBrewBinary } = await load()
    expect(findBrewBinary()).toBeNull()
  })
})

describe('startHomebrewUpgrade', () => {
  it('starts the helper detached, so it outlives the app it replaces', async () => {
    existing = [ARM_BREW]
    const { startHomebrewUpgrade, UPGRADE_SCRIPT } = await load()

    expect(startHomebrewUpgrade('2.0.0')).toEqual({ ok: true })

    expect(written.get(SCRIPT)).toBe(UPGRADE_SCRIPT)
    expect(spawned).toHaveLength(1)
    const [call] = spawned
    expect(call.cmd).toBe('/bin/sh')
    expect(call.args).toEqual([
      SCRIPT,
      String(process.pid),
      ARM_BREW,
      'pago/simpleedit/simpleedit',
      RESULT,
      '/Applications/SimpleEdit.app',
      'com.simpleedit.app',
      '2.0.0'
    ])
    expect(call.opts).toMatchObject({ detached: true, stdio: ['ignore', 42, 42] })
    expect(unref).toHaveBeenCalled()
  })

  // Otherwise the previous attempt's verdict is reported as this one's.
  it('clears a stale result before starting', async () => {
    existing = [ARM_BREW]
    const { startHomebrewUpgrade } = await load()

    startHomebrewUpgrade('2.0.0')

    expect(removed).toContain(RESULT)
  })

  // Truncated, not appended: nothing else prunes it.
  it('truncates the log for each attempt', async () => {
    existing = [ARM_BREW]
    const { startHomebrewUpgrade } = await load()

    startHomebrewUpgrade('2.0.0')

    expect(opened).toEqual([{ path: LOG, flags: 'w' }])
  })

  it('explains itself when brew cannot be found, and never spawns', async () => {
    const { startHomebrewUpgrade } = await load()

    const result = startHomebrewUpgrade('2.0.0')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('/opt/homebrew')
    expect(result.error).toContain('brew upgrade --cask pago/simpleedit/simpleedit')
    expect(spawned).toHaveLength(0)
  })

  it('reports a failed spawn rather than claiming the update started', async () => {
    existing = [ARM_BREW]
    spawnImpl = () => {
      throw new Error('EAGAIN')
    }
    const { startHomebrewUpgrade } = await load()

    expect(startHomebrewUpgrade('2.0.0')).toEqual({
      ok: false,
      error: 'Could not start the update helper: EAGAIN'
    })
  })
})

describe('takeUpgradeResult', () => {
  it('returns nothing when no upgrade ran', async () => {
    const { takeUpgradeResult } = await load()
    expect(takeUpgradeResult()).toBeNull()
  })

  it('parses the verdict and consumes the file', async () => {
    existing = [RESULT]
    readable.set(RESULT, '{"ok":false,"stage":"upgrade","version":"2.0.0","detail":"status 17"}')
    const { takeUpgradeResult } = await load()

    expect(takeUpgradeResult()).toEqual({
      ok: false,
      stage: 'upgrade',
      version: '2.0.0',
      detail: 'status 17'
    })
    expect(removed).toContain(RESULT)
  })

  // The helper is the only witness to what happened while the app was gone, so a
  // result we cannot read has to surface as a failure rather than as silence.
  it('treats unparseable output as a failure', async () => {
    existing = [RESULT]
    readable.set(RESULT, '{"ok":tr')
    const { takeUpgradeResult } = await load()

    const result = takeUpgradeResult()

    expect(result?.ok).toBe(false)
    expect(result?.detail).toContain('not valid JSON')
    expect(removed).toContain(RESULT)
  })

  it('treats a truncated result as a failure', async () => {
    existing = [RESULT]
    readable.set(RESULT, '{"stage":"done"}')
    const { takeUpgradeResult } = await load()

    expect(takeUpgradeResult()?.ok).toBe(false)
  })

  // Consumed even on failure, so one bad upgrade cannot nag on every launch.
  it('does not report the same failure twice', async () => {
    existing = [RESULT]
    readable.set(RESULT, '{"ok":false,"stage":"upgrade","version":"2","detail":"x"}')
    const { takeUpgradeResult } = await load()

    expect(takeUpgradeResult()?.ok).toBe(false)
    expect(takeUpgradeResult()).toBeNull()
  })
})
