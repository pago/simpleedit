import { render, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, afterEach } from 'vitest'
import '../../../lib/__tests__/ignore-monaco-cancellation'
import * as monaco from 'monaco-editor'
import PromptField from '../PromptField.svelte'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PromptField', () => {
  it('inserts the absolute paths of dropped files as plain text', async () => {
    vi.stubGlobal('api', { getPathForFile: (f: File) => `/abs/${f.name}`, invoke: vi.fn() })
    const onchange = vi.fn()
    const { container } = render(PromptField, { value: 'Look at ', onchange, label: 'Prompt' })
    await waitFor(() => expect(container.querySelector('.monaco-editor')).toBeTruthy())
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'a.ts'))
    data.items.add(new File(['y'], 'b.md'))
    const target = container.querySelector('.monaco-editor')!
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    await waitFor(() => expect(onchange).toHaveBeenLastCalledWith(expect.stringContaining('/abs/a.ts\n/abs/b.md')))
    expect(onchange.mock.lastCall?.[0]).not.toContain('@')
  })

  it('drops a drop whose paths resolve after the field is gone', async () => {
    let resolve!: (path: string) => void
    vi.stubGlobal('api', { getPathForFile: () => '', invoke: vi.fn(() => new Promise<string>((r) => (resolve = r))) })
    const edits: unknown[] = []
    const create = monaco.editor.create.bind(monaco.editor)
    vi.spyOn(monaco.editor, 'create').mockImplementation((...args) => {
      const editor = create(...args)
      const real = editor.executeEdits.bind(editor)
      editor.executeEdits = (...edit) => {
        edits.push(edit)
        return real(...edit)
      }
      return editor
    })
    const onchange = vi.fn()
    const { container, unmount } = render(PromptField, { value: '', onchange, label: 'Prompt' })
    await waitFor(() => expect(container.querySelector('.monaco-editor')).toBeTruthy())
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'pasted.png'))
    const target = container.querySelector('.monaco-editor')!
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    unmount()
    resolve('/tmp/pasted.png')
    await new Promise((r) => setTimeout(r, 20))
    expect(edits).toEqual([])
    expect(onchange).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
