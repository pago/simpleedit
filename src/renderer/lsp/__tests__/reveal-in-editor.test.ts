import { describe, it, expect, afterEach, vi } from 'vitest'
import type * as monaco from 'monaco-editor'
import {
  consumePendingReveal,
  revealInEditor,
  setEditorLoadedPath,
  unregisterLoadedEditor,
} from '../editor-opener'

const editors: monaco.editor.IStandaloneCodeEditor[] = []

/**
 * Only the calls `applyReveal` makes. A real Monaco editor keeps async work
 * running after a reveal (word highlight, …) that rejects with `Canceled`
 * when disposed mid-flight, and nothing here needs one.
 */
function fakeEditor(): monaco.editor.IStandaloneCodeEditor & { setSelection: ReturnType<typeof vi.fn> } {
  const editor = {
    setSelection: vi.fn(),
    setPosition: vi.fn(),
    revealRangeInCenter: vi.fn(),
    revealPositionInCenter: vi.fn(),
    focus: vi.fn(),
  }
  const typed = editor as unknown as monaco.editor.IStandaloneCodeEditor & { setSelection: ReturnType<typeof vi.fn> }
  editors.push(typed)
  return typed
}

const RANGE = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 }

afterEach(() => {
  for (const editor of editors.splice(0)) unregisterLoadedEditor(editor)
  for (const scope of ['s', 'other']) {
    for (const path of ['/mem/a.md', '/mem/b.md', '/mem/c.md']) consumePendingReveal(scope, path)
  }
})

describe('revealInEditor', () => {
  it('applies directly to the editor that has the active tab loaded', () => {
    const editor = fakeEditor()
    setEditorLoadedPath(editor, 's', '/mem/a.md')
    const open = vi.fn()

    revealInEditor('s', '/mem/a.md', RANGE, { isActiveTab: true, open })

    expect(open).not.toHaveBeenCalled()
    expect(editor.setSelection).toHaveBeenCalledWith(RANGE)
    expect(consumePendingReveal('s', '/mem/a.md')).toBeNull()
  })

  it('queues and opens when the editor was reused for another file', () => {
    const editor = fakeEditor()
    setEditorLoadedPath(editor, 's', '/mem/a.md')
    setEditorLoadedPath(editor, 's', '/mem/b.md')
    const open = vi.fn()

    revealInEditor('s', '/mem/a.md', RANGE, { isActiveTab: true, open })

    expect(open).toHaveBeenCalledOnce()
    expect(editor.setSelection).not.toHaveBeenCalled()
    expect(consumePendingReveal('s', '/mem/a.md')).toEqual(RANGE)
  })

  it('queues and opens when the file is not the active tab', () => {
    const editor = fakeEditor()
    setEditorLoadedPath(editor, 's', '/mem/c.md')
    const open = vi.fn()

    revealInEditor('s', '/mem/c.md', RANGE, { isActiveTab: false, open })

    expect(open).toHaveBeenCalledOnce()
    expect(consumePendingReveal('s', '/mem/c.md')).toEqual(RANGE)
  })

  it("never reveals in another session's editor, and only this session's editor consumes the reveal", () => {
    const hidden = fakeEditor()
    setEditorLoadedPath(hidden, 'other', '/mem/a.md')
    const open = vi.fn()

    // This session's tab is active but its own editor is still loading.
    revealInEditor('s', '/mem/a.md', RANGE, { isActiveTab: true, open })

    expect(hidden.setSelection).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledOnce()
    expect(consumePendingReveal('other', '/mem/a.md')).toBeNull()
    expect(consumePendingReveal('s', '/mem/a.md')).toEqual(RANGE)
  })
})
