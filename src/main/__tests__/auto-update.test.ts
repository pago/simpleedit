import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

const sent: Array<{ channel: string; data: unknown }> = []
const handlers = new Map<string, (...args: unknown[]) => unknown>()

const squirrel = new EventEmitter()
const updater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  checkForUpdates: vi.fn().mockResolvedValue(null),
  quitAndInstall: vi.fn()
})
const electronApp = { isPackaged: true, getVersion: () => '1.0.0', quit: vi.fn() }

// Detection and the detached helper are homebrew.ts's job and tested there; here
// we only care that the updater routes to them.
const homebrew = {
  isHomebrewManaged: vi.fn(() => false),
  startHomebrewUpgrade: vi.fn((_version: string): { ok: boolean; error?: string } => ({ ok: true })),
  takeUpgradeResult: vi.fn((): unknown => null),
  upgradeLogPath: vi.fn(() => '/userData/homebrew-update.log')
}

vi.mock('../homebrew', () => homebrew)

const openPath = vi.fn()

vi.mock('electron', () => ({
  app: electronApp,
  shell: { openPath },
  autoUpdater: squirrel,
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, data: unknown) => sent.push({ channel, data }) } }]
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

vi.mock('electron-updater', () => ({ autoUpdater: updater }))

const realPlatform = process.platform

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

async function initOn(platform: string): Promise<void> {
  setPlatform(platform)
  vi.resetModules()
  const mod = await import('../auto-update')
  mod.initAutoUpdater()
}

function channels(): string[] {
  return sent.map((entry) => entry.channel)
}

function install(): { ok: boolean; error?: string } {
  return handlers.get('update:install')!() as { ok: boolean; error?: string }
}

beforeEach(() => {
  vi.useFakeTimers()
  sent.length = 0
  handlers.clear()
  openPath.mockClear()
  electronApp.quit.mockClear()
  for (const fn of Object.values(homebrew)) fn.mockClear()
  homebrew.isHomebrewManaged.mockReturnValue(false)
  homebrew.startHomebrewUpgrade.mockReturnValue({ ok: true })
  homebrew.takeUpgradeResult.mockReturnValue(null)
  squirrel.removeAllListeners()
  updater.removeAllListeners()
  updater.quitAndInstall.mockClear()
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  electronApp.isPackaged = true
})

afterEach(() => {
  vi.useRealTimers()
  setPlatform(realPlatform)
})

describe('initAutoUpdater on macOS', () => {
  // electron-updater fires update-downloaded before Squirrel has fetched and
  // signature-checked the bundle; quitAndInstall() is a silent no-op until then.
  it('withholds update:downloaded until Squirrel has staged the bundle', async () => {
    await initOn('darwin')

    updater.emit('update-available', { version: '2.0.0' })
    updater.emit('update-downloaded', { version: '2.0.0' })
    expect(channels()).toEqual(['update:available'])

    squirrel.emit('update-downloaded')
    expect(sent.at(-1)).toEqual({ channel: 'update:downloaded', data: { version: '2.0.0', releaseNotes: undefined } })
  })

  it('refuses to install while the bundle is unstaged', async () => {
    await initOn('darwin')
    updater.emit('update-downloaded', { version: '2.0.0' })

    const result = install()

    expect(result).toEqual({ ok: false, error: 'macOS is still preparing the update.' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('re-arms the staging gate for a second update in one run', async () => {
    await initOn('darwin')
    updater.emit('update-downloaded', { version: '2.0.0' })
    squirrel.emit('update-downloaded')
    expect(install().ok).toBe(true)

    updater.emit('update-available', { version: '3.0.0' })
    updater.emit('update-downloaded', { version: '3.0.0' })

    // The 2.0.0 stage says nothing about 3.0.0.
    expect(install().ok).toBe(false)
    expect(channels().filter((c) => c === 'update:downloaded')).toHaveLength(1)
  })

  it('does not let a superseded staging timer fire', async () => {
    await initOn('darwin')
    updater.emit('update-downloaded', { version: '2.0.0' })
    updater.emit('update-available', { version: '3.0.0' })
    updater.emit('update-downloaded', { version: '3.0.0' })
    squirrel.emit('update-downloaded')

    await vi.advanceTimersByTimeAsync(120_000)

    expect(channels()).not.toContain('update:error')
  })

  it('installs once Squirrel has staged the bundle', async () => {
    await initOn('darwin')
    updater.emit('update-downloaded', { version: '2.0.0' })
    squirrel.emit('update-downloaded')

    expect(install()).toEqual({ ok: true })
    expect(updater.quitAndInstall).toHaveBeenCalled()
  })

  // MacUpdater re-emits Squirrel's errors (e.g. a rejected ad-hoc signature) as
  // its own `error`, so one listener covers both — no separate native listener.
  it('reports a staging failure as a prepare error, once', async () => {
    await initOn('darwin')
    updater.emit('update-downloaded', { version: '2.0.0' })

    updater.emit('error', new Error('code failed to satisfy specified code requirement(s)'))

    expect(sent.filter((e) => e.channel === 'update:error')).toEqual([
      {
        channel: 'update:error',
        data: { message: 'code failed to satisfy specified code requirement(s)', phase: 'prepare' }
      }
    ])
  })

  // A failed poll must not be dressed up as a failed install: nothing is pending.
  it('labels a failure with no update in flight as a check error', async () => {
    await initOn('darwin')

    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))

    expect(sent.at(-1)?.data).toMatchObject({ phase: 'check' })
  })

  it('gives up rather than waiting on staging forever', async () => {
    await initOn('darwin')
    updater.emit('update-downloaded', { version: '2.0.0' })

    await vi.advanceTimersByTimeAsync(120_000)

    expect(sent.at(-1)).toMatchObject({ channel: 'update:error', data: { phase: 'prepare' } })
  })

  it('still reports a stage that lands after the timeout', async () => {
    await initOn('darwin')
    updater.emit('update-downloaded', { version: '2.0.0' })
    await vi.advanceTimersByTimeAsync(120_000)

    squirrel.emit('update-downloaded')

    expect(sent.at(-1)?.channel).toBe('update:downloaded')
    expect(install().ok).toBe(true)
  })

  it('reports install failures instead of throwing across IPC', async () => {
    await initOn('darwin')
    updater.emit('update-downloaded', { version: '2.0.0' })
    squirrel.emit('update-downloaded')
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('boom')
    })

    expect(install()).toEqual({ ok: false, error: 'boom' })
  })

  it('explains that unpackaged builds cannot update', async () => {
    electronApp.isPackaged = false
    await initOn('darwin')
    squirrel.emit('update-downloaded')

    expect(install().ok).toBe(false)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('initAutoUpdater on other platforms', () => {
  it('trusts electron-updater directly', async () => {
    await initOn('win32')

    updater.emit('update-downloaded', { version: '2.0.0' })

    expect(sent.at(-1)?.channel).toBe('update:downloaded')
    expect(install()).toEqual({ ok: true })
  })
})

// A cask install is replaced by `brew upgrade`, and electron-updater could not
// replace it anyway: Squirrel rejects the ad-hoc signature. Detection and the
// helper itself live in homebrew.ts — these cover the routing.
describe('initAutoUpdater on a Homebrew install', () => {
  beforeEach(() => {
    homebrew.isHomebrewManaged.mockReturnValue(true)
  })

  it('does not download an update it cannot stage', async () => {
    await initOn('darwin')

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('flags the update so the banner can offer the brew path', async () => {
    await initOn('darwin')

    updater.emit('update-available', { version: '2.0.0' })

    expect(sent.at(-1)).toEqual({
      channel: 'update:available',
      data: { version: '2.0.0', releaseNotes: undefined, managedByHomebrew: true }
    })
  })

  // Quitting is the point: brew cannot replace a bundle whose own process tree is
  // running the upgrade, so the helper waits for us to be gone.
  it('hands the upgrade to the detached helper and quits', async () => {
    await initOn('darwin')
    updater.emit('update-available', { version: '2.0.0' })

    expect(install()).toEqual({ ok: true })

    expect(homebrew.startHomebrewUpgrade).toHaveBeenCalledWith('2.0.0')
    expect(electronApp.quit).toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('stays put when the helper could not be started', async () => {
    homebrew.startHomebrewUpgrade.mockReturnValue({ ok: false, error: 'no brew' })
    await initOn('darwin')
    updater.emit('update-available', { version: '2.0.0' })

    expect(install()).toEqual({ ok: false, error: 'no brew' })
    expect(electronApp.quit).not.toHaveBeenCalled()
  })

  it('refuses to upgrade to nothing', async () => {
    await initOn('darwin')

    expect(install()).toEqual({ ok: false, error: 'No update is pending.' })
    expect(homebrew.startHomebrewUpgrade).not.toHaveBeenCalled()
    expect(electronApp.quit).not.toHaveBeenCalled()
  })

  it('opens the helper log on request', async () => {
    await initOn('darwin')

    await handlers.get('update:open-log')!()

    expect(openPath).toHaveBeenCalledWith('/userData/homebrew-update.log')
  })
})

// The helper runs with no window to talk to, so a failure it recorded on disk is
// reported on the next launch. Without this it would be completely silent.
describe('reporting a failed background upgrade', () => {
  it('raises the failure once a window is up', async () => {
    homebrew.takeUpgradeResult.mockReturnValue({
      ok: false,
      stage: 'upgrade',
      version: '2.0.0',
      detail: 'brew exited with status 17'
    })
    await initOn('darwin')

    await vi.advanceTimersByTimeAsync(5_000)

    expect(sent).toContainEqual({
      channel: 'update:homebrew-failed',
      data: { version: '2.0.0', message: 'brew exited with status 17' }
    })
  })

  it('says something even when the helper left no detail', async () => {
    homebrew.takeUpgradeResult.mockReturnValue({
      ok: false,
      stage: 'wait',
      version: '2.0.0',
      detail: ''
    })
    await initOn('darwin')

    await vi.advanceTimersByTimeAsync(5_000)

    expect(sent.find((e) => e.channel === 'update:homebrew-failed')?.data).toMatchObject({
      message: 'The Homebrew update did not complete.'
    })
  })

  // A success needs no announcement — the version now running is the evidence.
  it('stays quiet about a successful upgrade', async () => {
    homebrew.takeUpgradeResult.mockReturnValue({
      ok: true,
      stage: 'done',
      version: '2.0.0',
      detail: ''
    })
    await initOn('darwin')

    await vi.advanceTimersByTimeAsync(5_000)

    expect(channels()).not.toContain('update:homebrew-failed')
  })

  it('does not look for a result off macOS', async () => {
    await initOn('linux')

    await vi.advanceTimersByTimeAsync(5_000)

    expect(homebrew.takeUpgradeResult).not.toHaveBeenCalled()
  })
})
