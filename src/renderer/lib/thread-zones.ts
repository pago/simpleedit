import * as monaco from 'monaco-editor'
import { mount, unmount } from 'svelte'
import type { ThreadAnchor } from '../../shared/agent-threads'
import InlineComposer from '../components/threads/InlineComposer.svelte'
import InlineThread from '../components/threads/InlineThread.svelte'
import { agentThreadsStore } from '../stores/agentThreads.svelte'
import { anchorLines, type AnchorLines } from './thread-anchor'
import { attachThreadGlyphs, type ThreadGlyph } from './thread-glyphs'
import { anchorLabel } from './thread-labels'

/** What an editor needs to show a session's threads inline and start new ones. */
export interface ThreadHost {
  /** The session whose threads these are; a new thread belongs to it. */
  sessionId: string
  /** Where a new thread on `lines` anchors, or null when this view can't take one. */
  anchorFor(lines: AnchorLines): { worktreePath: string; anchor: ThreadAnchor } | null
}

/** Estimated until the content is measured: a zone of height 0 is never shown, so never measured. */
const INITIAL_HEIGHT = 120

interface Zone {
  line: number
  move(line: number): void
  dispose(): void
}

/**
 * A view zone under `line` hosting a Svelte component. Its height follows the
 * content. Keys typed in it stay out of Monaco, whose keybindings listen on
 * the editor's container (⌘I, ⌘S, this module's ⌘⇧M). It is pinned to the
 * visible width, not the scroll width, so long lines don't stretch it.
 */
function svelteZone(
  editor: monaco.editor.ICodeEditor,
  line: number,
  render: (target: HTMLElement) => Record<string, unknown>,
): Zone {
  const domNode = document.createElement('div')
  domNode.className = 'thread-zone'
  const inner = document.createElement('div')
  domNode.append(inner)
  for (const type of ['keydown', 'keyup', 'keypress'] as const) domNode.addEventListener(type, (e) => e.stopPropagation())

  const zone: monaco.editor.IViewZone = { afterLineNumber: line, heightInPx: INITIAL_HEIGHT, domNode }
  let id = ''
  editor.changeViewZones((a) => {
    id = a.addZone(zone)
  })
  // Lays the zone out now rather than next frame, so a composer can take focus as it mounts.
  editor.render(true)
  const instance = render(inner)

  // Monaco hides a zone out of view (display: none), which measures 0; keep the last real height.
  const fit = (): void => {
    const h = inner.offsetHeight
    if (!h || h === zone.heightInPx) return
    zone.heightInPx = h
    editor.changeViewZones((a) => a.layoutZone(id))
  }
  const ro = new ResizeObserver(fit)
  ro.observe(inner)
  const width = (): void => {
    const l = editor.getLayoutInfo()
    inner.style.width = `${Math.max(0, l.contentWidth - l.verticalScrollbarWidth)}px`
  }
  const scroll = (): void => {
    inner.style.transform = `translateX(${editor.getScrollLeft()}px)`
  }
  width()
  scroll()
  const subs = [editor.onDidLayoutChange(width), editor.onDidScrollChange(scroll)]

  return {
    get line() {
      return zone.afterLineNumber
    },
    move(next) {
      zone.afterLineNumber = next
      editor.changeViewZones((a) => a.layoutZone(id))
    },
    dispose() {
      ro.disconnect()
      for (const s of subs) s.dispose()
      void unmount(instance)
      editor.changeViewZones((a) => a.removeZone(id))
    },
  }
}

/**
 * Threads in an editor: glyphs for open threads, which toggle the thread in a
 * view zone under its anchor, and a "+" (or `⌘⇧M`, "Comment on line…") that
 * opens a composer under the line or selection. `host` is read on every use,
 * so it can follow props; returning null turns commenting off.
 *
 * Zones go when their thread stops being in `set` (resolved, removed, another
 * file), when the editor's model changes, and on `reset` and `dispose`.
 */
export function attachEditorThreads(
  editor: monaco.editor.IStandaloneCodeEditor,
  host: () => ThreadHost | null,
): { set(glyphs: ThreadGlyph[]): void; open(threadId: string): boolean; comment(): void; reset(): void; dispose(): void } {
  const open = new Map<string, Zone>()
  let composer: Zone | null = null
  let current: ThreadGlyph[] = []
  /** A thread just started here, shown once its glyph arrives. */
  let pending: string | null = null

  const glyphs = attachThreadGlyphs(editor, toggle, (line) => compose(line))
  const canComment = editor.createContextKey<boolean>('simpleeditThreadCommentable', false)

  function zoneLine(g: ThreadGlyph): number {
    const count = editor.getModel()?.getLineCount() ?? 1
    return Math.min(Math.max(g.endLine, g.line), count)
  }

  function close(threadId: string): void {
    open.get(threadId)?.dispose()
    open.delete(threadId)
  }

  function closeAndFocus(threadId: string): void {
    close(threadId)
    editor.focus()
  }

  function show(threadId: string): void {
    const g = current.find((x) => x.threadId === threadId)
    if (!g || open.has(threadId)) return
    open.set(
      threadId,
      svelteZone(editor, zoneLine(g), (target) =>
        mount(InlineThread, {
          target,
          props: {
            threadId,
            onclose: () => closeAndFocus(threadId),
            onreveal: () => {
              const h = host()
              if (h) agentThreadsStore.reveal(h.sessionId, threadId)
            },
          },
        }),
      ),
    )
  }

  function toggle(threadId: string): void {
    if (open.has(threadId)) close(threadId)
    else show(threadId)
  }

  function closeComposer(): void {
    composer?.dispose()
    composer = null
  }

  function commentable(): boolean {
    const model = editor.getModel()
    if (!model) return false
    return host()?.anchorFor(anchorLines(model, { startLineNumber: 1, endLineNumber: 1, endColumn: 1 })) != null
  }

  /** Opens the composer on `line`, or on the selection when it covers `line` (or no line is given). */
  function compose(line?: number): void {
    const model = editor.getModel()
    const h = host()
    if (!model || !h) return
    const sel = editor.getSelection()
    const useSelection = sel && (line === undefined || (!sel.isEmpty() && line >= sel.startLineNumber && line <= sel.endLineNumber))
    const lines = anchorLines(
      model,
      useSelection ? sel : { startLineNumber: line ?? 1, endLineNumber: line ?? 1, endColumn: 1 },
    )
    const target = h.anchorFor(lines)
    if (!target) return
    closeComposer()
    const sessionId = h.sessionId
    composer = svelteZone(editor, lines.endLine, (el) =>
      mount(InlineComposer, {
        target: el,
        props: {
          label: anchorLabel(target.anchor),
          onsubmit: async (body: string) => {
            const id = await agentThreadsStore.create({ sessionId, ...target, body }, { reveal: false })
            closeComposer()
            pending = id
            show(id)
            if (open.has(id)) pending = null
          },
          oncancel: () => {
            closeComposer()
            editor.focus()
          },
        },
      }),
    )
  }

  function reset(): void {
    for (const id of [...open.keys()]) close(id)
    closeComposer()
    pending = null
  }

  const subs = [
    editor.onDidChangeModel(reset),
    editor.addAction({
      id: 'comment-on-line',
      label: 'Comment on line…',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.6,
      precondition: 'simpleeditThreadCommentable',
      run: () => compose(),
    }),
    editor.onDidDispose(() => reset()),
  ]

  return {
    set(next) {
      current = next
      glyphs.set(next)
      const on = commentable()
      glyphs.setCommentable(on)
      canComment.set(on)
      for (const [id, zone] of [...open]) {
        const g = next.find((x) => x.threadId === id)
        if (!g) close(id)
        else if (zoneLine(g) !== zone.line) zone.move(zoneLine(g))
      }
      if (pending && next.some((g) => g.threadId === pending)) {
        show(pending)
        pending = null
      }
    },
    /** Shows a thread that has a glyph here, scrolled into view. False when it has none. */
    open(threadId) {
      const g = current.find((x) => x.threadId === threadId)
      if (!g) return false
      show(threadId)
      editor.revealLineInCenterIfOutsideViewport(zoneLine(g))
      return true
    },
    comment: () => compose(),
    reset,
    dispose() {
      reset()
      for (const s of subs) s.dispose()
      glyphs.dispose()
    },
  }
}
