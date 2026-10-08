import * as monaco from 'monaco-editor'
import { describe, it, expect, afterEach } from 'vitest'
import { attachThreadGlyphs, threadGlyphsFor } from '../thread-glyphs'
import type { AgentThread, ThreadAnchor } from '../../../shared/agent-threads'

function thread(id: string, anchor: Partial<ThreadAnchor>, over: Partial<AgentThread> = {}): AgentThread {
  return {
    id,
    sessionId: 's1',
    worktreePath: '/wt',
    anchor: { path: 'src/a.ts', startLine: 2, endLine: 2, snippet: '', before: '', after: '', context: 'file', ...anchor },
    status: 'open',
    messages: [{ id: 'm1', author: 'user', body: 'Why is this async?', at: '2026-10-08T10:00:00.000Z', delivery: 'delivered' }],
    lastReadAt: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    ...over,
  }
}

const threads = [
  thread('t_file', {}),
  thread('t_uncommitted', { startLine: 4, context: { commit: 'uncommitted' } }),
  thread('t_commit', { startLine: 6, context: { commit: 'abc1234' } }),
  thread('t_resolved', { startLine: 8 }, { status: 'resolved' }),
  thread('t_other_file', { path: 'src/b.ts' }),
  thread('t_other_tree', {}, { worktreePath: '/other' }),
]

describe('threadGlyphsFor', () => {
  it("shows a working copy's open threads, whether started in the file or the uncommitted diff", () => {
    expect(threadGlyphsFor(threads, { worktreePath: '/wt/', path: 'src/a.ts', commit: null }).map((g) => g.threadId)).toEqual([
      't_file',
      't_uncommitted',
    ])
  })

  it('skips an orphaned thread: its old line now holds other code', () => {
    const orphan = thread('t_orphan', { orphaned: true })
    expect(threadGlyphsFor([orphan], { worktreePath: '/wt', path: 'src/a.ts', commit: null })).toEqual([])
  })

  it("shows a commit's threads only in that commit's diff", () => {
    expect(threadGlyphsFor(threads, { worktreePath: '/wt', path: 'src/a.ts', commit: 'abc1234' }).map((g) => g.threadId)).toEqual([
      't_commit',
    ])
    expect(threadGlyphsFor(threads, { worktreePath: '/wt', path: 'src/a.ts', commit: 'def5678' })).toEqual([])
  })
})

describe('attachThreadGlyphs', () => {
  let editor: monaco.editor.IStandaloneCodeEditor | undefined
  afterEach(() => {
    editor?.getModel()?.dispose()
    editor?.dispose()
    document.body.innerHTML = ''
  })

  it('shows the glyph margin only while there are glyphs, and marks unread ones', async () => {
    const host = document.createElement('div')
    host.style.cssText = 'width: 400px; height: 200px'
    document.body.append(host)
    editor = monaco.editor.create(host, { value: 'a\nb\nc', glyphMargin: false })
    const glyphs = attachThreadGlyphs(editor, () => {})

    glyphs.set([
      { threadId: 't1', line: 2, endLine: 2, unread: true, preview: 'hi' },
      { threadId: 't2', line: 99, endLine: 99, unread: false, preview: 'past the end' },
    ])
    expect(editor.getOption(monaco.editor.EditorOption.glyphMargin)).toBe(true)
    await new Promise((r) => requestAnimationFrame(r))
    expect(host.querySelectorAll('.thread-glyph')).toHaveLength(1)
    expect(host.querySelector('.thread-glyph-unread')).not.toBeNull()

    glyphs.set([])
    expect(editor.getOption(monaco.editor.EditorOption.glyphMargin)).toBe(false)
    glyphs.dispose()
  })
})
