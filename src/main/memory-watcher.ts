/**
 * Refcounted, hub-keyed watching of a Claude memory dir — the same client
 * model as `editor-watcher.ts`. Emits `memory:changed` (debounced) for any
 * add/unlink/change and for directories appearing or vanishing; the latter
 * are `structural`, telling the renderer to re-resolve (the memory dir's own
 * `unlinkDir` means it is gone).
 */
import { watch, type FSWatcher } from 'chokidar'
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

function flush(memoryDir: string): void {
  const state = watchers.get(memoryDir)
  if (!state) return
  const payload = { memoryDir, dirs: [...state.pendingDirs], structural: state.pendingStructural }
  state.pendingDirs.clear()
  state.pendingStructural = false
  for (const { webContents } of state.subscribers.values()) {
    if (!webContents.isDestroyed()) webContents.send('memory:changed', payload)
  }
}

function isInsideGitDir(memoryDir: string, p: string): boolean {
  return relative(memoryDir, p).split(sep).includes('.git')
}

/** Subscribe `client` to `memory:changed` for `memoryDir`. */
export function watchMemoryDir(client: RemoteClient, memoryDir: string): void {
  let state = watchers.get(memoryDir)

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
        flush(memoryDir)
      }, DEBOUNCE_MS)
    }
    watcher.on('all', (event, path) => {
      if (event === 'add' || event === 'unlink') s.pendingDirs.add(dirname(path))
      if (event === 'addDir' || event === 'unlinkDir') {
        s.pendingStructural = true
        if (path !== memoryDir) s.pendingDirs.add(dirname(path))
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
}

function dispose(memoryDir: string, state: MemoryWatchState): void {
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  void state.watcher.close()
  watchers.delete(memoryDir)
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
