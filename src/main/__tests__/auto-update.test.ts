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
const electronApp = { isPackaged: true }

vi.mock('electron', () => ({
  app: electronApp,
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
  squirrel.removeAllListeners()
  updater.removeAllListeners()
  updater.quitAndInstall.mockClear()
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
