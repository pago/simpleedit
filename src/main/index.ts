import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { join, basename, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  spawnTerminal,
  spawnClaudeTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  getActiveTerminalIds
} from './pty'
import type { PtySpawnOptions } from '../shared/ipc-types'
import { listDirectory, readFile, writeFile } from './file-watcher'
import { listWorktrees, createWorktree, checkoutWorktree, listAvailableBranches, removeWorktree, cloneBareRepo } from './worktree'
import {
  getCommitLog, getCommitDiff, getCommitFiles, getFileAtCommit,
  getStagingFiles, getStagingDiff, getFileAtHead,
  getBranchDiff, getBranchFiles, getFileAtBranchBase,
  watchGitRefs, unwatchGitRefs, unwatchAllGitRefs, triggerStatusCheck
} from './git-operations'
import { attachToTerminal, detachFromTerminal, detachAll as detachAllStreams } from './claude-stream'
import { getRecentRepos, addRecentRepo } from './recent-repos'
import { startReview, cancelReview, cancelAllReviews } from './review'
import { startTour, cancelTour, cancelAllTours, loadTour, saveOverview } from './tour'
import { startServer, sendToServer, stopServer, stopAllServers } from './lsp-manager'
import type { JsonRpcMessage } from '../shared/ipc-types'

// ── Per-window repo tracking ──────────────────────────────
const windowRepoMap = new Map<number, string>()

function getRepoForSender(webContentsId: number): string | null {
  return windowRepoMap.get(webContentsId) ?? null
}

function getRepoForSenderOrThrow(webContentsId: number): string {
  const repo = windowRepoMap.get(webContentsId)
  if (!repo) throw new Error('No repository set for this window')
  return repo
}

function getWindowForContents(webContentsId: number): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find(
    (w) => w.webContents.id === webContentsId
  ) ?? null
}

// ── Window creation ───────────────────────────────────────
function createWindow(repoPath?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: repoPath
      ? `SimpleEdit — ${basename(repoPath).replace('.git', '')}`
      : 'SimpleEdit',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  const webContentsId = win.webContents.id

  if (repoPath) {
    windowRepoMap.set(webContentsId, repoPath)
    addRecentRepo(repoPath)
  }

  win.on('closed', () => {
    windowRepoMap.delete(webContentsId)
  })

  win.on('ready-to-show', () => {
    win.show()
    // Set peek/reference zone widget font to match the editor (13px).
    // insertCSS creates a user stylesheet which overrides Monaco's author styles.
    win.webContents.insertCSS(
      '.monaco-editor .zone-widget { font-size: 13px !important; }'
    ).catch(() => { /* non-critical */ })
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

// ── IPC registration (global, routes per sender) ──────────

function registerAllHandlers(): void {
  // ── App ─────────────────────────────────────────────────
  ipcMain.handle('app:get-repo', (event) => {
    return getRepoForSender(event.sender.id)
  })

  ipcMain.handle('app:set-repo', (event, repoPath: string) => {
    windowRepoMap.set(event.sender.id, repoPath)
    addRecentRepo(repoPath)
    const win = getWindowForContents(event.sender.id)
    if (win) {
      win.setTitle(`SimpleEdit — ${basename(repoPath).replace('.git', '')}`)
    }
  })

  ipcMain.handle('app:pick-repo', async (event) => {
    const win = getWindowForContents(event.sender.id)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Select bare git repository',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('app:pick-directory', async (event) => {
    const win = getWindowForContents(event.sender.id)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Select destination directory',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('app:clone-repo', async (_event, repoUrl: string, parentDir: string) => {
    return cloneBareRepo(repoUrl, parentDir)
  })

  ipcMain.handle('app:recent-repos', () => {
    return getRecentRepos()
  })

  ipcMain.handle('app:open-window', (_event, repoPath?: string) => {
    createWindow(repoPath)
  })

  ipcMain.handle('app:open-external', (_event, url: string) => {
    shell.openExternal(url)
  })

  // ── PTY ─────────────────────────────────────────────────
  ipcMain.handle('pty:spawn', (event, options: PtySpawnOptions) => {
    spawnTerminal(options, event.sender)
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

  ipcMain.handle('pty:active-ids', () => {
    return getActiveTerminalIds()
  })

  // ── File system ─────────────────────────────────────────
  ipcMain.handle('fs:list', (_event, dirPath: string) => {
    return listDirectory(dirPath)
  })

  ipcMain.handle('fs:read', (_event, filePath: string) => {
    return readFile(filePath)
  })

  ipcMain.handle('fs:write', (_event, filePath: string, content: string) => {
    writeFile(filePath, content)
  })

  // ── Editor ──────────────────────────────────────────────
  ipcMain.handle('editor:open', (_event, filePath: string) => {
    return readFile(filePath)
  })

  ipcMain.handle('editor:save', (_event, filePath: string, content: string) => {
    return writeFile(filePath, content)
  })

  // ── Worktrees ───────────────────────────────────────────
  ipcMain.handle('worktree:list', async (event) => {
    try {
      const repoPath = getRepoForSenderOrThrow(event.sender.id)
      return await listWorktrees(repoPath)
    } catch (err) {
      console.error('[SimpleEdit] worktree:list failed:', err)
      return []
    }
  })

  ipcMain.handle('worktree:create', async (event, name: string, baseBranch?: string) => {
    const repoPath = getRepoForSenderOrThrow(event.sender.id)
    return createWorktree(repoPath, name, baseBranch)
  })

  ipcMain.handle('worktree:checkout', async (event, branch: string) => {
    const repoPath = getRepoForSenderOrThrow(event.sender.id)
    return checkoutWorktree(repoPath, branch)
  })

  ipcMain.handle('worktree:branches', async (event) => {
    const repoPath = getRepoForSenderOrThrow(event.sender.id)
    return listAvailableBranches(repoPath)
  })

  ipcMain.handle('worktree:remove', async (event, worktreePath: string) => {
    const repoPath = getRepoForSenderOrThrow(event.sender.id)
    return removeWorktree(repoPath, worktreePath)
  })

  // ── Claude stream ───────────────────────────────────────
  ipcMain.handle('claude:spawn', (event, options: PtySpawnOptions) => {
    spawnClaudeTerminal(options, event.sender)
    attachToTerminal(options.id, options.worktreePath, event.sender)
  })

  ipcMain.handle('claude:attach', (event, terminalId: string, worktreePath: string) => {
    attachToTerminal(terminalId, worktreePath, event.sender)
  })

  ipcMain.handle('claude:detach', (_event, terminalId: string) => {
    detachFromTerminal(terminalId)
  })

  // ── Git ─────────────────────────────────────────────────
  ipcMain.handle('git:log', (_event, worktreePath: string, count?: number) => {
    return getCommitLog(worktreePath, count)
  })

  ipcMain.handle('git:diff', (_event, worktreePath: string, commitHash: string) => {
    return getCommitDiff(worktreePath, commitHash)
  })

  ipcMain.handle('git:commit-files', (_event, worktreePath: string, commitHash: string) => {
    return getCommitFiles(worktreePath, commitHash)
  })

  ipcMain.handle('git:file-at-commit', (_event, worktreePath: string, commitHash: string, filePath: string) => {
    return getFileAtCommit(worktreePath, commitHash, filePath)
  })

  ipcMain.handle('git:staging-files', (_event, worktreePath: string) => {
    return getStagingFiles(worktreePath)
  })

  ipcMain.handle('git:staging-diff', (_event, worktreePath: string) => {
    return getStagingDiff(worktreePath)
  })

  ipcMain.handle('git:file-at-head', (_event, worktreePath: string, filePath: string) => {
    return getFileAtHead(worktreePath, filePath)
  })

  ipcMain.handle('git:watch', (event, worktreePath: string) => {
    return watchGitRefs(worktreePath, event.sender)
  })

  ipcMain.handle('git:unwatch', (_event, worktreePath: string) => {
    unwatchGitRefs(worktreePath)
  })

  ipcMain.handle('git:branch-diff', (_event, worktreePath: string) => {
    return getBranchDiff(worktreePath)
  })

  ipcMain.handle('git:branch-files', (_event, worktreePath: string) => {
    return getBranchFiles(worktreePath)
  })

  ipcMain.handle('git:file-at-branch-base', (_event, worktreePath: string, filePath: string) => {
    return getFileAtBranchBase(worktreePath, filePath)
  })

  // ── Review ──────────────────────────────────────────────
  ipcMain.handle('review:start', (event, worktreePath: string, commitHash: string | null) => {
    return startReview(worktreePath, commitHash, event.sender)
  })

  ipcMain.handle('review:cancel', (_event, worktreePath: string, commitHash: string | null) => {
    cancelReview(worktreePath, commitHash)
  })

  // ── Tour ───────────────────────────────────────────────
  ipcMain.handle('tour:start', (event, worktreePath: string, commitHash: string | null, overrideOverview?: string) => {
    return startTour(worktreePath, commitHash, event.sender, overrideOverview)
  })

  ipcMain.handle('tour:cancel', (_event, worktreePath: string, commitHash: string | null) => {
    cancelTour(worktreePath, commitHash)
  })

  ipcMain.handle('tour:load', (_event, worktreePath: string, commitHash: string | null) => {
    return loadTour(worktreePath, commitHash)
  })

  ipcMain.handle('tour:save-overview', (_event, worktreePath: string, commitHash: string | null, overview: string) => {
    saveOverview(worktreePath, commitHash, overview)
  })

  // ── LSP ─────────────────────────────────────────────────
  ipcMain.handle('lsp:start', (event, { language, rootUri }: { language: string; rootUri: string }) => {
    try {
      return startServer(language, rootUri, event.sender)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn('[LSP] Server unavailable:', reason)
      return { serverId: null, reason }
    }
  })

  ipcMain.handle('lsp:stop', (_event, { serverId }: { serverId: string }) => {
    stopServer(serverId)
  })

  ipcMain.on('lsp:send', (_event, { serverId, message }: { serverId: string; message: JsonRpcMessage }) => {
    sendToServer(serverId, message)
  })
}

// ── App lifecycle ─────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.simpleedit')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerAllHandlers()

  // ── Application menu ─────────────────────────────────────
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow()
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // Open with env var, or show welcome screen
  const envRepo = process.env['SIMPLEEDIT_REPO'] ?? null
  createWindow(envRepo ?? undefined)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  try { detachAllStreams() } catch { /* ignore */ }
  try { killAllTerminals() } catch { /* ignore */ }
  try { unwatchAllGitRefs() } catch { /* ignore */ }
  try { cancelAllReviews() } catch { /* ignore */ }
  try { cancelAllTours() } catch { /* ignore */ }
  try { stopAllServers() } catch { /* ignore */ }
})

app.on('window-all-closed', () => {
  try { detachAllStreams() } catch { /* ignore */ }
  try { killAllTerminals() } catch { /* ignore */ }
  try { unwatchAllGitRefs() } catch { /* ignore */ }
  try { cancelAllReviews() } catch { /* ignore */ }
  try { cancelAllTours() } catch { /* ignore */ }
  try { stopAllServers() } catch { /* ignore */ }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
