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

const handlersByEditor = new WeakMap<monaco.editor.ICodeEditor, OpenHandler>()
const pendingRevealsByPath = new Map<string, monaco.IPosition | monaco.IRange>()

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

      const handler = handlersByEditor.get(source)
      if (!handler) return false
      if (resource.scheme !== 'file') return false
      const path = resource.fsPath
      if (selectionOrPosition) {
        pendingRevealsByPath.set(path, selectionOrPosition)
      }
      handler(path)
      return true
    },
  })
}

export function bindEditorOpener(
  editor: monaco.editor.ICodeEditor,
  handler: OpenHandler,
): () => void {
  ensureOpenerRegistered()
  handlersByEditor.set(editor, handler)
  return () => {
    handlersByEditor.delete(editor)
  }
}

export function consumePendingReveal(
  path: string,
): monaco.IPosition | monaco.IRange | null {
  const r = pendingRevealsByPath.get(path)
  if (r === undefined) return null
  pendingRevealsByPath.delete(path)
  return r
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
