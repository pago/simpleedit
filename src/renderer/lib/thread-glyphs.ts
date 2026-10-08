import * as monaco from 'monaco-editor'
import { hasUnread, type AgentThread } from '../../shared/agent-threads'

/** An open thread's icon in an editor's glyph margin. */
export interface ThreadGlyph {
  threadId: string
  line: number
  unread: boolean
  preview: string
}

/**
 * What an editor shows: a file's working copy (the file editor, and the
 * uncommitted diff's modified side), or a commit's version of it.
 */
export type GlyphView = { worktreePath: string; path: string; commit: string | null }

/** The open threads anchored in `view`, as glyphs. `path` is relative to the worktree. */
export function threadGlyphsFor(threads: AgentThread[], view: GlyphView): ThreadGlyph[] {
  const root = view.worktreePath.replace(/\/+$/, '')
  const out: ThreadGlyph[] = []
  for (const t of threads) {
    if (t.status !== 'open' || t.worktreePath !== root || t.anchor.path !== view.path) continue
    const ctx = t.anchor.context
    const workingCopy = ctx === 'file' || ctx.commit === 'uncommitted'
    if (view.commit === null ? !workingCopy : ctx === 'file' || ctx.commit !== view.commit) continue
    const first = t.messages[0]?.body ?? ''
    out.push({ threadId: t.id, line: t.anchor.startLine, unread: hasUnread(t), preview: first })
  }
  return out
}

/**
 * Draws thread glyphs in `editor`'s glyph margin and reports clicks on them.
 * The margin is shown only while there is a glyph, so editors without threads
 * keep their width. Glyphs track edits until the next `set`.
 */
export function attachThreadGlyphs(
  editor: monaco.editor.ICodeEditor,
  onopen: (threadId: string) => void,
): { set(glyphs: ThreadGlyph[]): void; dispose(): void } {
  const collection = editor.createDecorationsCollection()
  let current: ThreadGlyph[] = []

  const sub = editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
    const line = e.target.position?.lineNumber
    const ranges = collection.getRanges()
    const i = ranges.findIndex((r) => r.startLineNumber === line)
    const glyph = i >= 0 ? current[i] : undefined
    if (glyph) onopen(glyph.threadId)
  })

  return {
    set(glyphs) {
      const lines = editor.getModel()?.getLineCount() ?? 0
      current = glyphs.filter((g) => g.line >= 1 && g.line <= lines)
      editor.updateOptions({ glyphMargin: current.length > 0 })
      collection.set(
        current.map((g) => ({
          range: new monaco.Range(g.line, 1, g.line, 1),
          options: {
            glyphMarginClassName: `thread-glyph${g.unread ? ' thread-glyph-unread' : ''}`,
            glyphMarginHoverMessage: { value: g.unread ? `New reply · ${clip(g.preview)}` : clip(g.preview) },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        })),
      )
    },
    dispose() {
      sub.dispose()
      collection.clear()
    },
  }
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}
