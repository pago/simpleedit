<script lang="ts">
  import * as monaco from 'monaco-editor'
  import type { AgentContext } from '../../lib/agent-message'
  import { lspClientManager } from '../../lsp/client-manager'
  import { applyReveal, bindEditorOpener, consumePendingReveal } from '../../lsp/editor-opener'

  interface Props {
    filePath: string | null
    worktreeRoot: string | null
    onModified?: (path: string, modified: boolean) => void
    ondiscusswithagent?: (ctx: AgentContext, pos: { x: number; y: number }) => void
    /**
     * Called when a Monaco navigation request (Go to Definition, peek →
     * navigate, Ctrl-click) targets a different file. The host should open
     * `path` as a tab in this pane; cursor positioning is handled here.
     */
    onOpenFile?: (path: string) => void
  }

  let { filePath, worktreeRoot, onModified, ondiscusswithagent, onOpenFile }: Props = $props()

  // Reads through this ref so the opener handler — registered once at editor
  // creation — sees the current onOpenFile prop without re-binding.
  let latestOnOpenFile = onOpenFile
  $effect(() => { latestOnOpenFile = onOpenFile })

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

      // Create (or reuse) a model keyed by the real file URI so that LSP
      // requests include a URI the server actually knows about.
      const fileUri = monaco.Uri.file(path)
      const existingModel = monaco.editor.getModel(fileUri)

      if (existingModel) {
        monaco.editor.setModelLanguage(existingModel, language)
        isLoadingFile = true
        existingModel.setValue(content)
        isLoadingFile = false
        editor.setModel(existingModel)
      } else {
        const prevModel = editor.getModel()
        const newModel = monaco.editor.createModel(content, language, fileUri)
        editor.setModel(newModel)
        // Dispose the old inmemory placeholder — it has no persistent value
        if (prevModel && prevModel.uri.scheme === 'inmemory') {
          prevModel.dispose()
        }
      }

      currentFilePath = path
      onModified?.(path, false)

      const reveal = consumePendingReveal(path)
      if (reveal) applyReveal(editor, reveal)

      if (worktreeRoot) {
        lspClientManager.openDocument(path, language, content, worktreeRoot).catch((err) => {
          // Editor still works without LSP, but log so the failure is diagnosable.
          console.warn(`[LSP] ${language} unavailable:`, err instanceof Error ? err.message : err)
        })
      }
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
      tabSize: 2,
      // Monaco's default is 'peek' for these, which short-circuits before our
      // editor opener can run when the LSP returns multiple locations (very
      // common for imports). 'goto' jumps to the first result; references stay
      // on peek because there's usually no single "right" reference to land on.
      gotoLocation: {
        multipleDefinitions: 'goto',
        multipleDeclarations: 'goto',
        multipleTypeDefinitions: 'goto',
        multipleImplementations: 'goto',
        multipleReferences: 'peek',
      },
    })

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveFile()
    })

    const unbindOpener = bindEditorOpener(editor, (target) => {
      latestOnOpenFile?.(target)
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
        if (worktreeRoot) {
          const content = editor!.getValue()
          const language = getLanguage(currentFilePath)
          lspClientManager.changeDocument(currentFilePath, language, content, worktreeRoot)
        }
      }
    })

    return () => {
      unbindOpener()
      if (currentFilePath && worktreeRoot) {
        const language = getLanguage(currentFilePath)
        lspClientManager.closeDocument(currentFilePath, language, worktreeRoot)
      }
      const model = editor?.getModel()
      editor?.dispose()
      editor = undefined
      model?.dispose()
    }
  })

  // Only reload when the path actually changes. The effect can re-fire on
  // unrelated reactive updates (e.g. parent re-renders because another tab's
  // modified flag flipped); calling loadFile again would reset the model to
  // disk content and erase whatever the user just typed.
  $effect(() => {
    if (filePath && editor && filePath !== currentFilePath) {
      loadFile(filePath)
    }
  })
</script>

<div class="h-full w-full" bind:this={container}></div>
