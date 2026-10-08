import { watch, type FSWatcher } from 'chokidar'
import type { RemoteClient } from './client-hub'

const DEBOUNCE_MS = 100

interface FileWatchState {
  watcher: FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
  /** Whether the pending flush includes a content change: clients hear only those. */
  contentChanged: boolean
  subscribers: Map<number, { refCount: number; webContents: RemoteClient }>
  /** Main's own interest (`watchFileInMain`), which outlives every window. */
  listeners: Set<() => void>
}

const watchers = new Map<string, FileWatchState>()

function emit(filePath: string): void {
  const state = watchers.get(filePath)
  if (!state) return
  for (const { webContents } of state.subscribers.values()) {
    if (!webContents.isDestroyed()) {
      webContents.send('editor:file-changed', { filePath })
    }
  }
}

/**
 * Subscribe `client` to change events for `filePath`.
 *
 * The subscription key is `client.id`, taken from the client itself rather
 * than passed alongside it: a `ClientHub` is one identity with several
 * transports, and a separately-supplied id could name a different one — which
 * would ref-count one subscriber while pushing to another.
 */
function ensureWatcher(filePath: string): FileWatchState {
  const existing = watchers.get(filePath)
  if (existing) return existing

  const watcher = watch(filePath, {
    ignoreInitial: true,
    persistent: true,
  })
  const s: FileWatchState = { watcher, debounceTimer: null, contentChanged: false, subscribers: new Map(), listeners: new Set() }
  watchers.set(filePath, s)

  const schedule = (contentChanged: boolean) => (): void => {
    s.contentChanged ||= contentChanged
    if (s.debounceTimer) clearTimeout(s.debounceTimer)
    s.debounceTimer = setTimeout(() => {
      s.debounceTimer = null
      const toClients = s.contentChanged
      s.contentChanged = false
      if (toClients) emit(filePath)
      for (const listener of s.listeners) listener()
    }, DEBOUNCE_MS)
  }
  watcher.on('change', schedule(true))
  // A file deleted or put back matters to a thread anchored in it, not to an open editor.
  watcher.on('add', schedule(false))
  watcher.on('unlink', schedule(false))
  return s
}

function releaseIfUnused(filePath: string, state: FileWatchState): void {
  if (state.subscribers.size > 0 || state.listeners.size > 0) return
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  void state.watcher.close()
  watchers.delete(filePath)
}

export function watchEditorFile(client: RemoteClient, filePath: string): void {
  const webContentsId = client.id
  const state = ensureWatcher(filePath)

  const sub = state.subscribers.get(webContentsId)
  if (sub) {
    sub.refCount++
  } else {
    state.subscribers.set(webContentsId, { refCount: 1, webContents: client })
  }
}

export function unwatchEditorFile(webContentsId: number, filePath: string): void {
  const state = watchers.get(filePath)
  if (!state) return

  const sub = state.subscribers.get(webContentsId)
  if (!sub) return

  sub.refCount--
  if (sub.refCount <= 0) {
    state.subscribers.delete(webContentsId)
  }

  releaseIfUnused(filePath, state)
}

export function unwatchAllEditorFilesForWindow(webContentsId: number): void {
  for (const [filePath, state] of watchers) {
    state.subscribers.delete(webContentsId)
    releaseIfUnused(filePath, state)
  }
}

/** Drops every window's subscriptions. Main's own (`watchFileInMain`) end only through their unsubscribe. */
export function unwatchAllEditorFiles(): void {
  for (const [filePath, state] of watchers) {
    state.subscribers.clear()
    releaseIfUnused(filePath, state)
  }
}

/**
 * Call `listener` after each (debounced) change, deletion or re-creation of
 * `filePath`, sharing the editor's watcher when the file is open. Returns the
 * unsubscribe.
 */
export function watchFileInMain(filePath: string, listener: () => void): () => void {
  ensureWatcher(filePath).listeners.add(listener)
  return () => {
    const state = watchers.get(filePath)
    if (!state) return
    state.listeners.delete(listener)
    releaseIfUnused(filePath, state)
  }
}
