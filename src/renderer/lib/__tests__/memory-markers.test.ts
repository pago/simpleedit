import { describe, it, expect, afterEach } from 'vitest'
import * as monaco from 'monaco-editor'
import { setMemoryReport, clearMemoryMarkers } from '../memory-markers'
import type { MemoryHealthReport } from '../../../shared/memory-health'

const DIR = '/mem/project'

const report: MemoryHealthReport = {
  memoryDir: DIR,
  indexPresent: true,
  fileCount: 2,
  issues: [
    {
      kind: 'broken-link',
      rel: 'a.md',
      file: `${DIR}/a.md`,
      line: 2,
      column: 3,
      endColumn: 9,
      message: 'No memory named "x"',
    },
  ],
}

function markers(path: string): monaco.editor.IMarker[] {
  return monaco.editor.getModelMarkers({ owner: 'memory-health', resource: monaco.Uri.file(path) })
}

afterEach(() => {
  clearMemoryMarkers(DIR)
  monaco.editor.getModels().forEach((m) => m.dispose())
})

describe('memory markers', () => {
  it('marks open models and models created later', () => {
    monaco.editor.createModel('x\n  [[x]]\n', 'plaintext', monaco.Uri.file(`${DIR}/a.md`))
    setMemoryReport(report)
    expect(markers(`${DIR}/a.md`)).toMatchObject([
      { startLineNumber: 2, startColumn: 3, endColumn: 9, severity: monaco.MarkerSeverity.Warning },
    ])

    monaco.editor.getModel(monaco.Uri.file(`${DIR}/a.md`))!.dispose()
    monaco.editor.createModel('x\n  [[x]]\n', 'plaintext', monaco.Uri.file(`${DIR}/a.md`))
    expect(markers(`${DIR}/a.md`)).toHaveLength(1)
  })

  it('clears markers when the view releases the dir', () => {
    monaco.editor.createModel('x\n  [[x]]\n', 'plaintext', monaco.Uri.file(`${DIR}/a.md`))
    setMemoryReport(report)
    clearMemoryMarkers(DIR)
    expect(markers(`${DIR}/a.md`)).toHaveLength(0)
  })
})
