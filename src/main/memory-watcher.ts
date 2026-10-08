/**
 * Refcounted, hub-keyed watching of a Claude memory dir — the same client
 * model as `editor-watcher.ts`. Emits `memory:changed` (debounced) for any
 * add/unlink/change and for directories appearing or vanishing; the latter
 * are `structural`, telling the renderer to re-resolve (the memory dir's own
 * `unlinkDir` means it is gone).
 *
 * A dir that is gone has no watch: its own `unlinkDir` flushes (with
 * `watchEnded`) and disposes the state, dropping every subscriber's refs, and
 * watching a missing dir is a no-op. The renderer re-watches when the dir is
 * back — via a fresh acquire, or directly when it reappeared before the
 * re-resolve noticed it was gone.
 */
import { watch, type FSWatcher } from 'chokidar'
import { statSync } from 'fs'
import { dirname, relative, sep } from 'path'
import type { RemoteClient } from './client-hub'
import { MEMORY_MAX_DEPTH } from '../shared/memory-health'

const DEBOUNCE_MS = 200

interface MemoryWatchState {
  watcher: FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
  pendingDirs: Set<string>
  pendingStructural: boolean
  subscribers: Map<number, { refCount: number; webContents: RemoteClient }>
}

const watchers = new Map<string, MemoryWatchState>()

function flush(memoryDir: string, state: MemoryWatchState, watchEnded = false): void {
  const payload = {
    memoryDir,
    dirs: [...state.pendingDirs],
    structural: state.pendingStructural,
    ...(watchEnded ? { watchEnded } : {}),
  }
  state.pendingDirs.clear()
  state.pendingStructural = false
  for (const { webContents } of state.subscribers.values()) {
    if (!webContents.isDestroyed()) webContents.send('memory:changed', payload)
  }
}

function isInsideGitDir(memoryDir: string, p: string): boolean {
  return relative(memoryDir, p).split(sep).includes('.git')
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Subscribe `client` to `memory:changed` for `memoryDir`. Returns false, and
 * subscribes nothing, when the dir doesn't exist.
 */
export function watchMemoryDir(client: RemoteClient, memoryDir: string): boolean {
  let state = watchers.get(memoryDir)
  if (!isDirectory(memoryDir)) {
    // Gone before chokidar told us: a subscriber added now would never hear from it again.
    if (state) dispose(memoryDir, state)
    return false
  }

  if (!state) {
    const watcher = watch(memoryDir, {
      ignoreInitial: true,
      persistent: true,
      depth: MEMORY_MAX_DEPTH,
      ignored: (p: string) => isInsideGitDir(memoryDir, p),
    })
    const s: MemoryWatchState = {
      watcher,
      debounceTimer: null,
      pendingDirs: new Set(),
      pendingStructural: false,
      subscribers: new Map(),
    }
    state = s
    watchers.set(memoryDir, s)

    const schedule = (): void => {
      if (s.debounceTimer) clearTimeout(s.debounceTimer)
      s.debounceTimer = setTimeout(() => {
        s.debounceTimer = null
        flush(memoryDir, s)
      }, DEBOUNCE_MS)
    }
    watcher.on('all', (event, path) => {
      // A closed watcher can still deliver queued events; they belong to no one now.
      if (watchers.get(memoryDir) !== s) return
      if (event === 'add' || event === 'unlink') s.pendingDirs.add(dirname(path))
      if (event === 'addDir' || event === 'unlinkDir') {
        s.pendingStructural = true
        if (path !== memoryDir) s.pendingDirs.add(dirname(path))
      }
      if (event === 'unlinkDir' && path === memoryDir) {
        flush(memoryDir, s, true)
        dispose(memoryDir, s)
        return
      }
      schedule()
    })
    watcher.on('error', (err) => {
      console.warn('[SimpleEdit] Memory watcher error:', err)
    })
  }

  const sub = state.subscribers.get(client.id)
  if (sub) {
    sub.refCount++
  } else {
    state.subscribers.set(client.id, { refCount: 1, webContents: client })
  }
  return true
}

function dispose(memoryDir: string, state: MemoryWatchState): void {
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = null
  void state.watcher.close()
  if (watchers.get(memoryDir) === state) watchers.delete(memoryDir)
}

export function unwatchMemoryDir(webContentsId: number, memoryDir: string): void {
  const state = watchers.get(memoryDir)
  if (!state) return
  const sub = state.subscribers.get(webContentsId)
  if (!sub) return
  sub.refCount--
  if (sub.refCount <= 0) state.subscribers.delete(webContentsId)
  if (state.subscribers.size === 0) dispose(memoryDir, state)
}

export function unwatchAllMemoryDirsForWindow(webContentsId: number): void {
  for (const [memoryDir, state] of watchers) {
    state.subscribers.delete(webContentsId)
    if (state.subscribers.size === 0) dispose(memoryDir, state)
  }
}

export function unwatchAllMemoryDirs(): void {
  for (const [memoryDir, state] of watchers) dispose(memoryDir, state)
}
