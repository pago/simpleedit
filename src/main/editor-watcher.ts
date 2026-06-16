import { watch, type FSWatcher } from 'chokidar'
import type { WebContents } from 'electron'

const DEBOUNCE_MS = 100

interface FileWatchState {
  watcher: FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
  subscribers: Map<number, { refCount: number; webContents: WebContents }>
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

export function watchEditorFile(
  webContentsId: number,
  filePath: string,
  webContents: WebContents
): void {
  let state = watchers.get(filePath)

  if (!state) {
    const watcher = watch(filePath, {
      ignoreInitial: true,
      persistent: true,
    })
    state = { watcher, debounceTimer: null, subscribers: new Map() }
    watchers.set(filePath, state)

    const s = state
    watcher.on('change', () => {
      if (s.debounceTimer) clearTimeout(s.debounceTimer)
      s.debounceTimer = setTimeout(() => {
        s.debounceTimer = null
        emit(filePath)
      }, DEBOUNCE_MS)
    })
  }

  const sub = state.subscribers.get(webContentsId)
  if (sub) {
    sub.refCount++
  } else {
    state.subscribers.set(webContentsId, { refCount: 1, webContents })
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

  if (state.subscribers.size === 0) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    void state.watcher.close()
    watchers.delete(filePath)
  }
}

export function unwatchAllEditorFilesForWindow(webContentsId: number): void {
  for (const [filePath, state] of watchers) {
    state.subscribers.delete(webContentsId)
    if (state.subscribers.size === 0) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer)
      void state.watcher.close()
      watchers.delete(filePath)
    }
  }
}

export function unwatchAllEditorFiles(): void {
  for (const state of watchers.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    void state.watcher.close()
  }
  watchers.clear()
}
