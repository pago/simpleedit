import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { join, basename, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  spawnTerminal,
  spawnClaudeTerminal,
  spawnAgentsTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  getActiveTerminalIds,
  getTerminalBacklog
} from './pty'
import type { PtySpawnOptions } from '../shared/ipc-types'
import {
  listDirectory, listAllFiles, readFile, writeFile,
  createFile, createDirectory, renamePath, deletePath,
} from './file-watcher'
import { listWorktrees, createWorktree, checkoutWorktree, listAvailableBranches, removeWorktree, cloneBareRepo } from './worktree'
import { watchWorktreeList, unwatchWorktreeList, unwatchAllWorktreeLists } from './worktree-watcher'
import {
  getCommitLog, getCommitDiff, getCommitFiles, getFileAtCommit,
  getStagingFiles, getStagingDiff, getFileAtHead,
  getBranchDiff, getBranchFiles, getFileAtBranchBase,
  watchGitRefs, unwatchGitRefs, unwatchAllGitRefs, triggerStatusCheck
} from './git-operations'
import { attachToTerminal, detachFromTerminal, detachAll as detachAllStreams } from './claude-stream'
import { performFork } from './claude-fork'
import { getRecentRepos, addRecentRepo } from './recent-repos'
import { startReview, cancelReview, cancelAllReviews } from './review'
import { startTour, cancelTour, cancelAllTours, loadTour, saveOverview } from './tour'
import { startPlan, startPlanFromDescription, revisePlan, cancelPlan, cancelAllPlans, loadPlan, savePlan } from './plan'
import { startServer, sendToServer, stopServer, stopAllServers } from './lsp-manager'
import { startBridge, stopBridge, stopAllBridges, getBridgeInfo, loadLatestClaudePlan, setWorktreeResolver } from './mcp-bridge'
import { saveDroppedBlob } from './dropped-files'
import { saveSession, loadSession, clearSession } from './session-store'
import { inheritShellPath } from './shell-path'
import type { JsonRpcMessage, SerializedSession } from '../shared/ipc-types'

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

// Let the MCP bridge resolve a window's worktree list (for hook cwd→worktree
// matching and open_worktree/show_diff validation) without exposing the
// per-window repo map. Registered once at module load.
setWorktreeResolver(async (webContentsId) => {
  const repoPath = getRepoForSender(webContentsId)
  if (!repoPath) return []
  return listWorktrees(repoPath)
})

// ── Window creation ───────────────────────────────────────
/**
 * E2E runs set SIMPLEEDIT_E2E=1 so test windows never steal focus from the
 * engineer's foreground app: the window is shown inactive, and (on macOS)
 * the app runs with the 'accessory' activation policy — no Dock icon, no
 * activation on launch. True headless isn't an option: Electron has no
 * headless mode and a hidden window pauses requestAnimationFrame, which the
 * terminal's fit/scroll logic depends on. backgroundThrottling is disabled
 * so rAF keeps running even when the inactive window ends up occluded.
 */
const isUnobtrusiveTest = process.env['SIMPLEEDIT_E2E'] === '1'

function createWindow(repoPath?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: repoPath
      ? `SimpleEdit — ${basename(repoPath).replace('.git', '')}`
      : 'SimpleEdit',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      ...(isUnobtrusiveTest ? { backgroundThrottling: false } : {})
    }
  })

  const webContentsId = win.webContents.id

  if (repoPath) {
    windowRepoMap.set(webContentsId, repoPath)
    addRecentRepo(repoPath)
    startBridge(webContentsId, win.webContents).catch((err) => {
      console.error('[SimpleEdit] Failed to start MCP bridge:', err)
    })
  }

  win.on('closed', () => {
    stopBridge(webContentsId)
    unwatchWorktreeList(webContentsId)
    windowRepoMap.delete(webContentsId)
  })

  win.on('ready-to-show', () => {
    if (isUnobtrusiveTest) {
      win.showInactive()
    } else {
      win.show()
    }
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
    startBridge(event.sender.id, event.sender).catch((err) => {
      console.error('[SimpleEdit] Failed to start MCP bridge:', err)
    })
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

  ipcMain.handle('app:save-dropped-blob', (_event, filename: string, bytes: Uint8Array) => {
    return saveDroppedBlob(filename, bytes)
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

  ipcMain.handle('pty:backlog', (_event, id: string) => {
    return getTerminalBacklog(id)
  })

  // ── File system ─────────────────────────────────────────
  ipcMain.handle('fs:list', (_event, dirPath: string) => {
    return listDirectory(dirPath)
  })

  ipcMain.handle('fs:list-all', (_event, worktreePath: string) => {
    return listAllFiles(worktreePath)
  })

  ipcMain.handle('fs:read', (_event, filePath: string) => {
    return readFile(filePath)
  })

  ipcMain.handle('fs:write', (_event, filePath: string, content: string) => {
    writeFile(filePath, content)
  })

  ipcMain.handle('fs:create-file', (_event, filePath: string) => {
    createFile(filePath)
  })

  ipcMain.handle('fs:create-dir', (_event, dirPath: string) => {
    createDirectory(dirPath)
  })

  ipcMain.handle('fs:rename', (_event, oldPath: string, newPath: string) => {
    renamePath(oldPath, newPath)
  })

  ipcMain.handle('fs:delete', async (_event, filePath: string) => {
    await deletePath(filePath)
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

  ipcMain.handle('worktree:watch', (event) => {
    const repoPath = getRepoForSenderOrThrow(event.sender.id)
    watchWorktreeList(event.sender.id, repoPath, event.sender)
  })

  ipcMain.handle('worktree:unwatch', (event) => {
    unwatchWorktreeList(event.sender.id)
  })

  // ── Claude stream ───────────────────────────────────────
  ipcMain.handle('claude:spawn', (event, options: PtySpawnOptions) => {
    const bridge = getBridgeInfo(event.sender.id)
    spawnClaudeTerminal(
      {
        ...options,
        ...(bridge ? { bridgePort: bridge.port, bridgeToken: bridge.token } : {})
      },
      event.sender
    )
    attachToTerminal(options.id, options.worktreePath, event.sender)
  })

  ipcMain.handle('claude:spawn-agents', (event, options: PtySpawnOptions) => {
    spawnAgentsTerminal(options, event.sender)
  })

  ipcMain.handle('claude:attach', (event, terminalId: string, worktreePath: string) => {
    attachToTerminal(terminalId, worktreePath, event.sender)
  })

  ipcMain.handle('claude:detach', (_event, terminalId: string) => {
    detachFromTerminal(terminalId)
  })

  ipcMain.handle('claude:fork', async (event, options) => {
    await performFork(options, event.sender)
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

  // ── Plan ────────────────────────────────────────────────
  ipcMain.handle('plan:start', (event, worktreePath: string, commitHash: string | null) => {
    return startPlan(worktreePath, commitHash, event.sender)
  })

  ipcMain.handle('plan:start-from-description', (event, worktreePath: string, description: string) => {
    return startPlanFromDescription(worktreePath, description, event.sender)
  })

  ipcMain.handle('plan:cancel', (_event, worktreePath: string, commitHash: string | null) => {
    cancelPlan(worktreePath, commitHash)
  })

  ipcMain.handle('plan:load', (_event, worktreePath: string, commitHash: string | null) => {
    return loadPlan(worktreePath, commitHash)
  })

  ipcMain.handle('plan:save', (_event, worktreePath: string, commitHash: string | null, plan: unknown) => {
    savePlan(worktreePath, commitHash, plan as import('../shared/ipc-types').Plan)
  })

  ipcMain.handle('plan:revise', (event, worktreePath: string, commitHash: string | null, feedback: string) => {
    return revisePlan(worktreePath, commitHash, feedback, event.sender)
  })

  ipcMain.handle('plan:latest-claude', (_event, worktreePath: string) => {
    return loadLatestClaudePlan(worktreePath)
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

  // ── Session save/restore ────────────────────────────────
  ipcMain.handle('session:save', (_event, payload: SerializedSession) => {
    try {
      saveSession(payload)
    } catch (err) {
      console.error('[SimpleEdit] session:save failed:', err)
    }
  })

  ipcMain.handle('session:load', (_event, repoPath: string) => {
    return loadSession(repoPath)
  })

  ipcMain.handle('session:clear', (_event, repoPath: string) => {
    clearSession(repoPath)
  })
}

// ── App lifecycle ─────────────────────────────────────────

app.whenReady().then(() => {
  inheritShellPath()
  electronApp.setAppUserModelId('com.simpleedit')

  if (isUnobtrusiveTest && process.platform === 'darwin') {
    // Accessory apps never activate on launch and have no Dock presence —
    // E2E windows render without yanking focus from whatever the engineer
    // is doing.
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  }

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
  try { unwatchAllWorktreeLists() } catch { /* ignore */ }
  try { cancelAllReviews() } catch { /* ignore */ }
  try { cancelAllTours() } catch { /* ignore */ }
  try { cancelAllPlans() } catch { /* ignore */ }
  try { stopAllServers() } catch { /* ignore */ }
  try { stopAllBridges() } catch { /* ignore */ }
})

app.on('window-all-closed', () => {
  try { detachAllStreams() } catch { /* ignore */ }
  try { killAllTerminals() } catch { /* ignore */ }
  try { unwatchAllGitRefs() } catch { /* ignore */ }
  try { unwatchAllWorktreeLists() } catch { /* ignore */ }
  try { cancelAllReviews() } catch { /* ignore */ }
  try { cancelAllTours() } catch { /* ignore */ }
  try { cancelAllPlans() } catch { /* ignore */ }
  try { stopAllServers() } catch { /* ignore */ }
  try { stopAllBridges() } catch { /* ignore */ }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
