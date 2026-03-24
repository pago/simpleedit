<script lang="ts">
  import * as monaco from 'monaco-editor'
  import type { AgentContext } from '../../lib/agent-message'

  interface Props {
    originalContent: string
    modifiedContent: string
    filePath: string
    /** If true, show inline (unified) diff. Otherwise side-by-side. */
    inline?: boolean
    /** Line range [start, end] to highlight in the modified editor. */
    highlightLines?: [number, number]
    ondiscusswithagent?: (ctx: AgentContext, pos: { x: number; y: number }) => void
  }

  let { originalContent, modifiedContent, filePath, inline = true, highlightLines, ondiscusswithagent }: Props = $props()

  // Mutable refs so action closures always read the latest prop values.
  // Declared as $state so Svelte treats the assignment in $effect as intentional.
  let latestFilePath = $state(filePath)
  let latestOnDiscuss = $state(ondiscusswithagent)
  $effect(() => { latestFilePath = filePath })
  $effect(() => { latestOnDiscuss = ondiscusswithagent })

  let container: HTMLDivElement | undefined = $state()
  let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined

  const extensionToLanguage: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.json': 'json', '.html': 'html', '.css': 'css',
    '.scss': 'scss', '.md': 'markdown', '.svelte': 'html',
    '.py': 'python', '.rs': 'rust', '.go': 'go',
    '.sh': 'shell', '.yaml': 'yaml', '.yml': 'yaml',
    '.xml': 'xml', '.sql': 'sql', '.toml': 'ini'
  }

  function getLanguage(path: string): string {
    const dot = path.lastIndexOf('.')
    if (dot === -1) return 'plaintext'
    return extensionToLanguage[path.slice(dot).toLowerCase()] ?? 'plaintext'
  }

  $effect(() => {
    if (!container) return

    const language = getLanguage(filePath)

    diffEditor = monaco.editor.createDiffEditor(container, {
      theme: 'vs-dark',
      readOnly: true,
      renderSideBySide: !inline,
      automaticLayout: true,
      fontSize: 13,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      renderOverviewRuler: false
    })

    const originalModel = monaco.editor.createModel(originalContent, language)
    const modifiedModel = monaco.editor.createModel(modifiedContent, language)

    diffEditor.setModel({ original: originalModel, modified: modifiedModel })

    function registerDiscussAction(
      ed: monaco.editor.IStandaloneCodeEditor,
      side: 'original' | 'modified',
    ): void {
      ed.addAction({
        id: `discuss-with-agent-${side}`,
        label: 'Discuss with Agent',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.5,
        run(e) {
          const selection = e.getSelection()
          const model = e.getModel()
          if (!selection || !model || !container) return
          const selectedText = model.getValueInRange(selection)
          const pixelPos = e.getScrolledVisiblePosition({
            lineNumber: selection.startLineNumber,
            column: selection.startColumn,
          })
          if (!pixelPos) return
          const rect = container.getBoundingClientRect()
          latestOnDiscuss?.(
            {
              kind: 'diff',
              filePath: latestFilePath,
              commitHash: null, // enriched by DiffReview
              side,
              selectedText,
              lineRange: [selection.startLineNumber, selection.endLineNumber],
            },
            { x: rect.left + pixelPos.left, y: rect.top + pixelPos.top + pixelPos.height },
          )
        },
      })
    }

    registerDiscussAction(diffEditor.getOriginalEditor(), 'original')
    registerDiscussAction(diffEditor.getModifiedEditor(), 'modified')

    return () => {
      originalModel.dispose()
      modifiedModel.dispose()
      diffEditor?.dispose()
      diffEditor = undefined
    }
  })

  // Apply line highlight decoration when a review finding is navigated to
  $effect(() => {
    if (!diffEditor || !highlightLines) return
    const [start, end] = highlightLines
    const modifiedEditor = diffEditor.getModifiedEditor()
    const decorations = modifiedEditor.createDecorationsCollection([
      {
        range: new monaco.Range(start, 1, end, Number.MAX_SAFE_INTEGER),
        options: {
          isWholeLine: true,
          className: 'review-finding-highlight',
          overviewRuler: { color: 'rgba(234, 179, 8, 0.6)', position: monaco.editor.OverviewRulerLane.Right },
        },
      },
    ])
    modifiedEditor.revealLineInCenter(start, monaco.editor.ScrollType.Smooth)
    return () => decorations.clear()
  })

  // Update models when content changes (e.g. navigating between files or live refresh)
  $effect(() => {
    if (!diffEditor) return
    const current = diffEditor.getModel()
    if (current) {
      const language = getLanguage(filePath)
      monaco.editor.setModelLanguage(current.original, language)
      monaco.editor.setModelLanguage(current.modified, language)
      current.original.setValue(originalContent)
      // Preserve scroll position so live file updates don't jump the view
      const modifiedEditor = diffEditor.getModifiedEditor()
      const scrollTop = modifiedEditor.getScrollTop()
      const scrollLeft = modifiedEditor.getScrollLeft()
      current.modified.setValue(modifiedContent)
      modifiedEditor.setScrollPosition({ scrollTop, scrollLeft })
    }
  })
</script>

<div class="h-full w-full" bind:this={container}></div>
