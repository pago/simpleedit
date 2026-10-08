import { app, BrowserWindow, dialog, autoUpdater as squirrel, shell } from 'electron'
import { broadcastToWindows } from './window-broadcast'
import { handleInvoke } from './ipc-registry'
import { autoUpdater } from 'electron-updater'
import {
  isHomebrewManaged,
  startHomebrewUpgrade,
  takeUpgradeResult,
  upgradeLogPath
} from './homebrew'
import type { UpdateErrorPhase, UpdateInfo, UpdateInstallResult } from '../shared/ipc-types'

const isMac = process.platform === 'darwin'

// Squirrel fetches the update from electron-updater's local proxy, so staging is
// a localhost copy plus an unzip and a signature check. Nothing in MacUpdater
// bounds it, so this is a heuristic: long enough not to trip a slow machine,
// short enough that a wedged stage doesn't leave the banner waiting forever. A
// late stage still wins — it clears the reported error.
const STAGING_TIMEOUT_MS = 120_000

// SimpleEdit stays open for days, so a check on launch alone can miss a
// release by as long as the app keeps running.
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

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
let downloadAnnounced = false
let stagingTimer: NodeJS.Timeout | undefined
let homebrewManaged = false

function toUpdateInfo(info: { version: string; releaseNotes?: unknown }): UpdateInfo {
  return {
    version: info.version,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    managedByHomebrew: homebrewManaged || undefined
  }
}

function announceDownloaded(info: UpdateInfo): void {
  downloadAnnounced = true
  broadcastToWindows('update:downloaded', info)
}

function reportError(message: string, phase: UpdateErrorPhase): void {
  clearTimeout(stagingTimer)
  console.error(`[AutoUpdate] ${phase} failed:`, message)
  broadcastToWindows('update:error', { message, phase })
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
    downloadAnnounced = false
    pending = toUpdateInfo(info)
    broadcastToWindows('update:available', pending)
  })

  autoUpdater.on('update-downloaded', (info) => {
    clearTimeout(stagingTimer)
    pending = toUpdateInfo(info)
    if (staged) {
      announceDownloaded(pending)
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
      if (pending) announceDownloaded(pending)
    })
  }

  // IPC handlers
  handleInvoke('update:check', () => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.error('[AutoUpdate] Check failed:', err.message)
    })
  })

  handleInvoke('update:open-log', async () => {
    await shell.openPath(upgradeLogPath())
  })

  handleInvoke('update:install', (): UpdateInstallResult => {
    // Hand a Homebrew copy to a detached helper and get out of its way: brew
    // cannot replace a bundle whose own process tree is running the upgrade.
    if (homebrewManaged) {
      if (!pending) return { ok: false, error: 'No update is pending.' }
      const started = startHomebrewUpgrade(pending.version)
      if (!started.ok) return started
      app.quit()
      return { ok: true }
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

  // Check for updates shortly after launch. The delay also gives the first
  // window time to mount its listeners, which is why the report of a failed
  // background upgrade rides along here rather than firing immediately.
  setTimeout(() => {
    reportFailedBackgroundUpgrade()
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.error('[AutoUpdate] Initial check failed:', err.message)
    })
  }, 5_000)

  // Once an update is pending there is nothing new to say, and a repeat
  // `update-available` would reset the macOS staging state the banner waits on.
  setInterval(() => {
    if (pending) return
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.error('[AutoUpdate] Periodic check failed:', err.message)
    })
  }, RECHECK_INTERVAL_MS)
}

function showMessage(options: Electron.MessageBoxOptions): void {
  const parent = BrowserWindow.getFocusedWindow()
  void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
}

/**
 * "Check for Updates…" from the app menu. A found update is announced through
 * the banner like any other; only the outcomes the banner has no way to show
 * (nothing new, or the check failing) get a dialog.
 */
export async function checkForUpdatesFromMenu(): Promise<void> {
  if (pending) {
    // The banner may have been dismissed — announcing again brings it back.
    broadcastToWindows('update:available', pending)
    if (downloadAnnounced) broadcastToWindows('update:downloaded', pending)
    return
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      showMessage({ type: 'info', message: 'Updates are only checked in packaged builds.' })
    } else if (!result.isUpdateAvailable) {
      showMessage({
        type: 'info',
        message: "You're up to date.",
        detail: `SimpleEdit ${app.getVersion()} is the latest version.`
      })
    }
  } catch (err) {
    showMessage({
      type: 'error',
      message: 'Could not check for updates.',
      detail: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * A detached upgrade runs with no window to talk to, so its outcome is left on
 * disk and picked up here on the next launch. Only failures are surfaced — a
 * success speaks for itself, in the form of the version now running.
 */
function reportFailedBackgroundUpgrade(): void {
  if (!isMac) return

  const result = takeUpgradeResult()
  if (!result || result.ok) return

  console.error('[AutoUpdate] Homebrew upgrade failed:', result.stage, result.detail)
  broadcastToWindows('update:homebrew-failed', {
    version: result.version,
    message: result.detail || 'The Homebrew update did not complete.'
  })
}
