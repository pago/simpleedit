import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as monaco from 'monaco-editor'
import { bindEditorOpener, consumePendingReveal } from '../editor-opener'

// We use `plaintext` (not `typescript`) for the test model so Monaco doesn't
// spin up the bundled TS language worker. The worker loads asynchronously
// via dynamic import and, when the editor is disposed before it finishes,
// throws unhandled `Canceled` / `toUrl` rejections — Vitest's browser
// runner flags those as test-suite failures even though every assertion
// passes. The opener wiring under test is language-agnostic.

/**
 * These tests exercise the *actual* Monaco "Go to Definition" code path —
 * `editor.action.revealDefinition` runs the same flow that F12 / Ctrl-click
 * trigger, including Monaco's `_codeEditorService.openCodeEditor` dispatch.
 * That's the layer where the bug lived: Monaco was either short-circuiting
 * to peek (multiple-definitions default) or returning null (single result,
 * URI not in the active editor's models) and never calling our opener.
 */

function createTestEditor(): {
  editor: monaco.editor.IStandaloneCodeEditor
  cleanup: () => void
} {
  const container = document.createElement('div')
  container.style.width = '600px'
  container.style.height = '400px'
  document.body.appendChild(container)
  const editor = monaco.editor.create(container, {
    value: '',
    language: 'plaintext',
    automaticLayout: false,
    // Same overrides as CodeEditor.svelte — without these, Monaco peeks
    // instead of navigating when the LSP returns 2+ locations.
    gotoLocation: {
      multipleDefinitions: 'goto',
      multipleDeclarations: 'goto',
      multipleTypeDefinitions: 'goto',
      multipleImplementations: 'goto',
      multipleReferences: 'peek',
    },
  })
  return {
    editor,
    cleanup: () => {
      editor.getModel()?.dispose()
      editor.dispose()
      container.remove()
    },
  }
}

/**
 * Monaco's `trigger()` is fire-and-forget but the gotoSymbol action is async
 * (provider call → openCodeEditor dispatch). Wait long enough for the queued
 * promises to resolve in the JS event loop before asserting.
 */
async function flushNavigation(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setSourceModel(
  editor: monaco.editor.IStandaloneCodeEditor,
  uri: monaco.Uri,
  contents: string,
): monaco.editor.ITextModel {
  const existing = monaco.editor.getModel(uri)
  if (existing) existing.dispose()
  const model = monaco.editor.createModel(contents, 'plaintext', uri)
  editor.setModel(model)
  return model
}

describe('editor-opener', () => {
  let providerDisposable: monaco.IDisposable | null = null
  let cleanupFns: Array<() => void> = []

  beforeEach(() => {
    providerDisposable = null
    cleanupFns = []
  })

  afterEach(() => {
    providerDisposable?.dispose()
    for (const fn of cleanupFns) fn()
    monaco.editor.getModels().forEach((m) => m.dispose())
  })

  it('routes a single cross-file definition through the bound handler', async () => {
    const { editor, cleanup } = createTestEditor()
    cleanupFns.push(cleanup)

    const sourceUri = monaco.Uri.file('/test/source.ts')
    const targetUri = monaco.Uri.file('/test/target.ts')
    setSourceModel(editor, sourceUri, 'foo()\n')

    providerDisposable = monaco.languages.registerDefinitionProvider('plaintext', {
      provideDefinition: () => [
        { uri: targetUri, range: new monaco.Range(3, 5, 3, 8) },
      ],
    })

    const handler = vi.fn()
    cleanupFns.push(bindEditorOpener(editor, handler))

    editor.setPosition({ lineNumber: 1, column: 2 })
    editor.trigger('test', 'editor.action.revealDefinition', null)
    await flushNavigation()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('/test/target.ts')

    const reveal = consumePendingReveal('/test/target.ts')
    expect(reveal).not.toBeNull()
    expect(reveal).toMatchObject({ startLineNumber: 3, startColumn: 5 })
  })

  it('still navigates instead of peeking when the LSP returns multiple locations', async () => {
    const { editor, cleanup } = createTestEditor()
    cleanupFns.push(cleanup)

    const sourceUri = monaco.Uri.file('/test/multi-source.ts')
    const targetA = monaco.Uri.file('/test/multi-a.ts')
    const targetB = monaco.Uri.file('/test/multi-b.ts')
    setSourceModel(editor, sourceUri, 'foo()\n')

    providerDisposable = monaco.languages.registerDefinitionProvider('plaintext', {
      provideDefinition: () => [
        { uri: targetA, range: new monaco.Range(1, 1, 1, 4) },
        { uri: targetB, range: new monaco.Range(2, 1, 2, 4) },
      ],
    })

    const handler = vi.fn()
    cleanupFns.push(bindEditorOpener(editor, handler))

    editor.setPosition({ lineNumber: 1, column: 2 })
    editor.trigger('test', 'editor.action.revealDefinition', null)
    await flushNavigation()

    // Monaco's default 'peek' behaviour would short-circuit and never call
    // openCodeEditor — this assertion is what fails before the gotoLocation
    // override in CodeEditor.svelte is applied.
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('/test/multi-a.ts')
  })

  it('does not invoke the handler when the definition lives in the current model', async () => {
    const { editor, cleanup } = createTestEditor()
    cleanupFns.push(cleanup)

    const sameFile = monaco.Uri.file('/test/local.ts')
    setSourceModel(editor, sameFile, 'function bar() {}\nbar()\n')

    providerDisposable = monaco.languages.registerDefinitionProvider('plaintext', {
      provideDefinition: () => [
        { uri: sameFile, range: new monaco.Range(1, 10, 1, 13) },
      ],
    })

    const handler = vi.fn()
    cleanupFns.push(bindEditorOpener(editor, handler))

    editor.setPosition({ lineNumber: 2, column: 2 })
    editor.trigger('test', 'editor.action.revealDefinition', null)
    await flushNavigation()

    // Monaco's standalone service handles same-model navigation itself; our
    // opener should never see this case.
    expect(handler).not.toHaveBeenCalled()
  })

  it('clears the pending reveal after one consumption', async () => {
    const { editor, cleanup } = createTestEditor()
    cleanupFns.push(cleanup)

    setSourceModel(editor, monaco.Uri.file('/test/once-source.ts'), 'foo()\n')
    const target = monaco.Uri.file('/test/once-target.ts')

    providerDisposable = monaco.languages.registerDefinitionProvider('plaintext', {
      provideDefinition: () => [
        { uri: target, range: new monaco.Range(7, 1, 7, 5) },
      ],
    })

    cleanupFns.push(bindEditorOpener(editor, () => {}))
    editor.setPosition({ lineNumber: 1, column: 2 })
    editor.trigger('test', 'editor.action.revealDefinition', null)
    await flushNavigation()

    expect(consumePendingReveal('/test/once-target.ts')).not.toBeNull()
    expect(consumePendingReveal('/test/once-target.ts')).toBeNull()
  })

  it('returns false (and does not throw) when no handler is bound for the source editor', async () => {
    const { editor, cleanup } = createTestEditor()
    cleanupFns.push(cleanup)

    setSourceModel(editor, monaco.Uri.file('/test/unbound.ts'), 'foo()\n')

    providerDisposable = monaco.languages.registerDefinitionProvider('plaintext', {
      provideDefinition: () => [
        { uri: monaco.Uri.file('/test/elsewhere.ts'), range: new monaco.Range(1, 1, 1, 4) },
      ],
    })

    // Deliberately *not* binding an opener handler. The action should still
    // dispatch cleanly; Monaco's standalone fallback returns null and the
    // navigation is silently dropped.
    editor.setPosition({ lineNumber: 1, column: 2 })
    expect(() => editor.trigger('test', 'editor.action.revealDefinition', null)).not.toThrow()
    await flushNavigation()
  })
})
