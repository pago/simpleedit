<script lang="ts">
  import * as monaco from 'monaco-editor'

  interface Props {
    originalContent: string
    modifiedContent: string
    filePath: string
    /** If true, show inline (unified) diff. Otherwise side-by-side. */
    inline?: boolean
  }

  let { originalContent, modifiedContent, filePath, inline = true }: Props = $props()

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

    return () => {
      originalModel.dispose()
      modifiedModel.dispose()
      diffEditor?.dispose()
      diffEditor = undefined
    }
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
