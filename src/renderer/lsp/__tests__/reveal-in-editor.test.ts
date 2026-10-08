import { describe, it, expect, afterEach, vi } from 'vitest'
import * as monaco from 'monaco-editor'
import {
  consumePendingReveal,
  revealInEditor,
  setEditorLoadedPath,
  unregisterLoadedEditor,
} from '../editor-opener'

const cleanups: Array<() => void> = []

function editorWith(path: string): monaco.editor.IStandaloneCodeEditor {
  const container = document.createElement('div')
  container.style.width = '400px'
  container.style.height = '200px'
  document.body.appendChild(container)
  const model = monaco.editor.createModel('a\nb\nc\n', 'plaintext', monaco.Uri.file(path))
  const editor = monaco.editor.create(container, { model, automaticLayout: false })
  cleanups.push(() => {
    unregisterLoadedEditor(editor)
    editor.getModel()?.dispose()
    editor.dispose()
    container.remove()
  })
  return editor
}

const RANGE = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 }

afterEach(async () => {
  // Let the editor's async work after a reveal (word highlight etc.) settle;
  // disposing mid-flight rejects it with an unhandled `Canceled`.
  await new Promise((r) => setTimeout(r, 100))
  for (const fn of cleanups.splice(0)) fn()
})

describe('revealInEditor', () => {
  it('applies directly to the editor that has the active tab loaded', () => {
    const editor = editorWith('/mem/a.md')
    setEditorLoadedPath(editor, '/mem/a.md')
    const open = vi.fn()

    revealInEditor('/mem/a.md', RANGE, { isActiveTab: true, open })

    expect(open).not.toHaveBeenCalled()
    expect(editor.getSelection()?.startLineNumber).toBe(2)
    expect(consumePendingReveal('/mem/a.md')).toBeNull()
  })

  it('queues and opens when the editor was reused for another file', () => {
    const editor = editorWith('/mem/a.md')
    setEditorLoadedPath(editor, '/mem/a.md')
    setEditorLoadedPath(editor, '/mem/b.md')
    const open = vi.fn()

    revealInEditor('/mem/a.md', RANGE, { isActiveTab: true, open })

    expect(open).toHaveBeenCalledOnce()
    expect(consumePendingReveal('/mem/a.md')).toEqual(RANGE)
  })

  it('queues and opens when the file is not the active tab', () => {
    const editor = editorWith('/mem/c.md')
    setEditorLoadedPath(editor, '/mem/c.md')
    const open = vi.fn()

    revealInEditor('/mem/c.md', RANGE, { isActiveTab: false, open })

    expect(open).toHaveBeenCalledOnce()
    expect(consumePendingReveal('/mem/c.md')).toEqual(RANGE)
  })
})
