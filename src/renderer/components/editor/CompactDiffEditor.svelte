<script lang="ts">
  import * as monaco from 'monaco-editor'
  import { getLanguage } from '../../lib/monaco-utils'

  interface Props {
    originalContent: string
    modifiedContent: string
    filePath: string
    lineRange: [number, number]
  }

  let { originalContent, modifiedContent, filePath, lineRange }: Props = $props()

  let container: HTMLDivElement | undefined = $state()

  const LINE_HEIGHT = 19
  const CONTEXT_LINES = 3
  const MAX_VISIBLE_LINES = 30

  const visibleLines = $derived(
    Math.min(lineRange[1] - lineRange[0] + 1 + CONTEXT_LINES * 2, MAX_VISIBLE_LINES)
  )

  $effect(() => {
    if (!container) return

    const language = getLanguage(filePath)

    const diffEditor = monaco.editor.createDiffEditor(container, {
      theme: 'vs-dark',
      readOnly: true,
      renderSideBySide: false,
      automaticLayout: true,
      fontSize: 12,
      lineHeight: LINE_HEIGHT,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      renderOverviewRuler: false,
      folding: false,
      lineNumbers: 'on',
      lineDecorationsWidth: 0,
      glyphMargin: false,
      scrollbar: { vertical: 'auto', horizontal: 'auto' },
    })

    const originalModel = monaco.editor.createModel(originalContent, language)
    const modifiedModel = monaco.editor.createModel(modifiedContent, language)

    diffEditor.setModel({ original: originalModel, modified: modifiedModel })

    // Scroll to the relevant line range after the editor renders
    requestAnimationFrame(() => {
      const modifiedEditor = diffEditor.getModifiedEditor()
      modifiedEditor.revealLineInCenter(lineRange[0], monaco.editor.ScrollType.Immediate)
    })

    return () => {
      originalModel.dispose()
      modifiedModel.dispose()
      diffEditor.dispose()
    }
  })
</script>

<div
  class="overflow-hidden rounded border border-zinc-700/50 bg-zinc-900"
  style:height="{visibleLines * LINE_HEIGHT + 8}px"
  bind:this={container}
></div>
