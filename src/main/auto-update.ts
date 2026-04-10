import { BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from '../shared/ipc-types'

function broadcastToAllWindows(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data)
  }
}

export function initAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    const payload: UpdateInfo = {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : undefined
    }
    broadcastToAllWindows('update:available', payload)
  })

  autoUpdater.on('update-downloaded', (info) => {
    const payload: UpdateInfo = {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : undefined
    }
    broadcastToAllWindows('update:downloaded', payload)
  })

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdate] Error:', err.message)
    broadcastToAllWindows('update:error', { message: err.message })
  })

  // IPC handlers
  ipcMain.handle('update:check', () => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.error('[AutoUpdate] Check failed:', err.message)
    })
  })

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  // Check for updates shortly after launch
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.error('[AutoUpdate] Initial check failed:', err.message)
    })
  }, 5_000)
}
