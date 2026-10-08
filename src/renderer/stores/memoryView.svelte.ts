/**
 * Controller for open Claude memory views, keyed by memory dir and refcounted
 * (two sessions launched from one project share a dir). While held it owns
 * the dir's `memory:watch`, the health report and its Monaco markers, and it
 * turns `memory:changed` into file-tree refreshes, palette-cache invalidation,
 * a health refetch and — when directories came or went — a re-resolve.
 *
 * The badge and issue list are views over `memoryViewStore.health(dir)`.
 */
import { untrack } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { MemoryHealthReport, MemoryHealthReportIssue } from '../../shared/memory-health'
import type { MemoryLocation } from '../../shared/ipc-types'
import { bumpFsNonce } from './fsRefresh.svelte'
import { sessionsStore } from './sessions.svelte'
import { tabsStore, tabIdFor, type FileTab } from './tabsStore.svelte'
import { markdownViewStore } from './markdownView.svelte'
import { setMemoryReport, clearMemoryMarkers } from '../lib/memory-markers'
import { revealInEditor } from '../lsp/editor-opener'
import { invalidateMemoryFileCache } from '../lib/command-palette/providers/file-provider'
import { isMarkdownPath } from '../lib/markdown'

export interface MemoryHealthState {
  report: MemoryHealthReport | null
  loading: boolean
  error: string | null
}

interface Holder {
  refs: number
  /** Launch dir → refs from it: sessions from different launch dirs can share a memory dir. */
  launchDirs: Map<string, number>
  /** Bumped per fetch so a slow, superseded fetch can't overwrite a newer one. */
  seq: number
}

const holders = new Map<string, Holder>()
const _health = new SvelteMap<string, MemoryHealthState>()
let offChanged: (() => void) | null = null

async function fetchHealth(memoryDir: string): Promise<void> {
  const holder = holders.get(memoryDir)
  if (!holder) return
  const seq = ++holder.seq
  const prev = untrack(() => _health.get(memoryDir))
  _health.set(memoryDir, { report: prev?.report ?? null, loading: true, error: null })
  try {
    const report = await window.api.invoke('memory:health', memoryDir)
    if (holders.get(memoryDir) !== holder || holder.seq !== seq) return
    _health.set(memoryDir, { report, loading: false, error: null })
    setMemoryReport(report)
  } catch (err) {
    if (holders.get(memoryDir) !== holder || holder.seq !== seq) return
    clearMemoryMarkers(memoryDir)
    _health.set(memoryDir, {
      report: null,
      loading: false,
      error: err instanceof Error ? err.message : 'Health check failed',
    })
  }
}

/** Re-run `memory:resolve` and apply it to every view from `launchDir`. */
async function reresolve(launchDir: string): Promise<MemoryLocation | null> {
  try {
    const loc = await window.api.invoke('memory:resolve', launchDir)
    sessionsStore.applyMemoryLocation(launchDir, loc)
    return loc
  } catch (err) {
    console.warn('[memory] re-resolve failed:', err)
    return null
  }
}

function watch(memoryDir: string, holder: Holder): void {
  window.api
    .invoke('memory:watch', memoryDir)
    .then((watching) => {
      // Gone between resolve and watch: re-resolve so the view shows it missing.
      if (!watching && holders.get(memoryDir) === holder) void reresolveHolder(holder)
    })
    .catch((err: unknown) => {
      console.warn('[memory] watch failed:', err)
    })
}

async function reresolveHolder(holder: Holder): Promise<MemoryLocation[]> {
  const locs = await Promise.all([...holder.launchDirs.keys()].map(reresolve))
  return locs.filter((l): l is MemoryLocation => l !== null)
}

/**
 * After a structural change. When main reported the watch ended (the dir
 * itself was removed) but it exists again by the time we re-resolved, no
 * session's `exists` flipped, so nothing would re-acquire: watch it again.
 * Main dropped every ref with the watch, so this is a fresh one, not a second.
 */
async function afterStructural(memoryDir: string, holder: Holder, watchEnded: boolean): Promise<void> {
  const locs = await reresolveHolder(holder)
  if (!watchEnded || holders.get(memoryDir) !== holder) return
  if (locs.some((l) => l.memoryDir === memoryDir && l.exists)) watch(memoryDir, holder)
}

function ensureListener(): void {
  if (offChanged) return
  offChanged = window.api.on('memory:changed', ({ memoryDir, dirs, structural, watchEnded }) => {
    const holder = holders.get(memoryDir)
    if (!holder) return
    bumpFsNonce(memoryDir)
    for (const dir of dirs) bumpFsNonce(dir)
    invalidateMemoryFileCache(memoryDir)
    void fetchHealth(memoryDir)
    if (structural) void afterStructural(memoryDir, holder, watchEnded === true)
  })
}

function acquireUntracked(memoryDir: string, launchDir: string): () => void {
  let holder = holders.get(memoryDir)
  if (holder) {
    holder.refs++
    holder.launchDirs.set(launchDir, (holder.launchDirs.get(launchDir) ?? 0) + 1)
  } else {
    holder = { refs: 1, launchDirs: new Map([[launchDir, 1]]), seq: 0 }
    holders.set(memoryDir, holder)
    ensureListener()
    // The palette may have listed the dir while no one held it, so no
    // `memory:changed` reached its cache since.
    invalidateMemoryFileCache(memoryDir)
    watch(memoryDir, holder)
    void fetchHealth(memoryDir)
  }
  const held = holder
  let released = false
  return () => {
    if (released) return
    released = true
    held.refs--
    const fromLaunchDir = (held.launchDirs.get(launchDir) ?? 1) - 1
    if (fromLaunchDir > 0) held.launchDirs.set(launchDir, fromLaunchDir)
    else held.launchDirs.delete(launchDir)
    if (held.refs > 0 || holders.get(memoryDir) !== held) return
    holders.delete(memoryDir)
    _health.delete(memoryDir)
    clearMemoryMarkers(memoryDir)
    invalidateMemoryFileCache(memoryDir)
    void window.api.invoke('memory:unwatch', memoryDir).catch(() => undefined)
    if (holders.size === 0) {
      offChanged?.()
      offChanged = null
    }
  }
}

export const memoryViewStore = {
  /**
   * Hold an EXISTING memory dir open: watch it and keep its health and
   * markers current. Returns the release function.
   */
  acquire(memoryDir: string, launchDir: string): () => void {
    // Callers acquire from an $effect; the health state read-then-written
    // below must not become that effect's dependency, or it re-runs forever.
    return untrack(() => acquireUntracked(memoryDir, launchDir))
  },

  health(memoryDir: string): MemoryHealthState | undefined {
    return _health.get(memoryDir)
  },

  refresh(memoryDir: string): Promise<void> {
    return fetchHealth(memoryDir)
  },

  reresolve,

  /**
   * Jump to an issue in session `sessionId`'s editor. A Markdown file showing
   * 'rendered' is switched to 'hybrid' first, since markers are invisible in
   * the preview.
   */
  revealIssue(sessionId: string, issue: MemoryHealthReportIssue): void {
    const path = issue.file
    const reveal = (): void => {
      const active = tabsStore.active(sessionId)
      revealInEditor(
        sessionId,
        path,
        { startLineNumber: issue.line, startColumn: issue.column, endLineNumber: issue.line, endColumn: issue.endColumn },
        {
          isActiveTab: active?.kind === 'file' && active.path === path,
          open: () => {
            const tab: FileTab = { kind: 'file', id: tabIdFor({ kind: 'file', path }), path, modified: false }
            tabsStore.open(sessionId, tab)
          },
        },
      )
    }
    if (isMarkdownPath(path) && markdownViewStore.get(path) === 'rendered') {
      markdownViewStore.setFor(path, 'hybrid')
      // The editor was hidden in 'rendered'; reveal once it has been laid out
      // again, or the scroll is computed against a zero-height viewport.
      requestAnimationFrame(() => requestAnimationFrame(reveal))
      return
    }
    reveal()
  },
}

/** Test seam. */
export function _resetMemoryViewForTests(): void {
  holders.clear()
  _health.clear()
  offChanged?.()
  offChanged = null
}
