/**
 * What the desktop backlog list and its item detail share while on screen:
 * they are separate components (the list can live outside the view), so this
 * sits between them. Nothing here is persisted; unsaved text lives in the
 * backlog store's drafts.
 */
import { backlogStore } from './backlog.svelte'
import { loadAllowlistedModels, refreshAllowlistedModelsOnFocus, type AllowlistedModel } from '../lib/agentModels'
import { newBacklogItemId } from '../../shared/backlog'

/** The open item editor, as far as the list needs it. */
export interface BacklogEditor {
  /** Save now. True when main has everything. */
  flush(): Promise<boolean>
  /** Drop what is unsaved, e.g. because the item is being deleted. */
  discard(): void
}

const _state = $state({
  /** A new item's id while it is being written and not added yet. */
  newId: null as string | null,
  /** The open detail holds edits main doesn't have. */
  unsaved: false,
  /** Errors that no snapshot carries (e.g. "already being started"), per item. */
  startErrors: {} as Record<string, string>,
  /** The Settings → Models allowlist, in order. */
  models: [] as AllowlistedModel[],
  modelsLoaded: false,
})

let _editor: BacklogEditor | null = null
let _modelWatchers = 0

// Settings → Models has no change event: reread it when the picker or the
// window gets focus. The old list stays up meanwhile.
function takeModels(load: Promise<AllowlistedModel[]> | null): void {
  load
    ?.then((list) => {
      _state.models = list
      _state.modelsLoaded = true
    })
    .catch((err: unknown) => console.warn('[backlog] loading the models failed:', err))
}
const onWindowFocus = (): void => takeModels(refreshAllowlistedModelsOnFocus())

export const backlogView = {
  get newId(): string | null {
    return _state.newId
  },
  set newId(id: string | null) {
    _state.newId = id
  },
  get unsaved(): boolean {
    return _state.unsaved
  },
  set unsaved(value: boolean) {
    _state.unsaved = value
  },

  startError(id: string): string | undefined {
    return _state.startErrors[id]
  },
  setStartError(id: string, message: string | null): void {
    const { [id]: _, ...rest } = _state.startErrors
    _state.startErrors = message === null ? rest : { ...rest, [id]: message }
  },

  get models(): AllowlistedModel[] {
    return _state.models
  },
  /** The allowlist resolved to nothing: the picker says where to fill it. */
  get noModels(): boolean {
    return _state.modelsLoaded && _state.models.length === 0
  },
  refreshModels(): void {
    takeModels(loadAllowlistedModels())
  },
  /** Load the models and follow window focus while any caller holds this; returns its release. */
  watchModels(): () => void {
    if (_modelWatchers++ === 0) {
      backlogView.refreshModels()
      window.addEventListener('focus', onWindowFocus)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--_modelWatchers === 0) window.removeEventListener('focus', onWindowFocus)
    }
  },

  /** Register the open editor; returns its removal. */
  attachEditor(editor: BacklogEditor): () => void {
    _editor = editor
    return () => {
      if (_editor === editor) _editor = null
    }
  },
  /** Save the open editor's text. True when there is none, or main has it all. */
  flushEditor(): Promise<boolean> {
    return _editor?.flush() ?? Promise.resolve(true)
  },
  discardEditor(): void {
    _editor?.discard()
  },

  /** Show another item (or a new one), once the current one is saved. */
  async choose(id: string | 'new'): Promise<void> {
    const selectedId = backlogStore.selectedId
    if (id === selectedId || (id === 'new' && _state.newId && selectedId === _state.newId)) return
    const previous = _state.newId
    // Set first: the selection lands before this resumes, and must not read as an unknown id.
    _state.newId = id === 'new' ? newBacklogItemId() : null
    if (!(await backlogStore.requestSelect(_state.newId ?? id))) _state.newId = previous
  },

  /** Forget what only meant something while the backlog was on screen. */
  close(): void {
    _state.newId = null
    _state.unsaved = false
    _state.startErrors = {}
  },
}

export function _resetBacklogViewForTests(): void {
  backlogView.close()
  _state.models = []
  _state.modelsLoaded = false
  _editor = null
  if (_modelWatchers > 0) window.removeEventListener('focus', onWindowFocus)
  _modelWatchers = 0
}
