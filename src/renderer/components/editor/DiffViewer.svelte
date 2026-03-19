<script lang="ts">
  import * as monaco from 'monaco-editor'
  import { closeDiff } from '../../stores/diffViewer.svelte'

  interface Props {
    diffContent: string
    commitHash: string
    commitMessage: string
  }

  let { diffContent, commitHash, commitMessage }: Props = $props()

  let container: HTMLDivElement | undefined = $state()
  let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined

  /**
   * Parse a unified diff into per-file original/modified pairs.
   * We show the first changed file, or concatenate all into one view.
   */
  function parseUnifiedDiff(raw: string): { original: string; modified: string; fileName: string } {
    const files: Array<{ fileName: string; hunks: string[] }> = []
    let currentFile: { fileName: string; hunks: string[] } | null = null

    for (const line of raw.split('\n')) {
      if (line.startsWith('diff --git')) {
        const match = line.match(/b\/(.+)$/)
        currentFile = { fileName: match?.[1] ?? 'unknown', hunks: [] }
        files.push(currentFile)
      } else if (currentFile && !line.startsWith('index ') && !line.startsWith('---') && !line.startsWith('+++') && !line.startsWith('Binary')) {
        currentFile.hunks.push(line)
      }
    }

    // Reconstruct original and modified from the diff hunks
    let original = ''
    let modified = ''

    for (const file of files) {
      for (const line of file.hunks) {
        if (line.startsWith('@@')) {
          // hunk header — skip but add spacing
          original += '\n'
          modified += '\n'
        } else if (line.startsWith('-')) {
          original += line.slice(1) + '\n'
        } else if (line.startsWith('+')) {
          modified += line.slice(1) + '\n'
        } else if (line.startsWith(' ') || line === '') {
          const content = line.startsWith(' ') ? line.slice(1) : line
          original += content + '\n'
          modified += content + '\n'
        }
      }
    }

    const fileName = files.length === 1 ? (files[0]?.fileName ?? 'diff') : `${files.length} files changed`
    return { original, modified, fileName }
  }

  $effect(() => {
    if (!container) return

    diffEditor = monaco.editor.createDiffEditor(container, {
      theme: 'vs-dark',
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      enableSplitViewResizing: true
    })

    return () => {
      diffEditor?.dispose()
      diffEditor = undefined
    }
  })

  $effect(() => {
    if (!diffEditor || !diffContent) return

    const { original, modified, fileName } = parseUnifiedDiff(diffContent)

    const originalModel = monaco.editor.createModel(original, 'plaintext')
    const modifiedModel = monaco.editor.createModel(modified, 'plaintext')

    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel
    })

    // Try to detect language from file name
    const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : ''
    const langMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
      '.json': 'json', '.html': 'html', '.css': 'css', '.svelte': 'html',
      '.py': 'python', '.rs': 'rust', '.go': 'go', '.md': 'markdown'
    }
    const lang = langMap[ext]
    if (lang) {
      monaco.editor.setModelLanguage(originalModel, lang)
      monaco.editor.setModelLanguage(modifiedModel, lang)
    }

    return () => {
      originalModel.dispose()
      modifiedModel.dispose()
    }
  })
</script>

<div class="flex h-full flex-col">
  <div class="flex h-9 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3">
    <div class="flex items-center gap-2 text-xs">
      <span class="font-mono text-zinc-400">{commitHash.slice(0, 7)}</span>
      <span class="text-zinc-300">{commitMessage.split('\n')[0]}</span>
    </div>
    <button
      class="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
      onclick={closeDiff}
    >
      Close Diff
    </button>
  </div>
  <div class="flex-1 min-h-0" bind:this={container}></div>
</div>
