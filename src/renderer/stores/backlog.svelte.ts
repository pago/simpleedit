/**
 * Mirror of this window's project backlog, which main owns
 * (`main/backlog-store.ts`). Shared by the desktop renderer and the phone
 * (`src/web`), the way agent threads are: load once, then take each
 * `backlog:changed` snapshot that is newer than what the mirror holds.
 *
 * Every change goes to main as an op batch and comes back as a snapshot; the
 * mirror is never edited locally. A refused or failed change rejects (or
 * returns the conflict), so an editor keeps the user's text until main has it.
 */
import {
  newBacklogItemId,
  type BacklogItem,
  type BacklogItemPatch,
  type BacklogOp,
  type BacklogOpResult,
  type BacklogSnapshot,
  type NewBacklogItem,
} from '../../shared/backlog'
import { SESSION_CREATE_UNWITNESSED, type SessionCreateResult } from '../../shared/ipc-types'
import { cleanSessionLabel } from '../../shared/brief'

let _snapshot = $state<BacklogSnapshot | null>(null)
/** Items an agent added since this client loaded, newest last, until dismissed. */
let _arrivals = $state<BacklogItem[]>([])
/** The item the desktop's backlog view shows, kept while the view is closed. */
let _selectedId = $state<string | null>(null)

/**
 * The open editor's "save what's unsaved first" check. A selection change
 * waits for it and is dropped when it fails, so text main hasn't taken is never
 * unmounted from under the user.
 */
let _selectionGuard: (() => Promise<boolean>) | null = null

/**
 * The desktop editor's unsaved text for an item. It is the one copy of that
 * text: written as the user types, kept per viewer in `localStorage` so a
 * reload, a closed window or a failed save never loses it, and dropped only
 * once main has exactly that text (`settleDraft`) or the user discards it.
 */
export interface BacklogDraft {
  prompt: string
  /** As typed; compared after `cleanSessionLabel`. */
  label: string
  /** `targetKey` of the model. */
  target: string
  /** Main's fields at `baseVersion`, as the editor last knew them. */
  saved: { prompt: string; label: string; target: string }
  baseVersion: number
  /** Main has had the item (it may since have left). */
  created: boolean
}
let _drafts = $state<Record<string, BacklogDraft>>({})
/** Each item's saves, run one after another so one never conflicts with the one before it. */
const _saveChains = new Map<string, Promise<boolean>>()

/**
 * One key per draft (`<prefix><project>\n<item id>`): windows on the same
 * project each write only the drafts they change, and see each other's
 * through `storage` events.
 */
const DRAFT_KEY = 'simpleedit:backlog-draft:'
/** The first format, one key per project; read once and split. */
const OLD_DRAFTS_KEY = 'simpleedit:backlog-drafts:'

function draftKey(project: string, id: string): string {
  return `${DRAFT_KEY}${project}\n${id}`
}

/** The item id a storage key holds a draft of, when it is one of `project`'s. */
function draftIdOf(key: string | null, project: string): string | null {
  const prefix = `${DRAFT_KEY}${project}\n`
  return key?.startsWith(prefix) ? key.slice(prefix.length) : null
}

function parseDraft(raw: string | null): BacklogDraft | null {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as BacklogDraft) : null
  } catch {
    return null
  }
}

function readDrafts(project: string): Record<string, BacklogDraft> {
  const drafts: Record<string, BacklogDraft> = {}
  try {
    const old = parseDraft(localStorage.getItem(OLD_DRAFTS_KEY + project)) as Record<string, BacklogDraft> | null
    if (old) {
      for (const [id, draft] of Object.entries(old)) localStorage.setItem(draftKey(project, id), JSON.stringify(draft))
      localStorage.removeItem(OLD_DRAFTS_KEY + project)
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      const id = draftIdOf(key, project)
      const draft = id && key ? parseDraft(localStorage.getItem(key)) : null
      if (id && draft) drafts[id] = draft
    }
  } catch {
    // Storage blocked: drafts live in memory for this window only.
  }
  return drafts
}

/** Set (or with null, drop) one draft, in memory and in storage. */
function writeDraft(id: string, draft: BacklogDraft | null): void {
  if (draft) _drafts = { ..._drafts, [id]: draft }
  else {
    const { [id]: _, ...rest } = _drafts
    _drafts = rest
  }
  const project = _snapshot?.project
  if (!project) return
  try {
    if (draft) localStorage.setItem(draftKey(project, id), JSON.stringify(draft))
    else localStorage.removeItem(draftKey(project, id))
  } catch {
    // Storage blocked or full: the draft still lives in memory for this window.
  }
}

/** Another window on this project changed a draft. */
function onStorage(e: StorageEvent): void {
  const project = _snapshot?.project
  const id = project ? draftIdOf(e.key, project) : null
  if (!id) return
  const draft = parseDraft(e.newValue)
  if (draft) _drafts = { ..._drafts, [id]: draft }
  else {
    const { [id]: _, ...rest } = _drafts
    _drafts = rest
  }
}

function sameText(a: { prompt: string; label: string; target: string }, b: { prompt: string; label: string; target: string }): boolean {
  return a.prompt === b.prompt && cleanSessionLabel(a.label) === cleanSessionLabel(b.label) && a.target === b.target
}

/** One requestId per Start intent, reused until that intent settles, so a retried Start after a dropped answer can't make a second session. */
const _startIntents = new Map<string, string>()

function receive(snapshot: BacklogSnapshot): void {
  const cur = _snapshot
  // A broadcast is for every project; only this window's counts, and until a
  // load has said which that is, none does. A load always wins: it is how the
  // mirror learns (or changes) its project.
  if (!cur || snapshot.project !== cur.project || snapshot.rev < cur.rev) return
  const known = new Set(cur.items.map((i) => i.id))
  const added = snapshot.items.filter((i) => i.createdBy === 'agent' && !known.has(i.id))
  if (added.length) _arrivals = [..._arrivals, ...added]
  _snapshot = snapshot
}

async function apply(ops: BacklogOp[]): Promise<BacklogOpResult> {
  const result = await window.api.invoke('backlog:op', ops)
  receive(result.snapshot)
  return result
}

export const backlogStore = {
  /** The project's items, in order. Empty until loaded. */
  get items(): BacklogItem[] {
    return _snapshot?.items ?? []
  },
  /** The project's bare repo path, once loaded. */
  get project(): string | null {
    return _snapshot?.project ?? null
  },
  get(id: string): BacklogItem | undefined {
    return _snapshot?.items.find((i) => i.id === id)
  },

  /** Agent-added items not yet acknowledged here — what the "Added to backlog" notice shows. */
  get arrivals(): BacklogItem[] {
    return _arrivals
  },
  dismissArrival(id: string): void {
    _arrivals = _arrivals.filter((i) => i.id !== id)
  },

  /** The item the backlog view shows. It may name an item not added yet, or one that just left. */
  get selectedId(): string | null {
    return _selectedId
  },
  /** Show `id` without asking the open editor. Only for when nothing there can be unsaved. */
  select(id: string | null): void {
    _selectedId = id
  },
  /**
   * Show `id` once the open editor has saved. False, and the selection kept,
   * when it couldn't (the editor says why). Every selection a user causes goes
   * through here.
   */
  async requestSelect(id: string | null): Promise<boolean> {
    if (id === _selectedId) return true
    const guard = _selectionGuard
    if (guard && !(await guard())) return false
    _selectedId = id
    return true
  },
  /** Register the open editor's save-first check; returns its removal. */
  guardSelection(guard: () => Promise<boolean>): () => void {
    _selectionGuard = guard
    return () => {
      if (_selectionGuard === guard) _selectionGuard = null
    }
  },

  draft(id: string): BacklogDraft | undefined {
    return _drafts[id]
  },
  /** Every kept draft, by item id. */
  get drafts(): Record<string, BacklogDraft> {
    return _drafts
  },
  /**
   * Record what the editor holds. What it knows of main never goes backwards:
   * an editor that opened before a save landed carries an older `baseVersion`.
   */
  putDraft(id: string, draft: BacklogDraft): void {
    const prev = _drafts[id]
    const known = prev && prev.baseVersion > draft.baseVersion ? prev : draft
    const next: BacklogDraft = { ...draft, saved: known.saved, baseVersion: known.baseVersion, created: draft.created || !!prev?.created }
    if (sameText(next, next.saved)) return backlogStore.dropDraft(id)
    writeDraft(id, next)
  },
  /**
   * Main has `saved` at `version`. The draft goes only if that is its text; a
   * save that landed late, behind newer typing, just moves its base forward.
   */
  settleDraft(id: string, saved: BacklogDraft['saved'], version: number): void {
    const prev = _drafts[id]
    if (!prev) return
    if (sameText(prev, saved)) return backlogStore.dropDraft(id)
    if (version > prev.baseVersion || !prev.created) writeDraft(id, { ...prev, saved, baseVersion: version, created: true })
  },
  dropDraft(id: string): void {
    if (id in _drafts) writeDraft(id, null)
  },
  /**
   * Run `save` once this item's earlier saves are done. Without one pending it
   * runs at once, so a save started on unload sends before the page goes.
   */
  queueSave(id: string, save: () => Promise<boolean>): Promise<boolean> {
    const before = _saveChains.get(id)
    const run = before ? before.then(save, save) : save()
    _saveChains.set(id, run)
    const forget = (): void => {
      if (_saveChains.get(id) === run) _saveChains.delete(id)
    }
    run.then(forget, forget)
    return run
  },

  /** Replace the mirror with main's backlog: at start, after a reconnect, and when the phone switches project. */
  async load(): Promise<void> {
    try {
      const snapshot = await window.api.invoke('backlog:load')
      if (_snapshot && snapshot.rev < _snapshot.rev && snapshot.project === _snapshot.project) return
      if (snapshot.project !== _snapshot?.project) {
        // Another project's arrivals and selection mean nothing here.
        if (_snapshot) {
          _arrivals = []
          _selectedId = null
        }
        _drafts = readDrafts(snapshot.project)
      }
      _snapshot = snapshot
    } catch (err) {
      console.warn('[backlog] loading the backlog failed:', err)
    }
  },

  /**
   * Add an item. Resolves to main's answer and the item's id; rejects if main
   * refused it or never answered. Retry with the same `id`: main drops an add
   * it already has, so a retry after a lost answer can't add it twice.
   */
  async add(input: Omit<NewBacklogItem, 'id'> & { id?: string }, index?: number): Promise<{ id: string; result: BacklogOpResult }> {
    const { id = newBacklogItemId(), ...item } = input
    const result = await apply([{ kind: 'add', item: { ...item, id }, ...(index !== undefined ? { index } : {}) }])
    return { id, result }
  },
  /** Save an edit made against `baseVersion`. A conflict comes back as `{ ok: false }`, never thrown. */
  update(id: string, baseVersion: number, patch: BacklogItemPatch): Promise<BacklogOpResult> {
    return apply([{ kind: 'update', id, baseVersion, patch }])
  },
  /** Remove an item, and any unsaved text of it once main confirms. */
  async remove(id: string): Promise<BacklogOpResult> {
    const result = await apply([{ kind: 'remove', id }])
    if (result.ok) backlogStore.dropDraft(id)
    return result
  },
  reorder(ids: string[]): Promise<BacklogOpResult> {
    return apply([{ kind: 'reorder', ids }])
  },

  /**
   * Start an item as a session. Rejects with main's reason; the item then
   * stays in the backlog and says why. An unconfirmed start ends its intent,
   * so the user's next Start is a deliberate new one.
   */
  async start(id: string): Promise<SessionCreateResult> {
    let requestId = _startIntents.get(id)
    if (!requestId) {
      requestId = crypto.randomUUID()
      _startIntents.set(id, requestId)
    }
    try {
      const result = await window.api.invoke('backlog:start', { id, requestId })
      _startIntents.delete(id)
      return result
    } catch (err) {
      if (err instanceof Error && err.message.includes(SESSION_CREATE_UNWITNESSED)) _startIntents.delete(id)
      throw err
    }
  },
}

/**
 * Subscribe to `backlog:changed`. Call once at app start; returns an unsub.
 * Loading is the caller's, once the window has a project: before that, main
 * has no backlog to give.
 */
export function initBacklogListeners(): () => void {
  const off = window.api.on('backlog:changed', (snapshot) => receive(snapshot))
  window.addEventListener('storage', onStorage)
  return () => {
    off()
    window.removeEventListener('storage', onStorage)
  }
}

export function _resetBacklogForTests(): void {
  _snapshot = null
  _arrivals = []
  _selectedId = null
  _selectionGuard = null
  _drafts = {}
  _saveChains.clear()
  _startIntents.clear()
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(DRAFT_KEY) || key.startsWith(OLD_DRAFTS_KEY)) localStorage.removeItem(key)
  } catch {
    /* no storage */
  }
}
