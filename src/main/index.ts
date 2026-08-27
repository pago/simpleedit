import { app, BrowserWindow, dialog, shell, Menu } from 'electron'
import { join, basename, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  spawnTerminal,
  spawnAgentTerminalForProvider,
  reportSpawnFailure,
  spawnAgentsTerminal,
  writeToTerminal,
  resizeTerminal,
  claimTerminal,
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
  watchGitRefs, unwatchGitRefs, unwatchAllGitRefs
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
import { ClientHub, type RemoteClient } from './client-hub'
import { handleInvoke, handleSend } from './ipc-registry'
import { startRemoteServer, stopRemoteServer, getRemoteStatus, closeSocketsForHub } from './remote/server'
import { getRemoteConfig, setRemoteConfig } from './remote/config'
import { listRemoteInterfaces, isAllowedBindHost } from './remote/interfaces'
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
  listClaudeModels,
  cancelClaudeDiscovery
} from './models'
import { inheritShellPath } from './shell-path'
import { registerAssetProtocolScheme, installAssetProtocolHandler } from './asset-protocol'
import { initAutoUpdater } from './auto-update'
import type { JsonRpcMessage, SerializedSession, ModelConfig, AgentSpawnOptions, AgentProviderId, ScreenPrsFilters, SubmitReviewRequest, SubmitReviewResult, AgentPeer, PtyClientId, RemoteAccessStatus } from '../shared/ipc-types'
import { syncPeers, resolveSpawn } from './agent-bus'
import { getProvider, registeredProviderIds } from './agents/provider'
import { isExecutableAvailable } from './lib/shell-path'
import { listCodexModels, cancelCodexDiscovery } from './models/codex-catalog'
import { getOpenCodeModels, cancelOpenCodeDiscovery } from './models/opencode-catalog'
import type { PrContext } from '../shared/screenprs'
import { buildReviewPayload } from '../shared/screenprs'
import { postReview } from './github/gh'

// Privileged schemes must be registered before the app is ready.
registerAssetProtocolScheme()

/**
 * Never let a stray rejection kill the app.
 *
 * Node's default is to exit, and exiting here means `before-quit` does not
 * run — so `killAllTerminals` does not run, and every agent PTY is orphaned
 * with its work in progress. That was always a bad trade; it became an
 * unacceptable one when the remote transport made every IPC handler reachable
 * by a caller we do not control. Logged loudly so it is still a bug to fix,
 * not a failure mode to live with.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[SimpleEdit] Unhandled promise rejection in main:', reason)
})

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

// ── Client identity ───────────────────────────────────────
// One hub per window, keyed by that window's own `webContents.id` — the same
// key the repo maps, watchers and MCP bridge use. Handlers hand modules the
// hub rather than the raw sender, so an additional transport can later join
// this identity without every event-pushing module learning about fan-out.
const clientHubs = new Map<number, ClientHub>()

/**
 * The calling transport's own `PtyClientId`. Distinct from the hub id: a
 * window and the phone attached to it share one hub, and size ownership is
 * precisely what they must be able to take from each other. Remote sockets
 * carry a `w`-prefixed key, so the two spaces cannot collide.
 */
function clientKeyOf(sender: RemoteClient): PtyClientId {
  return sender.clientKey ?? String(sender.id)
}

/**
 * The hub for `sender`'s window, creating it if this is the first call.
 *
 * Refuses to resurrect one. A remote socket can outlive the window it joined,
 * and its next call arrives naming a destroyed window id — minting a fresh hub
 * for it would revive everything keyed by that id behind the teardown that
 * already ran: an MCP bridge nothing will stop, watchers installed after the
 * unwatch, a repo map entry for a window that is gone.
 */
function hubFor(sender: RemoteClient): ClientHub {
  const existing = clientHubs.get(sender.id)
  if (existing) return existing
  if (sender.isDestroyed()) {
    throw new Error(`Window ${sender.id} is gone`)
  }
  const hub = new ClientHub(sender.id, sender)
  clientHubs.set(sender.id, hub)
  return hub
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

// ── Remote access ─────────────────────────────────────────
// One server for the whole app, off unless the user turns it on. A connecting
// browser JOINS a window's hub rather than minting an identity of its own —
// see remote/server.ts for why, and for the security rules that surface obeys.

/** Where the built web bundle lives, beside the renderer's own output. */
function remoteWebRoot(): string {
  return join(__dirname, '../web')
}

/**
 * The window a new socket attaches to: the focused one if it has a repo, else
 * the first window that does, else the first window at all.
 *
 * Deliberately not "a window of its own". Everything main knows about a
 * session — its repo, its worktrees, its MCP bridge, its watchers — is keyed
 * by a window id, so the phone has to borrow one.
 */
function remoteAttachTarget(): ClientHub | null {
  const withRepo = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && windowRepoMap.has(w.webContents.id),
  )
  const focused = BrowserWindow.getFocusedWindow()
  const chosen =
    (focused && withRepo.includes(focused) ? focused : undefined) ??
    withRepo[0] ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!chosen) return null
  return hubFor(chosen.webContents)
}

/**
 * Status goes to EVERY window, not the sender's hub: the pane that shows it
 * lives in the settings window, while the events that change it (a phone
 * connecting) arrive on a different one entirely.
 */
function broadcastRemoteStatus(status: RemoteAccessStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('remote:status-changed', status)
  }
}

/**
 * Serialised. Two `remote:set-*` calls landing together would otherwise each
 * stop and each start, and the second could join the first's in-flight start
 * and silently inherit its host.
 */
let remoteApply: Promise<RemoteAccessStatus> = Promise.resolve(getRemoteStatus())

function applyRemoteConfig(): Promise<RemoteAccessStatus> {
  remoteApply = remoteApply.then(applyRemoteConfigNow, applyRemoteConfigNow)
  return remoteApply
}

async function applyRemoteConfigNow(): Promise<RemoteAccessStatus> {
  const config = getRemoteConfig()
  stopRemoteServer()
  if (!config.enabled) return getRemoteStatus()
  // The stored preference is kept verbatim, so this is where a host that is no
  // longer bindable — a Tailscale address with Tailscale down — is caught. It
  // fails closed and SAYS so, rather than quietly binding somewhere else.
  if (!isAllowedBindHost(config.host)) {
    return remoteBindRefused(config.host)
  }
  return await startRemoteServer({
    host: config.host,
    port: config.port,
    webRoot: remoteWebRoot(),
    attachTarget: remoteAttachTarget,
    onStatusChange: broadcastRemoteStatus,
  })
}

function remoteBindRefused(host: string): RemoteAccessStatus {
  return {
    ...getRemoteStatus(),
    error: `${host} is not available right now. If it is your Tailscale address, Tailscale may be down; pick an address below to change it.`,
  }
}

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
  const hub = new ClientHub(webContentsId, win.webContents)
  clientHubs.set(webContentsId, hub)

  if (repoPath) {
    windowRepoMap.set(webContentsId, repoPath)
    registerWindowRepo(webContentsId, repoPath)
    addRecentRepo(repoPath)
    startBridge(webContentsId, hub).catch((err) => {
      console.error('[SimpleEdit] Failed to start MCP bridge:', err)
    })
  }

  win.on('closed', () => {
    // First: a socket that joined this window must not survive it. Left open,
    // its next invoke would name a destroyed window id and rebuild everything
    // the teardown below is about to take apart.
    closeSocketsForHub(webContentsId)
    stopBridge(webContentsId)
    unwatchAllWorktreeListsForWindow(webContentsId)
    unwatchAllEditorFilesForWindow(webContentsId)
    windowRepoMap.delete(webContentsId)
    windowReposMap.delete(webContentsId)
    clientHubs.delete(webContentsId)
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
  handleInvoke('app:get-repo', (event) => {
    return getRepoForSender(event.sender.id)
  })

  handleInvoke('app:set-repo', (event, repoPath: string) => {
    windowRepoMap.set(event.sender.id, repoPath)
    registerWindowRepo(event.sender.id, repoPath)
    addRecentRepo(repoPath)
    const win = getWindowForContents(event.sender.id)
    if (win) {
      win.setTitle(`SimpleEdit — ${basename(repoPath).replace('.git', '')}`)
    }
    startBridge(event.sender.id, hubFor(event.sender)).catch((err) => {
      console.error('[SimpleEdit] Failed to start MCP bridge:', err)
    })
  })

  handleInvoke('app:pick-repo', async (event) => {
    const win = getWindowForContents(event.sender.id)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Select bare git repository',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handleInvoke('app:pick-directory', async (event) => {
    const win = getWindowForContents(event.sender.id)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Select destination directory',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handleInvoke('app:clone-repo', async (_event, repoUrl: string, parentDir: string) => {
    return cloneBareRepo(repoUrl, parentDir)
  })

  handleInvoke('app:recent-repos', () => {
    return getRecentRepos()
  })

  handleInvoke('app:open-window', (_event, repoPath?: string) => {
    createWindow(repoPath)
  })

  handleInvoke('app:open-external', async (_event, url: string) => {
    // Awaited and swallowed, not floated. `openExternal` rejects for a URL the
    // OS will not handle, and a dropped rejection takes the main process down.
    // Swallowed rather than rethrown because the channel's result is `void` and
    // its callers float the invoke — rethrowing would only move the unhandled
    // rejection into the renderer.
    try {
      await shell.openExternal(url)
    } catch (err) {
      console.error('[SimpleEdit] app:open-external failed:', err)
    }
  })

  handleInvoke('app:save-dropped-blob', (_event, filename: string, bytes: Uint8Array) => {
    return saveDroppedBlob(filename, bytes)
  })

  handleInvoke('app:client-key', (event) => {
    return clientKeyOf(event.sender)
  })

  // ── Remote access ───────────────────────────────────────
  handleInvoke('remote:status', () => getRemoteStatus())
  handleInvoke('remote:config', () => getRemoteConfig())
  handleInvoke('remote:interfaces', () => listRemoteInterfaces())

  handleInvoke('remote:set-enabled', async (_event, enabled: boolean) => {
    setRemoteConfig({ ...getRemoteConfig(), enabled })
    const status = await applyRemoteConfig()
    broadcastRemoteStatus(status)
    return status
  })

  handleInvoke('remote:set-host', async (_event, host: string) => {
    // Validated HERE, not in the pane. This channel is reachable over the
    // remote socket, so a token holder could otherwise name `0.0.0.0` and turn
    // a loopback server into one answering on every interface — persisted, so
    // it would survive a restart.
    if (!isAllowedBindHost(host)) {
      throw new Error(`Refusing to bind ${host}: not a loopback or Tailscale address`)
    }
    setRemoteConfig({ ...getRemoteConfig(), host })
    const status = await applyRemoteConfig()
    broadcastRemoteStatus(status)
    return status
  })

  // ── PTY ─────────────────────────────────────────────────
  handleInvoke('pty:spawn', (event, options: PtySpawnOptions) => {
    spawnTerminal(options, hubFor(event.sender), clientKeyOf(event.sender))
  })

  handleInvoke('pty:write', (_event, id: string, data: string) => {
    writeToTerminal(id, data)
  })

  // The client id is stamped from the IPC event, never taken from the args —
  // a renderer must not be able to resize as (or claim on behalf of) another.
  handleInvoke('pty:resize', (event, id: string, cols: number, rows: number) => {
    resizeTerminal(id, cols, rows, clientKeyOf(event.sender))
  })

  handleInvoke('pty:claim', (event, id: string, cols: number, rows: number) => {
    claimTerminal(id, clientKeyOf(event.sender), hubFor(event.sender), cols, rows)
  })

  handleInvoke('pty:kill', (_event, id: string) => {
    killTerminal(id)
  })

  handleInvoke('pty:active-ids', () => {
    return getActiveTerminalIds()
  })

  handleInvoke('pty:backlog', (_event, id: string) => {
    return getTerminalBacklog(id)
  })

  // ── File system ─────────────────────────────────────────
  handleInvoke('fs:list', (_event, dirPath: string) => {
    return listDirectory(dirPath)
  })

  handleInvoke('fs:list-all', (_event, worktreePath: string) => {
    return listAllFiles(worktreePath)
  })

  handleInvoke('fs:read', (_event, filePath: string) => {
    return readFile(filePath)
  })

  handleInvoke('fs:write', (_event, filePath: string, content: string) => {
    writeFile(filePath, content)
  })

  handleInvoke('fs:create-file', (_event, filePath: string) => {
    createFile(filePath)
  })

  handleInvoke('fs:create-dir', (_event, dirPath: string) => {
    createDirectory(dirPath)
  })

  handleInvoke('fs:rename', (_event, oldPath: string, newPath: string) => {
    renamePath(oldPath, newPath)
  })

  handleInvoke('fs:delete', async (_event, filePath: string) => {
    await deletePath(filePath)
  })

  // ── Editor ──────────────────────────────────────────────
  handleInvoke('editor:open', (_event, filePath: string) => {
    return readFile(filePath)
  })

  handleInvoke('editor:save', (_event, filePath: string, content: string) => {
    return writeFile(filePath, content)
  })

  handleInvoke('editor:watch', (event, filePath: string) => {
    watchEditorFile(hubFor(event.sender), filePath)
  })

  handleInvoke('editor:unwatch', (event, filePath: string) => {
    unwatchEditorFile(event.sender.id, filePath)
  })

  // ── Worktrees ───────────────────────────────────────────
  // Every handler takes an OPTIONAL explicit `repoPath`: when present (a
  // session pointed at another bare repo) it targets that repo; when omitted
  // it falls back to the window's primary repo — preserving single-repo
  // behavior byte-for-byte.
  handleInvoke('worktree:list', async (event, repoPath?: string) => {
    try {
      const repo = resolveWorktreeRepo(event.sender.id, repoPath)
      return await listWorktrees(repo)
    } catch (err) {
      console.error('[SimpleEdit] worktree:list failed:', err)
      return []
    }
  })

  handleInvoke('worktree:create', async (event, name: string, baseBranch?: string, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    return createWorktree(repo, name, baseBranch)
  })

  handleInvoke('worktree:checkout', async (event, branch: string, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    return checkoutWorktree(repo, branch)
  })

  handleInvoke('worktree:branches', async (event, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    return listAvailableBranches(repo)
  })

  handleInvoke('worktree:remove', async (event, worktreePath: string, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    return removeWorktree(repo, worktreePath)
  })

  handleInvoke('worktree:watch', (event, repoPath?: string) => {
    const repo = resolveWorktreeRepo(event.sender.id, repoPath)
    watchWorktreeList(hubFor(event.sender), repo)
  })

  handleInvoke('worktree:unwatch', (event, repoPath?: string) => {
    unwatchWorktreeList(event.sender.id, repoPath)
  })

  // ── Interactive agents ──────────────────────────────────
  handleInvoke('agent:spawn', async (event, options: AgentSpawnOptions) => {
    const bridge = getBridgeInfo(event.sender.id)
    const client = hubFor(event.sender)
    // Awaited and caught. `buildLaunch` validates ids that reach a login-shell
    // command string, so it rejects on input an agent supplied — a bad
    // `spawn_session` model id is ordinary bad input, not an internal error.
    // Floated, it becomes an unhandled rejection, which Electron's default
    // handler turns into a modal "A JavaScript error occurred in the main
    // process" dialog while the session it belonged to fails silently.
    try {
      await spawnAgentTerminalForProvider(
        {
          ...options,
          ...(bridge ? { bridgePort: bridge.port, bridgeToken: bridge.token } : {})
        },
        client,
        clientKeyOf(event.sender)
      )
    } catch (error) {
      reportSpawnFailure(options.id, error, client)
      return
    }
    // After the spawn, not before: attachment maps a terminal that must exist.
    attachToTerminal(options.id, options.worktreePath, client, options.target.provider)
  })

  handleInvoke('agent:spawn-agents', (event, options: PtySpawnOptions) => {
    spawnAgentsTerminal(options, hubFor(event.sender), clientKeyOf(event.sender))
  })

  handleInvoke('agent:attach', (event, terminalId: string, worktreePath: string) => {
    attachToTerminal(terminalId, worktreePath, hubFor(event.sender))
  })

  handleInvoke('agent:detach', (_event, terminalId: string) => {
    detachFromTerminal(terminalId)
  })

  handleInvoke('agent:capabilities', (_event, provider: AgentProviderId) => getProvider(provider).capabilities)
  handleInvoke('agent:available', (_event, provider: AgentProviderId) => isExecutableAvailable(provider))
  handleInvoke('agent:providers', () => registeredProviderIds())

  // ── Git ─────────────────────────────────────────────────
  handleInvoke('git:log', (_event, worktreePath: string, count?: number) => {
    return getCommitLog(worktreePath, count)
  })

  handleInvoke('git:diff', (_event, worktreePath: string, commitHash: string) => {
    return getCommitDiff(worktreePath, commitHash)
  })

  handleInvoke('git:commit-files', (_event, worktreePath: string, commitHash: string) => {
    return getCommitFiles(worktreePath, commitHash)
  })

  handleInvoke('git:file-at-commit', (_event, worktreePath: string, commitHash: string, filePath: string) => {
    return getFileAtCommit(worktreePath, commitHash, filePath)
  })

  handleInvoke('git:staging-files', (_event, worktreePath: string) => {
    return getStagingFiles(worktreePath)
  })

  handleInvoke('git:staging-diff', (_event, worktreePath: string) => {
    return getStagingDiff(worktreePath)
  })

  handleInvoke('git:file-at-head', (_event, worktreePath: string, filePath: string) => {
    return getFileAtHead(worktreePath, filePath)
  })

  handleInvoke('git:watch', (event, worktreePath: string) => {
    return watchGitRefs(worktreePath, hubFor(event.sender))
  })

  handleInvoke('git:unwatch', (_event, worktreePath: string) => {
    unwatchGitRefs(worktreePath)
  })

  handleInvoke('git:branch-diff', (_event, worktreePath: string) => {
    return getBranchDiff(worktreePath)
  })

  handleInvoke('git:branch-files', (_event, worktreePath: string) => {
    return getBranchFiles(worktreePath)
  })

  handleInvoke('git:file-at-branch-base', (_event, worktreePath: string, filePath: string) => {
    return getFileAtBranchBase(worktreePath, filePath)
  })

  // ── Review ──────────────────────────────────────────────
  handleInvoke('review:start', (event, worktreePath: string, commitHash: string | null) => {
    return startReview(worktreePath, commitHash, hubFor(event.sender))
  })

  handleInvoke('review:cancel', (_event, worktreePath: string, commitHash: string | null) => {
    cancelReview(worktreePath, commitHash)
  })

  // ── Screen PRs ─────────────────────────────────────────
  handleInvoke('screenprs:start', (event, filters: ScreenPrsFilters) => {
    return startScreening(filters, hubFor(event.sender))
  })

  handleInvoke('screenprs:cancel', (event) => {
    cancelScreening(hubFor(event.sender))
  })

  handleInvoke('screenprs:deep-start', (event, context: PrContext) => {
    return startDeepReview(context, hubFor(event.sender))
  })

  handleInvoke('screenprs:deep-cancel', (_event, url: string) => {
    cancelDeepReview(url)
  })

  handleInvoke('screenprs:submit-review', async (_event, request: SubmitReviewRequest): Promise<SubmitReviewResult> => {
    try {
      const { reviewUrl, foldedComments } = await postReview(request.pr, buildReviewPayload(request.draft))
      return { ok: true, reviewUrl, foldedComments }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Tour ───────────────────────────────────────────────
  handleInvoke('tour:start', (event, worktreePath: string, commitHash: string | null, overrideOverview?: string) => {
    return startTour(worktreePath, commitHash, hubFor(event.sender), overrideOverview)
  })

  handleInvoke('tour:cancel', (_event, worktreePath: string, commitHash: string | null) => {
    cancelTour(worktreePath, commitHash)
  })

  handleInvoke('tour:load', (_event, worktreePath: string, commitHash: string | null) => {
    return loadTour(worktreePath, commitHash)
  })

  handleInvoke('tour:save-overview', (_event, worktreePath: string, commitHash: string | null, overview: string) => {
    saveOverview(worktreePath, commitHash, overview)
  })

  // ── Models (local Ollama + cloud Claude) ────────────────
  handleInvoke('models:available', () => {
    return isOllamaAvailable()
  })

  handleInvoke('models:claude', () => listClaudeModels())

  handleInvoke('models:codex', () => listCodexModels())

  handleInvoke('models:opencode', () => getOpenCodeModels())

  handleInvoke('models:hardware', () => {
    return detectHardware()
  })

  handleInvoke('models:installed', () => {
    return listInstalledModels()
  })

  handleInvoke('models:recommended', () => {
    return listRecommendedModels()
  })

  handleInvoke('models:pull', async (event, name: string) => {
    const wc = hubFor(event.sender)
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

  handleInvoke('models:config-get', () => {
    return getModelConfig()
  })

  handleInvoke('models:config-set', (_event, partial: Partial<ModelConfig>) => {
    return setModelConfig(partial)
  })

  // ── LSP ─────────────────────────────────────────────────
  handleInvoke('lsp:start', (event, { language, rootUri }: { language: string; rootUri: string }) => {
    try {
      return startServer(language, rootUri, hubFor(event.sender))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn('[LSP] Server unavailable:', reason)
      return { serverId: null, reason }
    }
  })

  handleInvoke('lsp:stop', (_event, { serverId }: { serverId: string }) => {
    stopServer(serverId)
  })

  handleSend('lsp:send', (_event, { serverId, message }: { serverId: string; message: JsonRpcMessage }) => {
    sendToServer(serverId, message)
  })

  // ── Session save/restore ────────────────────────────────
  handleInvoke('session:save', (_event, payload: SerializedSession) => {
    try {
      saveSession(payload)
    } catch (err) {
      console.error('[SimpleEdit] session:save failed:', err)
    }
  })

  handleInvoke('session:load', (_event, repoPath: string) => {
    return loadSession(repoPath)
  })

  handleInvoke('session:clear', (_event, repoPath: string) => {
    clearSession(repoPath)
  })

  // ── Agent-to-agent messaging ────────────────────────────
  handleInvoke('agent-bus:sync', (_event, peers: AgentPeer[]) => {
    syncPeers(peers)
  })

  handleInvoke('agent-bus:spawned', (_event, correlationId: string, peer: AgentPeer) => {
    resolveSpawn(correlationId, peer)
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
    // `hubFor` mints a hub for ANY sender, and the settings window is the sole
    // caller of some channels — so an open→use→close cycle left a hub holding
    // a destroyed WebContents behind. Repo windows clear their own in `closed`
    // along with the rest of their teardown; this is the catch-all, so a window
    // added later cannot reintroduce the leak by forgetting.
    const id = window.webContents.id
    window.webContents.once('destroyed', () => {
      closeSocketsForHub(id)
      clientHubs.delete(id)
    })
  })

  registerAllHandlers()
  initAutoUpdater()

  // Remote access survives a restart if it was on. `attachTarget` is resolved
  // per socket, not now, so starting before any window exists is fine.
  void applyRemoteConfig().catch((err: unknown) => {
    console.error('[SimpleEdit] Failed to start remote access:', err)
  })

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
    // Closing the last window stopped it (see `window-all-closed`). Reopening
    // one is what makes the app usable again, so it is also what makes remote
    // access meaningful again.
    if (getRemoteConfig().enabled && !getRemoteStatus().running) {
      void applyRemoteConfig().catch((err: unknown) => {
        console.error('[SimpleEdit] Failed to restart remote access:', err)
      })
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
  try { stopRemoteServer() } catch { /* ignore */ }
  try { cancelClaudeDiscovery() } catch { /* ignore */ }
  try { cancelCodexDiscovery() } catch { /* ignore */ }
  try { cancelOpenCodeDiscovery() } catch { /* ignore */ }
})

// Remote access stops with the last window, and this handler is why: it also
// kills every terminal and every bridge. With no window there is no session to
// reach, no repo to resolve, and `remoteAttachTarget` has nothing to hand a
// socket — so leaving the server up meant an open port, a live bearer token
// and a power assertion holding the Mac awake, serving nothing, with the
// agents already dead. That is worse than stopping, not better.
//
// It is not silent either: the config still says enabled, and `activate` —
// reopening a window, the only way back to a usable app on macOS — starts it
// again.
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
  try { stopRemoteServer() } catch { /* ignore */ }
  try { cancelClaudeDiscovery() } catch { /* ignore */ }
  try { cancelCodexDiscovery() } catch { /* ignore */ }
  try { cancelOpenCodeDiscovery() } catch { /* ignore */ }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
