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
import { watchWorktreeList, unwatchWorktreeList, unwatchAllWorktreeLists, unwatchAllWorktreeListsForWindow } from './worktree-watcher'
import { watchEditorFile, unwatchEditorFile, unwatchAllEditorFilesForWindow, unwatchAllEditorFiles } from './editor-watcher'
import {
  getCommitLog, getCommitDiff, getCommitFiles, getFileAtCommit,
  getStagingFiles, getStagingDiff, getFileAtHead,
  getBranchDiff, getBranchFiles, getFileAtBranchBase,
  watchGitRefs, unwatchGitRefs, unwatchAllGitRefs, triggerStatusCheck
} from './git-operations'
import { attachToTerminal, detachFromTerminal, detachAll as detachAllStreams } from './claude-stream'
import { getRecentRepos, addRecentRepo } from './recent-repos'
import { startReview, cancelReview, cancelAllReviews } from './review'
import { startScreening, cancelScreening, cancelAllScreening } from './screenprs'
import { startDeepReview, cancelDeepReview, cancelAllDeepReviews } from './deep-review'
import { startTour, cancelTour, cancelAllTours, loadTour, saveOverview } from './tour'
import { startServer, sendToServer, stopServer, stopAllServers } from './lsp-manager'
import { startBridge, stopBridge, stopAllBridges, getBridgeInfo, setWorktreeResolver, setRepoDiscoverer } from './mcp-bridge'
import { resolveBareRepo } from './cwd-tracker'
import { saveDroppedBlob } from './dropped-files'
import { saveSession, loadSession, clearSession } from './session-store'
import {
  isAvailable as isOllamaAvailable,
  pull as pullModel,
  listInstalledModels,
  listRecommendedModels,
  getModelConfig,
  setModelConfig,
  detectHardware,
  CLAUDE_MODELS
} from './models'
import { inheritShellPath } from './shell-path'
import { registerAssetProtocolScheme, installAssetProtocolHandler } from './asset-protocol'
import { initAutoUpdater } from './auto-update'
import type { JsonRpcMessage, SerializedSession, ModelConfig, ClaudeSpawnOptions, ScreenPrsFilters, SubmitReviewRequest, SubmitReviewResult } from '../shared/ipc-types'
import type { PrContext } from '../shared/screenprs'
import { buildReviewPayload } from '../shared/screenprs'
import { postReview } from './github/gh'

// Privileged schemes must be registered before the app is ready.
registerAssetProtocolScheme()

// ── Per-window repo tracking ──────────────────────────────
// The PRIMARY repo per window (title bar, session save/load keying, and the
// fallback for worktree:* calls that omit an explicit repoPath). Single-repo
// behavior routes entirely through this map.
const windowRepoMap = new Map<number, string>()
// Every repo a window has touched (primary + any session pointed at another
// bare repo via an explicit repoPath). Used by the MCP bridge resolver and the
// worktree watcher so multi-repo windows match cwds / validate open_worktree
// across all their repos. Always contains the primary repo.
const windowReposMap = new Map<number, Set<string>>()

function getRepoForSender(webContentsId: number): string | null {
  return windowRepoMap.get(webContentsId) ?? null
}

function getRepoForSenderOrThrow(webContentsId: number): string {
  const repo = windowRepoMap.get(webContentsId)
  if (!repo) throw new Error('No repository set for this window')
  return repo
}

/**
 * Resolve the bare-repo path for a worktree:* call: the explicit `repoPath`
 * arg if the renderer passed one (multi-repo session), else the window's
 * primary repo. Registers any newly-seen repo into the window's repo set so
 * the bridge resolver and watcher cover it.
 */
function resolveWorktreeRepo(webContentsId: number, repoPath?: string): string {
  const resolved = repoPath ?? getRepoForSenderOrThrow(webContentsId)
  registerWindowRepo(webContentsId, resolved)
  return resolved
}

function registerWindowRepo(webContentsId: number, repoPath: string): void {
  let set = windowReposMap.get(webContentsId)
  if (!set) {
    set = new Set<string>()
    windowReposMap.set(webContentsId, set)
  }
  set.add(repoPath)
}

function getReposForSender(webContentsId: number): string[] {
  const set = windowReposMap.get(webContentsId)
  if (set && set.size > 0) return [...set]
  const primary = windowRepoMap.get(webContentsId)
  return primary ? [primary] : []
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
  const repos = getReposForSender(webContentsId)
  if (repos.length === 0) return []
  const lists = await Promise.all(
    repos.map((repo) => listWorktrees(repo).catch(() => []))
  )
  // De-dup by path: a worktree is uniquely identified by its filesystem path,
  // and distinct bare repos never share a worktree directory.
  const seen = new Set<string>()
  return lists.flat().filter((w) => (seen.has(w.path) ? false : (seen.add(w.path), true)))
})

// Fallback for the bridge's hook handler: when a tracked cwd matches none of
// the window's known worktrees, resolve the bare repo it belongs to, register
// it with the window (so future matches and the resolver above cover it), and
// hand back its worktrees for an immediate re-match. This is what lets an agent
// roaming into a never-opened repo still surface on the session's trail.
setRepoDiscoverer(async (webContentsId, cwd) => {
  const repoPath = await resolveBareRepo(cwd)
  if (!repoPath) return null
  registerWindowRepo(webContentsId, repoPath)
  const worktrees = await listWorktrees(repoPath).catch(() => [])
  return { repoPath, worktrees }
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
    registerWindowRepo(webContentsId, repoPath)
    addRecentRepo(repoPath)
    startBridge(webContentsId, win.webContents).catch((err) => {
      console.error('[SimpleEdit] Failed to start MCP bridge:', err)
    })
  }

  win.on('closed', () => {
    stopBridge(webContentsId)
    unwatchAllWorktreeListsForWindow(webContentsId)
    unwatchAllEditorFilesForWindow(webContentsId)
    windowRepoMap.delete(webContentsId)
    windowReposMap.delete(webContentsId)
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

// ── Settings window ───────────────────────────────────────
// A single shared settings window (not per-repo): the model config it edits is
// global. Reuse the existing window when it's already open.
let settingsWindow: BrowserWindow | null = null

function createSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return settingsWindow
  }

  const win = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Settings — SimpleEdit',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      ...(isUnobtrusiveTest ? { backgroundThrottling: false } : {})
    }
  })
  settingsWindow = win

  win.on('closed', () => {
    settingsWindow = null
  })

  win.on('ready-to-show', () => {
    if (isUnobtrusiveTest) {
      win.showInactive()
    } else {
      win.show()
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?view=settings`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { search: 'view=settings' })
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
    registerWindowRepo(event.sender.id, repoPath)
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

  ipcMain.handle('editor:watch', (event, filePath: string) => {
    watchEditorFile(event.sender.id, filePath, event.sender)
  })

  ipcMain.handle('editor:unwatch', (event, filePath: string) => {
    unwatchEditorFile(event.sender.id, filePath)
  })

  // ── Worktrees ───────────────────────────────────────────
  // Every handler takes an OPTIONAL explicit `repoPath`: when present (a
  // session pointed at another bare repo) it targets that repo; when omitted
  // it falls back to the window's primary repo — preserving single-repo
  // behavior byte-for-byte.
  ipcMain.handle('worktree:list', async (event, repoPath?: string) => {
    try {
      const repo = resolveWorktreeRepo(event.sender.id, repoPath)
      return await listWorktrees(repo)
    } catch (err) {
      console.error('[SimpleEdit] worktree:list failed:', err)
      return []
    }
  })

  ipcMain.handle('worktree:create', async (event, name: string, baseBranch?: string, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    return createWorktree(repo, name, baseBranch)
  })

  ipcMain.handle('worktree:checkout', async (event, branch: string, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    return checkoutWorktree(repo, branch)
  })

  ipcMain.handle('worktree:branches', async (event, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    return listAvailableBranches(repo)
  })

  ipcMain.handle('worktree:remove', async (event, worktreePath: string, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    return removeWorktree(repo, worktreePath)
  })

  ipcMain.handle('worktree:watch', (event, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    watchWorktreeList(event.sender.id, repo, event.sender)
  })

  ipcMain.handle('worktree:unwatch', (event, repoPath?: string) => {
    unwatchWorktreeList(event.sender.id, repoPath)
  })

  // ── Claude stream ───────────────────────────────────────
  ipcMain.handle('claude:spawn', (event, options: ClaudeSpawnOptions) => {
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

  // ── Screen PRs ─────────────────────────────────────────
  ipcMain.handle('screenprs:start', (event, filters: ScreenPrsFilters) => {
    return startScreening(filters, event.sender)
  })

  ipcMain.handle('screenprs:cancel', (event) => {
    cancelScreening(event.sender)
  })

  ipcMain.handle('screenprs:deep-start', (event, context: PrContext) => {
    return startDeepReview(context, event.sender)
  })

  ipcMain.handle('screenprs:deep-cancel', (_event, url: string) => {
    cancelDeepReview(url)
  })

  ipcMain.handle('screenprs:submit-review', async (_event, request: SubmitReviewRequest): Promise<SubmitReviewResult> => {
    try {
      const { reviewUrl, foldedComments } = await postReview(request.pr, buildReviewPayload(request.draft))
      return { ok: true, reviewUrl, foldedComments }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
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

  // ── Models (local Ollama + cloud Claude) ────────────────
  ipcMain.handle('models:available', () => {
    return isOllamaAvailable()
  })

  ipcMain.handle('models:claude', () => {
    return CLAUDE_MODELS
  })

  ipcMain.handle('models:hardware', () => {
    return detectHardware()
  })

  ipcMain.handle('models:installed', () => {
    return listInstalledModels()
  })

  ipcMain.handle('models:recommended', () => {
    return listRecommendedModels()
  })

  ipcMain.handle('models:pull', async (event, name: string) => {
    const wc = event.sender
    await pullModel(name, (p) => {
      if (!wc.isDestroyed()) {
        wc.send('models:pull-progress', {
          name,
          status: p.status,
          completed: p.completed,
          total: p.total
        })
      }
    })
  })

  ipcMain.handle('models:config-get', () => {
    return getModelConfig()
  })

  ipcMain.handle('models:config-set', (_event, partial: Partial<ModelConfig>) => {
    return setModelConfig(partial)
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
  initAutoUpdater()

  // Serve worktree-local assets (e.g. images in Markdown previews). Reads are
  // bounded to the directory containing each open window's bare repo, where its
  // worktrees live alongside it.
  installAssetProtocolHandler(() =>
    Array.from(new Set(Array.from(windowRepoMap.values()).map((repo) => dirname(repo)))),
  )

  // ── Application menu ─────────────────────────────────────
  const isMac = process.platform === 'darwin'
  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => createSettingsWindow()
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            settingsItem,
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const }
          ]
        } satisfies Electron.MenuItemConstructorOptions]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow()
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, settingsItem]),
        { type: 'separator' as const },
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
  try { unwatchAllEditorFiles() } catch { /* ignore */ }
  try { cancelAllReviews() } catch { /* ignore */ }
  try { cancelAllTours() } catch { /* ignore */ }
  try { cancelAllScreening() } catch { /* ignore */ }
  try { cancelAllDeepReviews() } catch { /* ignore */ }
  try { stopAllServers() } catch { /* ignore */ }
  try { stopAllBridges() } catch { /* ignore */ }
})

app.on('window-all-closed', () => {
  try { detachAllStreams() } catch { /* ignore */ }
  try { killAllTerminals() } catch { /* ignore */ }
  try { unwatchAllGitRefs() } catch { /* ignore */ }
  try { unwatchAllWorktreeLists() } catch { /* ignore */ }
  try { unwatchAllEditorFiles() } catch { /* ignore */ }
  try { cancelAllReviews() } catch { /* ignore */ }
  try { cancelAllTours() } catch { /* ignore */ }
  try { cancelAllScreening() } catch { /* ignore */ }
  try { cancelAllDeepReviews() } catch { /* ignore */ }
  try { stopAllServers() } catch { /* ignore */ }
  try { stopAllBridges() } catch { /* ignore */ }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
