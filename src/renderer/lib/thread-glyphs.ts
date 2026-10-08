import * as monaco from 'monaco-editor'
import { hasUnread, type AgentThread } from '../../shared/agent-threads'

/** An open thread's icon in an editor's glyph margin. */
export interface ThreadGlyph {
  threadId: string
  line: number
  endLine: number
  unread: boolean
  preview: string
}

/**
 * What an editor shows: a file's working copy (the file editor, and the
 * uncommitted diff's modified side), or a commit's version of it.
 */
export type GlyphView = { worktreePath: string; path: string; commit: string | null }

/**
 * The open threads anchored in `view`, as glyphs. `path` is relative to the
 * worktree. An orphaned thread keeps its old line, which now holds other code,
 * so it gets none.
 */
export function threadGlyphsFor(threads: AgentThread[], view: GlyphView): ThreadGlyph[] {
  const root = view.worktreePath.replace(/\/+$/, '')
  const out: ThreadGlyph[] = []
  for (const t of threads) {
    if (t.status !== 'open' || t.anchor.orphaned || t.worktreePath !== root || t.anchor.path !== view.path) continue
    const ctx = t.anchor.context
    const workingCopy = ctx === 'file' || ctx.commit === 'uncommitted'
    if (view.commit === null ? !workingCopy : ctx === 'file' || ctx.commit !== view.commit) continue
    const first = t.messages[0]?.body ?? ''
    out.push({ threadId: t.id, line: t.anchor.startLine, endLine: t.anchor.endLine, unread: hasUnread(t), preview: first })
  }
  return out
}

/**
 * Draws thread glyphs in `editor`'s glyph margin and reports clicks on them.
 * While the editor is commentable, hovering a line without a glyph shows a "+"
 * there that reports `oncomment`. The margin is shown only while there is a
 * glyph or a "+" to show, so other editors keep their width. Glyphs track
 * edits until the next `set`.
 */
export function attachThreadGlyphs(
  editor: monaco.editor.ICodeEditor,
  onopen: (threadId: string) => void,
  oncomment?: (line: number) => void,
): {
  set(glyphs: ThreadGlyph[]): void
  setCommentable(on: boolean): void
  /** Where a thread's glyph is now, after the edits since the last `set`. */
  lineOf(threadId: string): number | undefined
  dispose(): void
} {
  const collection = editor.createDecorationsCollection()
  const hover = editor.createDecorationsCollection()
  let current: ThreadGlyph[] = []
  let commentable = false

  function glyphAt(line: number | undefined): ThreadGlyph | undefined {
    const i = collection.getRanges().findIndex((r) => r.startLineNumber === line)
    return i >= 0 ? current[i] : undefined
  }

  function showAdd(line: number | null): void {
    if (line === null || !commentable || glyphAt(line)) {
      hover.clear()
      return
    }
    if (hover.getRange(0)?.startLineNumber === line) return
    hover.set([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { glyphMarginClassName: 'thread-glyph-add', glyphMarginHoverMessage: { value: 'Comment on this line (⌘⇧M)' } },
      },
    ])
  }

  const subs = [
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
      const line = e.target.position?.lineNumber
      const glyph = glyphAt(line)
      if (glyph) onopen(glyph.threadId)
      else if (line && commentable) oncomment?.(line)
    }),
    editor.onMouseMove((e) => {
      const t = e.target.type
      const overLine =
        t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        t === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS ||
        t === monaco.editor.MouseTargetType.CONTENT_TEXT ||
        t === monaco.editor.MouseTargetType.CONTENT_EMPTY
      showAdd(overLine ? (e.target.position?.lineNumber ?? null) : null)
    }),
    editor.onMouseLeave(() => showAdd(null)),
  ]

  function layoutMargin(): void {
    const on = current.length > 0 || commentable
    if (editor.getOption(monaco.editor.EditorOption.glyphMargin) !== on) editor.updateOptions({ glyphMargin: on })
  }

  return {
    set(glyphs) {
      const lines = editor.getModel()?.getLineCount() ?? 0
      current = glyphs.filter((g) => g.line >= 1 && g.line <= lines)
      layoutMargin()
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
      if (glyphAt(hover.getRange(0)?.startLineNumber)) hover.clear()
    },
    lineOf(threadId) {
      const i = current.findIndex((g) => g.threadId === threadId)
      return i >= 0 ? collection.getRange(i)?.startLineNumber : undefined
    },
    setCommentable(on) {
      commentable = on
      if (!on) hover.clear()
      layoutMargin()
    },
    dispose() {
      for (const s of subs) s.dispose()
      collection.clear()
      hover.clear()
    },
  }
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}
