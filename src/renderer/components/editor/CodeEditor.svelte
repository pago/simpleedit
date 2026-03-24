<script lang="ts">
  import * as monaco from 'monaco-editor'
  import type { AgentContext } from '../../lib/agent-message'

  interface Props {
    filePath: string | null
    onModified?: (path: string, modified: boolean) => void
    ondiscusswithagent?: (ctx: AgentContext, pos: { x: number; y: number }) => void
  }

  let { filePath, onModified, ondiscusswithagent }: Props = $props()

  // Mutable refs so action closures always read the latest prop values
  let latestFilePath = filePath
  let latestOnDiscuss = ondiscusswithagent
  $effect(() => { latestFilePath = filePath })
  $effect(() => { latestOnDiscuss = ondiscusswithagent })

  let container: HTMLDivElement | undefined = $state()
  let editor: monaco.editor.IStandaloneCodeEditor | undefined
  let currentFilePath: string | null = null
  let isLoadingFile = false

  const extensionToLanguage: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.json': 'json',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less',
    '.md': 'markdown',
    '.svelte': 'html',
    '.vue': 'html',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.sql': 'sql',
    '.graphql': 'graphql',
    '.toml': 'ini',
    '.env': 'ini'
  }

  function getLanguage(path: string): string {
    const dot = path.lastIndexOf('.')
    if (dot === -1) return 'plaintext'
    const ext = path.slice(dot).toLowerCase()
    return extensionToLanguage[ext] ?? 'plaintext'
  }

  async function loadFile(path: string): Promise<void> {
    if (!editor) return
    try {
      const content = await window.api.invoke('editor:open', path)
      const language = getLanguage(path)
      const model = editor.getModel()
      if (model) {
        monaco.editor.setModelLanguage(model, language)
        isLoadingFile = true
        model.setValue(content)
        isLoadingFile = false
      }
      currentFilePath = path
      onModified?.(path, false)
    } catch (err: unknown) {
      console.error('Failed to load file:', err)
    }
  }

  async function saveFile(): Promise<void> {
    if (!editor || !currentFilePath) return
    const content = editor.getValue()
    try {
      await window.api.invoke('editor:save', currentFilePath, content)
      onModified?.(currentFilePath, false)
    } catch (err: unknown) {
      console.error('Failed to save file:', err)
    }
  }

  $effect(() => {
    if (!container) return

    editor = monaco.editor.create(container, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      minimap: { enabled: true },
      automaticLayout: true,
      fontSize: 13,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2
    })

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveFile()
    })

    editor.addAction({
      id: 'discuss-with-agent',
      label: 'Discuss with Agent',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run(ed) {
        const selection = ed.getSelection()
        const model = ed.getModel()
        if (!selection || !model || !latestFilePath) return
        const selectedText = model.getValueInRange(selection)
        const pixelPos = ed.getScrolledVisiblePosition({
          lineNumber: selection.startLineNumber,
          column: selection.startColumn,
        })
        if (!pixelPos || !container) return
        const rect = container.getBoundingClientRect()
        latestOnDiscuss?.(
          {
            kind: 'editor',
            filePath: latestFilePath,
            selectedText,
            lineRange: [selection.startLineNumber, selection.endLineNumber],
          },
          { x: rect.left + pixelPos.left, y: rect.top + pixelPos.top + pixelPos.height },
        )
      },
    })

    editor.onDidChangeModelContent(() => {
      if (currentFilePath && !isLoadingFile) {
        onModified?.(currentFilePath, true)
      }
    })

    return () => {
      editor?.dispose()
      editor = undefined
    }
  })

  $effect(() => {
    if (filePath && editor) {
      loadFile(filePath)
    }
  })
</script>

<div class="h-full w-full" bind:this={container}></div>
