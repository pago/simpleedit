import { app, autoUpdater as squirrel, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { BREW_UPGRADE_COMMAND } from '../shared/ipc-types'
import type { UpdateErrorPhase, UpdateInfo, UpdateInstallResult } from '../shared/ipc-types'

const isMac = process.platform === 'darwin'

// Homebrew's two standard prefixes — Apple silicon and Intel.
const CASKROOM_DIRS = ['/opt/homebrew/Caskroom/simpleedit', '/usr/local/Caskroom/simpleedit']

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
let homebrewManaged = false

/**
 * Whether `brew` owns this copy of the app.
 *
 * A cask install moves SimpleEdit.app into /Applications but leaves a
 * `Caskroom/simpleedit/<version>` directory behind, so a directory matching the
 * running version is the cheapest reliable signal — no shelling out to `brew`,
 * which isn't on the app's PATH when it launches from Finder. Matching on the
 * version rather than the bare cask directory also means a copy the user later
 * replaced by hand stops counting as Homebrew-managed.
 *
 * The `isPackaged` guard matters beyond correctness: without it, a developer who
 * has the cask installed at the version in package.json would see `pnpm dev` and
 * the e2e suite take the Homebrew path.
 */
function isHomebrewManaged(): boolean {
  if (!isMac || !app.isPackaged) return false
  return CASKROOM_DIRS.some((dir) => existsSync(join(dir, app.getVersion())))
}

function broadcastToAllWindows(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data)
  }
}

function toUpdateInfo(info: { version: string; releaseNotes?: unknown }): UpdateInfo {
  return {
    version: info.version,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    managedByHomebrew: homebrewManaged || undefined
  }
}

function reportError(message: string, phase: UpdateErrorPhase): void {
  clearTimeout(stagingTimer)
  console.error(`[AutoUpdate] ${phase} failed:`, message)
  broadcastToAllWindows('update:error', { message, phase })
}

export function initAutoUpdater(): void {
  // A Homebrew copy is upgraded with `brew upgrade --cask`, so downloading a
  // bundle Squirrel will refuse to stage only burns bandwidth. We still check,
  // so the banner can say a new version exists.
  homebrewManaged = isHomebrewManaged()
  autoUpdater.autoDownload = !homebrewManaged
  autoUpdater.autoInstallOnAppQuit = !homebrewManaged

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
    if (homebrewManaged) {
      return { ok: false, error: `Run \`${BREW_UPGRADE_COMMAND}\` to update this copy.` }
    }
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
