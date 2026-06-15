<script lang="ts">
  import * as monaco from 'monaco-editor'
  import CodeEditor from './CodeEditor.svelte'
  import MarkdownPreview from './MarkdownPreview.svelte'
  import { markdownViewStore } from '../../stores/markdownView.svelte'
  import type { AgentContext } from '../../lib/agent-message'

  interface Props {
    filePath: string
    worktreeRoot: string | null
    onModified?: (path: string, modified: boolean) => void
    ondiscusswithagent?: (ctx: AgentContext, pos: { x: number; y: number }) => void
    onOpenFile?: (path: string) => void
  }

  let { filePath, worktreeRoot, onModified, ondiscusswithagent, onOpenFile }: Props = $props()

  const viewMode = $derived(markdownViewStore.get(filePath))

  // The CodeEditor stays mounted in every mode (just hidden in `rendered`), so
  // it is always the single source of truth for the preview text and unsaved
  // edits survive every mode switch — Monaco disposes its model on unmount, so
  // unmounting the editor would reload from disk and drop in-flight edits.
  let content = $state('')
  let editor: monaco.editor.IStandaloneCodeEditor | undefined = $state()
  let previewEl: HTMLElement | null = $state(null)

  function onEditorContent(value: string): void {
    content = value
  }

  // ── Hybrid split ──────────────────────────────────────────
  let splitPct = $state(50)
  let row: HTMLDivElement | undefined = $state()
  let resizing = $state(false)

  function startResize(): void {
    if (!row) return
    resizing = true
    const rect = row.getBoundingClientRect()
    function move(e: MouseEvent): void {
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      splitPct = Math.max(20, Math.min(80, pct))
    }
    function up(): void {
      resizing = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // ── Scroll sync (hybrid) ──────────────────────────────────
  function anchorList(pv: HTMLElement): { el: HTMLElement; line: number }[] {
    return Array.from(pv.querySelectorAll<HTMLElement>('[data-source-line]'))
      .map((el) => ({ el, line: parseInt(el.getAttribute('data-source-line') ?? '1', 10) }))
      .filter((a) => Number.isFinite(a.line))
      .sort((a, b) => a.line - b.line)
  }

  function offsetTopWithin(el: HTMLElement, pv: HTMLElement): number {
    return el.getBoundingClientRect().top - pv.getBoundingClientRect().top + pv.scrollTop
  }

  function syncPreviewToEditor(ed: monaco.editor.IStandaloneCodeEditor, pv: HTMLElement): void {
    const list = anchorList(pv)
    if (!list.length) return
    const visible = ed.getVisibleRanges()
    const topLine = visible.length ? visible[0].startLineNumber : 1
    let loIdx = 0
    for (let i = 0; i < list.length; i++) {
      if (list[i].line <= topLine) loIdx = i
      else break
    }
    const lo = list[loIdx]
    const hi = list[loIdx + 1]
    let target = offsetTopWithin(lo.el, pv)
    if (hi && hi.line > lo.line) {
      const frac = clamp01((topLine - lo.line) / (hi.line - lo.line))
      target += (offsetTopWithin(hi.el, pv) - target) * frac
    }
    pv.scrollTop = target
  }

  function syncEditorToPreview(ed: monaco.editor.IStandaloneCodeEditor, pv: HTMLElement): void {
    const list = anchorList(pv)
    if (!list.length) return
    const pvTop = pv.getBoundingClientRect().top
    let loIdx = 0
    for (let i = 0; i < list.length; i++) {
      if (list[i].el.getBoundingClientRect().top - pvTop <= 1) loIdx = i
      else break
    }
    const lo = list[loIdx]
    const hi = list[loIdx + 1]
    let target = ed.getTopForLineNumber(lo.line)
    if (hi) {
      const loRt = lo.el.getBoundingClientRect().top - pvTop
      const hiRt = hi.el.getBoundingClientRect().top - pvTop
      if (hiRt > loRt) {
        const frac = clamp01((0 - loRt) / (hiRt - loRt))
        target += (ed.getTopForLineNumber(hi.line) - target) * frac
      }
    }
    ed.setScrollTop(target)
  }

  function clamp01(n: number): number {
    return Math.max(0, Math.min(1, n))
  }

  $effect(() => {
    if (viewMode !== 'hybrid') return
    const ed = editor
    const pv = previewEl
    if (!ed || !pv) return
    let syncing = false
    const release = (): void => {
      requestAnimationFrame(() => {
        syncing = false
      })
    }
    const edScroll = ed.onDidScrollChange(() => {
      if (syncing) return
      syncing = true
      syncPreviewToEditor(ed, pv)
      release()
    })
    const onPvScroll = (): void => {
      if (syncing) return
      syncing = true
      syncEditorToPreview(ed, pv)
      release()
    }
    pv.addEventListener('scroll', onPvScroll, { passive: true })
    return () => {
      edScroll.dispose()
      pv.removeEventListener('scroll', onPvScroll)
    }
  })
</script>

<div bind:this={row} class="flex h-full min-h-0" class:select-none={resizing}>
  <!-- Editor: always mounted (hidden in rendered mode) so it stays the source
       of truth and unsaved edits survive mode switches. -->
  <div
    class="min-w-0 overflow-hidden"
    class:hidden={viewMode === 'rendered'}
    style:width={viewMode === 'hybrid' ? `${splitPct}%` : '100%'}
    style:flex={viewMode === 'hybrid' ? 'none' : '1'}
  >
    <CodeEditor
      {filePath}
      worktreeRoot={worktreeRoot}
      {onModified}
      {ondiscusswithagent}
      {onOpenFile}
      oncontentchange={onEditorContent}
      oneditorready={(e) => (editor = e)}
    />
  </div>

  {#if viewMode === 'hybrid'}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="w-1 flex-none cursor-col-resize bg-zinc-800 transition-colors hover:bg-blue-500"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      onmousedown={startResize}
    ></div>
  {/if}

  {#if viewMode !== 'raw'}
    <div class="min-w-0 flex-1">
      <MarkdownPreview
        source={content}
        {filePath}
        {worktreeRoot}
        {onOpenFile}
        onScrollElement={(el) => (previewEl = el)}
      />
    </div>
  {/if}
</div>
