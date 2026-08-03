import { app, autoUpdater as squirrel, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateErrorPhase, UpdateInfo, UpdateInstallResult } from '../shared/ipc-types'

const isMac = process.platform === 'darwin'

// Squirrel fetches the update from electron-updater's local proxy, so staging is
// a localhost copy plus an unzip and a signature check. Nothing in MacUpdater
// bounds it, so this is a heuristic: long enough not to trip a slow machine,
// short enough that a wedged stage doesn't leave the banner waiting forever. A
// late stage still wins — it clears the reported error.
const STAGING_TIMEOUT_MS = 120_000

// On macOS, electron-updater dispatches `update-downloaded` the moment its proxy
// server starts listening (MacUpdater.dispatchUpdateDownloaded, before it asks
// Squirrel to fetch), so at that point Squirrel has neither fetched nor
// signature-checked the bundle. `quitAndInstall()` before Squirrel has staged it
// only registers a listener and waits — and the signature check fails for
// ad-hoc signed builds (`mac.identity: null` in electron-builder.yml), in which
// case the wait never ends. So on macOS the banner may only offer a restart once
// Squirrel reports the bundle staged. Other platforms don't use Squirrel.
let staged = !isMac
let pending: UpdateInfo | null = null
let stagingTimer: NodeJS.Timeout | undefined

function broadcastToAllWindows(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data)
  }
}

function toUpdateInfo(info: { version: string; releaseNotes?: unknown }): UpdateInfo {
  return {
    version: info.version,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
  }
}

function reportError(message: string, phase: UpdateErrorPhase): void {
  clearTimeout(stagingTimer)
  console.error(`[AutoUpdate] ${phase} failed:`, message)
  broadcastToAllWindows('update:error', { message, phase })
}

export function initAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    // A fresh cycle: the previously staged bundle says nothing about this one.
    clearTimeout(stagingTimer)
    staged = !isMac
    pending = toUpdateInfo(info)
    broadcastToAllWindows('update:available', pending)
  })

  autoUpdater.on('update-downloaded', (info) => {
    clearTimeout(stagingTimer)
    pending = toUpdateInfo(info)
    if (staged) {
      broadcastToAllWindows('update:downloaded', pending)
      return
    }
    stagingTimer = setTimeout(() => {
      reportError('macOS is still preparing the update.', 'prepare')
    }, STAGING_TIMEOUT_MS)
  })

  // Covers check, download and (via MacUpdater's re-emit of Squirrel's own
  // errors) staging failures.
  autoUpdater.on('error', (err) => {
    reportError(err.message, pending === null ? 'check' : staged ? 'install' : 'prepare')
  })

  if (isMac) {
    squirrel.on('update-downloaded', () => {
      staged = true
      clearTimeout(stagingTimer)
      if (pending) broadcastToAllWindows('update:downloaded', pending)
    })
  }

  // IPC handlers
  ipcMain.handle('update:check', () => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.error('[AutoUpdate] Check failed:', err.message)
    })
  })

  ipcMain.handle('update:install', (): UpdateInstallResult => {
    if (!app.isPackaged) {
      return { ok: false, error: 'Updates can only be installed from a packaged build.' }
    }
    if (!staged) {
      return { ok: false, error: 'macOS is still preparing the update.' }
    }
    try {
      autoUpdater.quitAndInstall()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AutoUpdate] Install failed:', message)
      return { ok: false, error: message }
    }
  })

  // Check for updates shortly after launch
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.error('[AutoUpdate] Initial check failed:', err.message)
    })
  }, 5_000)
}
