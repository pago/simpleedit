import * as monaco from 'monaco-editor'

/**
 * Bridges Monaco's "open this URI" requests (Go to Definition, peek navigation,
 * Ctrl-click) to the host application's tab system.
 *
 * Why this exists:
 *   The standalone Monaco editor's built-in `openCodeEditor` only succeeds
 *   when a model for the requested URI already exists in *this* editor. For
 *   any cross-file navigation it returns false, and Monaco falls back to the
 *   peek widget — which is why "Go to Definition" on an `import` did nothing
 *   visible beyond peek before this module was wired up.
 *
 *   We register a single global opener (Monaco only allows one path through
 *   this hook) and let each mounted CodeEditor opt-in by binding a handler
 *   that knows how to open a path in its containing pane's tab list.
 *
 * Position handoff:
 *   The opener call carries the LSP-resolved position of the target symbol.
 *   The pane that handles the open request triggers a tab switch, and the
 *   CodeEditor instance that ends up loading the file calls
 *   `consumePendingReveal(path)` after `setModel` to scroll/select.
 */

type OpenHandler = (path: string) => void

/**
 * Everything here is per scope — the workspace (session) that owns the
 * editor. Hidden workspaces stay mounted, so a global registry would reveal in
 * another session's editor, or let it consume a reveal meant for this one.
 */
const handlersByEditor = new WeakMap<monaco.editor.ICodeEditor, { scope: string; handler: OpenHandler }>()
const pendingReveals = new Map<string, monaco.IPosition | monaco.IRange>()

// Keyed by the path an editor has LOADED, not the one it was mounted for:
// TabContainer reuses one editor instance across tabs, so a mount-time key
// would point at whichever file it showed first.
const editorsByLoadedPath = new Map<string, Set<monaco.editor.IStandaloneCodeEditor>>()
const loadedKeyByEditor = new Map<monaco.editor.IStandaloneCodeEditor, string>()

function key(scope: string, path: string): string {
  return `${scope}\0${path}`
}

let openerRegistered = false

function ensureOpenerRegistered(): void {
  if (openerRegistered) return
  openerRegistered = true
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      // Same-file navigation must fall through to Monaco's default standalone
      // handler — it sets the cursor on the existing model. If we returned
      // true here, the host would receive a redundant openFile request that
      // resolves to the already-active tab, no `filePath` prop change fires,
      // and `consumePendingReveal` never runs — the cursor would stay put.
      const sourceModel = source.getModel()
      if (sourceModel && sourceModel.uri.toString() === resource.toString()) {
        return false
      }

      const bound = handlersByEditor.get(source)
      if (!bound) return false
      if (resource.scheme !== 'file') return false
      const path = resource.fsPath
      if (selectionOrPosition) {
        pendingReveals.set(key(bound.scope, path), selectionOrPosition)
      }
      bound.handler(path)
      return true
    },
  })
}

export function bindEditorOpener(
  editor: monaco.editor.ICodeEditor,
  scope: string,
  handler: OpenHandler,
): () => void {
  ensureOpenerRegistered()
  handlersByEditor.set(editor, { scope, handler })
  return () => {
    handlersByEditor.delete(editor)
  }
}

export function consumePendingReveal(
  scope: string,
  path: string,
): monaco.IPosition | monaco.IRange | null {
  const k = key(scope, path)
  const r = pendingReveals.get(k)
  if (r === undefined) return null
  pendingReveals.delete(k)
  return r
}

/** Record the file `editor` (owned by `scope`) now shows — call after every successful load. */
export function setEditorLoadedPath(
  editor: monaco.editor.IStandaloneCodeEditor,
  scope: string,
  path: string,
): void {
  unregisterLoadedEditor(editor)
  const k = key(scope, path)
  loadedKeyByEditor.set(editor, k)
  let set = editorsByLoadedPath.get(k)
  if (!set) {
    set = new Set()
    editorsByLoadedPath.set(k, set)
  }
  set.add(editor)
}

export function unregisterLoadedEditor(editor: monaco.editor.IStandaloneCodeEditor): void {
  const prev = loadedKeyByEditor.get(editor)
  if (prev === undefined) return
  loadedKeyByEditor.delete(editor)
  const set = editorsByLoadedPath.get(prev)
  set?.delete(editor)
  if (set?.size === 0) editorsByLoadedPath.delete(prev)
}

/**
 * Reveal `target` in `path` in `scope`'s editor. Applied directly only when
 * `path` is the scope's active tab and one of ITS editors has it loaded;
 * otherwise queued for the scope and the file opened via `open` — the scope's
 * editor that loads it consumes the reveal. (Re-opening an already-active tab
 * never runs `loadFile`, which is why the direct path exists.)
 */
export function revealInEditor(
  scope: string,
  path: string,
  target: monaco.IPosition | monaco.IRange,
  opts: { isActiveTab: boolean; open: () => void },
): void {
  const k = key(scope, path)
  const editors = editorsByLoadedPath.get(k)
  if (opts.isActiveTab && editors && editors.size > 0) {
    for (const editor of editors) applyReveal(editor, target)
    return
  }
  pendingReveals.set(k, target)
  opts.open()
}

export function applyReveal(
  editor: monaco.editor.IStandaloneCodeEditor,
  target: monaco.IPosition | monaco.IRange,
): void {
  if ('startLineNumber' in target) {
    editor.setSelection(target)
    editor.revealRangeInCenter(target, monaco.editor.ScrollType.Immediate)
  } else {
    editor.setPosition(target)
    editor.revealPositionInCenter(target, monaco.editor.ScrollType.Immediate)
  }
  editor.focus()
}
