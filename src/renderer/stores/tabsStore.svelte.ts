/**
 * Unified per-worktree tab model.
 *
 * Every first-class view in a WorktreePane — files, diffs, tours, plans, and
 * (reserved) agent-composed panels — is a tab in the per-worktree list. Two
 * panes showing the same worktree share the same tab list.
 *
 * Phase 1 scope: data model + transitions only. Renderers still delegate to
 * existing components verbatim. Peek-pin, unread and close-focus behaviors
 * follow the contract in issue #61.
 */

/** Discriminated union of all tab kinds a pane can host. */
export type Tab =
  | FileTab
  | DiffTab
  | TourTab
  | PlanTab
  | ComposedTab

export interface FileTab {
  kind: 'file'
  id: string
  /** Absolute path on disk (worktree-relative would collide when the same
   * filename lives in two worktrees sharing the store key). */
  path: string
  /** Set by the CodeEditor when the buffer diverges from disk. */
  modified: boolean
}

export interface DiffTab {
  kind: 'diff'
  id: string
  /** null = staging/uncommitted, 'branch' = branch tour, otherwise commit SHA. */
  commitHash: string | null
  commitMessage: string
  /** Optional first sub-view hint for DiffReview. */
  initialTab?: 'files' | 'findings'
}

export interface TourTab {
  kind: 'tour'
  id: string
  commitHash: string | null
  commitMessage: string
}

export interface PlanTab {
  kind: 'plan'
  id: string
  /** 'user-plan' | 'plan-claude:<terminalId>' | commit SHA. */
  planHash: string
  label: string
  /** Terminal id when plan originated from Claude, otherwise null. */
  claudeTerminalId: string | null
}

/**
 * Agent-composed panel rendered through the gen-ui catalog (#62).
 *
 * `spec` is the json-render flat-tree spec validated against the catalog at
 * the IPC boundary; the renderer hands it to `<ComposedPanel>`. `terminalId`
 * lets `send_to_agent` route back to the originating Claude session — Phase 2
 * wires the action handlers that consume it.
 */
export interface ComposedTab {
  kind: 'composed'
  id: string
  title: string
  spec: import('../../shared/gen-ui-catalog').Spec
  terminalId?: string
}

export type TabKind = Tab['kind']

/** Kinds that participate in peek mode. Tours and plans are always sticky. */
const PEEKABLE_KINDS: ReadonlySet<TabKind> = new Set(['file', 'diff'])

interface WorktreeTabState {
  tabs: Tab[]
  activeId: string | null
  /** Most-recently-active-first. Used for close-focus behavior. */
  mru: string[]
  /** Tab ids whose content arrived in the background since last focused. */
  unread: Set<string>
  /** The single peek tab, if any. */
  peekId: string | null
}

function emptyState(): WorktreeTabState {
  return { tabs: [], activeId: null, mru: [], unread: new Set(), peekId: null }
}

let _byWorktree = $state<Map<string, WorktreeTabState>>(new Map())

function getState(worktreePath: string): WorktreeTabState {
  return _byWorktree.get(worktreePath) ?? emptyState()
}

function setState(worktreePath: string, next: WorktreeTabState): void {
  const m = new Map(_byWorktree)
  m.set(worktreePath, next)
  _byWorktree = m
}

/** Stable tab-id derivation keyed by kind + content identity. */
export function tabIdFor(
  spec:
    | { kind: 'file'; path: string }
    | { kind: 'diff'; commitHash: string | null }
    | { kind: 'tour'; commitHash: string | null }
    | { kind: 'plan'; planHash: string }
    | { kind: 'composed'; id: string },
): string {
  switch (spec.kind) {
    case 'file':
      return `file:${spec.path}`
    case 'diff':
      return `diff:${spec.commitHash ?? 'staging'}`
    case 'tour':
      return `tour:${spec.commitHash ?? 'staging'}`
    case 'plan':
      return `plan:${spec.planHash}`
    case 'composed':
      return `composed:${spec.id}`
  }
}

function pushMru(mru: string[], id: string): string[] {
  const filtered = mru.filter((x) => x !== id)
  filtered.unshift(id)
  return filtered
}

function dropFromMru(mru: string[], id: string): string[] {
  return mru.filter((x) => x !== id)
}

/** Options that apply to any `open*` call. */
export interface OpenOptions {
  /**
   * 'active' — open and focus (default).
   * 'background' — open without focusing; if tab is new it receives an unread marker.
   */
  focus?: 'active' | 'background'
  /** Open as a peek tab. Ignored for non-peekable kinds. */
  peek?: boolean
}

export const tabsStore = {
  /** Returns a read-only snapshot of the tab list for a worktree. */
  list(worktreePath: string): Tab[] {
    return getState(worktreePath).tabs
  },

  activeId(worktreePath: string): string | null {
    return getState(worktreePath).activeId
  },

  active(worktreePath: string): Tab | null {
    const s = getState(worktreePath)
    if (!s.activeId) return null
    return s.tabs.find((t) => t.id === s.activeId) ?? null
  },

  peekId(worktreePath: string): string | null {
    return getState(worktreePath).peekId
  },

  isPeek(worktreePath: string, tabId: string): boolean {
    return getState(worktreePath).peekId === tabId
  },

  isUnread(worktreePath: string, tabId: string): boolean {
    return getState(worktreePath).unread.has(tabId)
  },

  /**
   * Insert or focus a tab. When the tab already exists, its identity fields
   * are refreshed from the incoming spec (so e.g. commit messages update).
   */
  open(worktreePath: string, tab: Tab, opts: OpenOptions = {}): Tab {
    const focus = opts.focus ?? 'active'
    const peek = opts.peek === true && PEEKABLE_KINDS.has(tab.kind)
    const s = getState(worktreePath)

    const existingIdx = s.tabs.findIndex((t) => t.id === tab.id)
    let tabs: Tab[]
    if (existingIdx >= 0) {
      tabs = s.tabs.slice()
      tabs[existingIdx] = { ...s.tabs[existingIdx], ...tab }
    } else {
      if (peek && s.peekId) {
        // Replace the existing peek tab in place (so positions stay stable).
        const replaceIdx = s.tabs.findIndex((t) => t.id === s.peekId)
        if (replaceIdx >= 0) {
          tabs = s.tabs.slice()
          tabs[replaceIdx] = tab
        } else {
          tabs = [...s.tabs, tab]
        }
      } else {
        tabs = [...s.tabs, tab]
      }
    }

    let peekId = s.peekId
    if (existingIdx >= 0) {
      // Re-opening an existing tab always pins it (removes peek marker).
      if (peekId === tab.id) peekId = null
    } else {
      if (peek) {
        // New peek tab: clear prior peek if still referenced, set new one.
        peekId = tab.id
      } else if (peekId === tab.id) {
        peekId = null
      }
    }

    let activeId = s.activeId
    let mru = s.mru
    let unread = s.unread

    if (focus === 'active') {
      activeId = tab.id
      mru = pushMru(s.mru, tab.id)
      if (unread.has(tab.id)) {
        unread = new Set(unread)
        unread.delete(tab.id)
      }
    } else {
      // Background open: newly-added tabs get an unread marker.
      if (existingIdx < 0) {
        unread = new Set(unread)
        unread.add(tab.id)
      }
      // First tab in an otherwise-empty pane still focuses — idle auto-focus.
      if (activeId === null) {
        activeId = tab.id
        mru = pushMru(s.mru, tab.id)
        unread = new Set(unread)
        unread.delete(tab.id)
      }
    }

    setState(worktreePath, { tabs, activeId, mru, unread, peekId })
    return tab
  },

  /** Focus an already-open tab. No-op for unknown ids. */
  focus(worktreePath: string, tabId: string): void {
    const s = getState(worktreePath)
    if (!s.tabs.some((t) => t.id === tabId)) return
    const unread = s.unread.has(tabId)
      ? new Set([...s.unread].filter((x) => x !== tabId))
      : s.unread
    setState(worktreePath, {
      ...s,
      activeId: tabId,
      mru: pushMru(s.mru, tabId),
      unread,
    })
  },

  /**
   * Close a tab. After close, focuses the most-recently-active remaining tab
   * (browser standard). No-op for unknown ids.
   */
  close(worktreePath: string, tabId: string): void {
    const s = getState(worktreePath)
    const oldIdx = s.tabs.findIndex((t) => t.id === tabId)
    if (oldIdx < 0) return
    const tabs = s.tabs.filter((t) => t.id !== tabId)
    const mru = dropFromMru(s.mru, tabId)
    const unread = s.unread.has(tabId)
      ? new Set([...s.unread].filter((x) => x !== tabId))
      : s.unread
    const peekId = s.peekId === tabId ? null : s.peekId

    let activeId = s.activeId
    if (activeId === tabId) {
      if (mru.length > 0) {
        activeId = mru[0]
      } else if (tabs.length > 0) {
        // MRU was empty (e.g. closed tab was only ever background-opened, or
        // remaining tabs never received focus). Fall back to a neighbor so we
        // never leave tabs visible with activeId === null.
        activeId = tabs[Math.min(oldIdx, tabs.length - 1)].id
      } else {
        activeId = null
      }
    }

    setState(worktreePath, { tabs, activeId, mru, unread, peekId })
  },

  /** Close all tabs for a worktree. */
  closeAll(worktreePath: string): void {
    setState(worktreePath, emptyState())
  },

  /**
   * Pin the current peek tab (if any). Called by double-click or any other
   * explicit pin action. Safe to call unconditionally.
   */
  pinPeek(worktreePath: string, tabId: string): void {
    const s = getState(worktreePath)
    if (s.peekId !== tabId) return
    setState(worktreePath, { ...s, peekId: null })
  },

  /** Mark a tab unread. Used when agent content arrives in the background. */
  markUnread(worktreePath: string, tabId: string): void {
    const s = getState(worktreePath)
    if (!s.tabs.some((t) => t.id === tabId)) return
    if (s.unread.has(tabId)) return
    const unread = new Set(s.unread)
    unread.add(tabId)
    setState(worktreePath, { ...s, unread })
  },

  clearUnread(worktreePath: string, tabId: string): void {
    const s = getState(worktreePath)
    if (!s.unread.has(tabId)) return
    const unread = new Set(s.unread)
    unread.delete(tabId)
    setState(worktreePath, { ...s, unread })
  },

  /**
   * Mark a file tab as modified (or not). No-op if the tab is missing or not a
   * file tab — prevents accidental cross-kind mutation that a generic patch
   * would allow.
   */
  setFileModified(worktreePath: string, tabId: string, modified: boolean): void {
    const s = getState(worktreePath)
    const idx = s.tabs.findIndex((t) => t.id === tabId)
    if (idx < 0) return
    const existing = s.tabs[idx]
    if (existing.kind !== 'file') return
    if (existing.modified === modified) return
    const tabs = s.tabs.slice()
    tabs[idx] = { ...existing, modified }
    setState(worktreePath, { ...s, tabs })
  },

  /** Reorder a tab within a worktree's list. Both indices must be valid. */
  reorder(worktreePath: string, fromIndex: number, toIndex: number): void {
    const s = getState(worktreePath)
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= s.tabs.length) return
    if (toIndex < 0 || toIndex >= s.tabs.length) return
    const tabs = s.tabs.slice()
    const [moved] = tabs.splice(fromIndex, 1)
    tabs.splice(toIndex, 0, moved)
    setState(worktreePath, { ...s, tabs })
  },
}
