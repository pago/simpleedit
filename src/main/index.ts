import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  spawnTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals
} from './pty'
import type { PtySpawnOptions } from '../shared/ipc-types'
import { listDirectory, readFile, writeFile, watchDirectory, unwatchAll } from './file-watcher'
import { listWorktrees, createWorktree, removeWorktree } from './worktree'

let bareRepoPath: string | null = process.env['SIMPLEEDIT_REPO'] ?? null

async function resolveBareRepoPath(): Promise<string> {
  if (bareRepoPath) return bareRepoPath

  const result = await dialog.showOpenDialog({
    title: 'Select bare git repository',
    properties: ['openDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) {
    throw new Error('No repository selected')
  }

  bareRepoPath = result.filePaths[0]
  return bareRepoPath
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'SimpleEdit',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerPtyHandlers(win: BrowserWindow): void {
  ipcMain.handle('pty:spawn', (_event, options: PtySpawnOptions) => {
    spawnTerminal(options, win.webContents)
  })

  ipcMain.handle('pty:write', (_event, id: string, data: string) => {
    writeToTerminal(id, data)
  })

  ipcMain.handle('pty:resize', (_event, id: string, cols: number, rows: number) => {
    resizeTerminal(id, cols, rows)
  })

  ipcMain.handle('pty:kill', (_event, id: string) => {
    killTerminal(id)
  })
}

function registerFsHandlers(): void {
  ipcMain.handle('fs:list', (_event, dirPath: string) => {
    return listDirectory(dirPath)
  })

  ipcMain.handle('fs:read', (_event, filePath: string) => {
    return readFile(filePath)
  })

  ipcMain.handle('fs:write', (_event, filePath: string, content: string) => {
    writeFile(filePath, content)
  })

  ipcMain.handle('fs:watch', (event, worktreePath: string) => {
    const webContents = event.sender
    watchDirectory(worktreePath, webContents)
  })

  ipcMain.handle('fs:unwatch', () => {
    unwatchAll()
  })
}

function registerEditorHandlers(): void {
  ipcMain.handle('editor:open', (_event, filePath: string) => {
    return readFile(filePath)
  })

  ipcMain.handle('editor:save', (_event, filePath: string, content: string) => {
    return writeFile(filePath, content)
  })
}

function registerWorktreeHandlers(): void {
  ipcMain.handle('worktree:list', async () => {
    const repoPath = await resolveBareRepoPath()
    return listWorktrees(repoPath)
  })

  ipcMain.handle('worktree:create', async (_event, name: string, baseBranch?: string) => {
    const repoPath = await resolveBareRepoPath()
    return createWorktree(repoPath, name, baseBranch)
  })

  ipcMain.handle('worktree:remove', async (_event, worktreePath: string) => {
    const repoPath = await resolveBareRepoPath()
    return removeWorktree(repoPath, worktreePath)
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.simpleedit')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const win = createWindow()
  registerPtyHandlers(win)
  registerFsHandlers()
  registerEditorHandlers()
  registerWorktreeHandlers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createWindow()
      registerPtyHandlers(newWin)
    }
  })
})

app.on('window-all-closed', () => {
  killAllTerminals()
  unwatchAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
