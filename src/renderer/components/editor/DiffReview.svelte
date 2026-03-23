<script lang="ts">
  import MonacoDiffEditor from './MonacoDiffEditor.svelte'
  import type { DiffFileEntry } from '../../../shared/ipc-types'

  interface Props {
    /** null means staging/uncommitted changes */
    commitHash: string | null
    commitMessage: string
    worktreePath: string
    onclose: () => void
    onsendtoclaude?: (message: string) => void
  }

  let { commitHash, commitMessage, worktreePath, onclose, onsendtoclaude }: Props = $props()

  let files = $state<DiffFileEntry[]>([])
  let selectedFile = $state<string | null>(null)
  let originalContent = $state('')
  let modifiedContent = $state('')
  let loading = $state(true)
  let claudeQuestion = $state('')

  const isStaging = $derived(commitHash === null)

  // Load file list when commit changes
  $effect(() => {
    // Track commitHash and worktreePath to re-run on change
    void commitHash
    void worktreePath
    loadFiles(false)
  })

  // Auto-refresh staging diff on file changes (debounced)
  $effect(() => {
    if (!isStaging) return

    let timer: ReturnType<typeof setTimeout>
    const unsubscribe = window.api.on('fs:changed', () => {
      clearTimeout(timer)
      timer = setTimeout(() => refreshStaging(), 500)
    })

    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  })

  async function loadFiles(isRefresh: boolean): Promise<void> {
    if (!isRefresh) {
      loading = true
      selectedFile = null
    }
    try {
      if (isStaging) {
        files = await window.api.invoke('git:staging-files', worktreePath)
      } else {
        files = await window.api.invoke('git:commit-files', worktreePath, commitHash!)
      }
      // If refreshing and the previously selected file is gone, clear selection
      if (isRefresh && selectedFile && !files.some((f) => f.path === selectedFile)) {
        selectedFile = null
        originalContent = ''
        modifiedContent = ''
      }
    } catch (err) {
      console.error('Failed to load files:', err)
      files = []
    }
    loading = false
  }

  async function refreshStaging(): Promise<void> {
    await loadFiles(true)
    // Re-fetch content for the currently selected file
    if (selectedFile) {
      await selectFile(selectedFile)
    }
  }

  async function selectFile(filePath: string): Promise<void> {
    selectedFile = filePath
    try {
      if (isStaging) {
        // Original = HEAD version, Modified = working tree version
        originalContent = await window.api.invoke('git:file-at-head', worktreePath, filePath)
        modifiedContent = await window.api.invoke('fs:read', `${worktreePath}/${filePath}`)
      } else {
        // Original = parent commit, Modified = this commit
        originalContent = await window.api.invoke(
          'git:file-at-commit', worktreePath, `${commitHash}~1`, filePath
        ).catch(() => '')
        modifiedContent = await window.api.invoke(
          'git:file-at-commit', worktreePath, commitHash!, filePath
        ).catch(() => '')
      }
    } catch (err) {
      console.error('Failed to load file diff:', err)
      originalContent = ''
      modifiedContent = ''
    }
  }

  function statusColor(status: DiffFileEntry['status']): string {
    switch (status) {
      case 'added': return 'text-green-400'
      case 'deleted': return 'text-red-400'
      case 'modified': return 'text-yellow-400'
    }
  }

  function statusLabel(status: DiffFileEntry['status']): string {
    switch (status) {
      case 'added': return 'A'
      case 'deleted': return 'D'
      case 'modified': return 'M'
    }
  }

  function fileName(path: string): string {
    const parts = path.split('/')
    return parts[parts.length - 1] ?? path
  }

  function dirName(path: string): string {
    const parts = path.split('/')
    if (parts.length <= 1) return ''
    return parts.slice(0, -1).join('/') + '/'
  }

  function sendToClaude(): void {
    const q = claudeQuestion.trim()
    if (!q || !onsendtoclaude) return

    let context = ''
    if (selectedFile) {
      context = `[Reviewing ${isStaging ? 'uncommitted changes' : `commit ${commitHash?.slice(0, 7)}`} — file: ${selectedFile}]\n`
    } else {
      context = `[Reviewing ${isStaging ? 'uncommitted changes' : `commit ${commitHash?.slice(0, 7)}: ${commitMessage}`}]\n`
    }

    onsendtoclaude(context + q)
    claudeQuestion = ''
  }

  function handleQuestionKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendToClaude()
    }
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
    <button
      class="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
      onclick={onclose}
    >
      &larr; Back
    </button>
    <div class="min-w-0 flex-1">
      {#if isStaging}
        <span class="text-xs font-medium text-amber-400">Uncommitted changes</span>
      {:else}
        <span class="font-mono text-[10px] text-zinc-500">{commitHash?.slice(0, 7)}</span>
        <span class="ml-1.5 truncate text-xs text-zinc-300">{commitMessage.split('\n')[0]}</span>
      {/if}
    </div>
  </div>

  <div class="flex min-h-0 flex-1">
    <!-- File list sidebar -->
    <div class="w-56 flex-none overflow-y-auto border-r border-zinc-800 bg-zinc-950">
      <div class="px-2 py-1.5">
        <span class="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {files.length} file{files.length !== 1 ? 's' : ''} changed
        </span>
      </div>
      {#if loading}
        <p class="px-2 text-xs text-zinc-500">Loading...</p>
      {:else}
        {#each files as file (file.path)}
          <button
            class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors
              {selectedFile === file.path
              ? 'bg-zinc-800 text-zinc-200'
              : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-300'}"
            onclick={() => selectFile(file.path)}
            title={file.path}
          >
            <span class="w-3 flex-none text-center font-mono text-[10px] {statusColor(file.status)}">
              {statusLabel(file.status)}
            </span>
            <span class="min-w-0 truncate">
              <span class="text-zinc-600">{dirName(file.path)}</span>{fileName(file.path)}
            </span>
          </button>
        {/each}
      {/if}
    </div>

    <!-- Diff viewer -->
    <div class="flex min-w-0 flex-1 flex-col">
      {#if selectedFile}
        <div class="min-h-0 flex-1">
          <MonacoDiffEditor
            {originalContent}
            {modifiedContent}
            filePath={selectedFile}
          />
        </div>
      {:else}
        <div class="flex flex-1 items-center justify-center">
          <p class="text-sm text-zinc-600">Select a file to view its diff</p>
        </div>
      {/if}

      <!-- Ask Claude bar -->
      {#if onsendtoclaude}
        <div class="flex items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-3 py-1.5">
          <span class="text-[10px] text-orange-400/60">&#x2726;</span>
          <input
            class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
            type="text"
            placeholder="Ask Claude about this change..."
            bind:value={claudeQuestion}
            onkeydown={handleQuestionKeydown}
          />
          <button
            class="rounded bg-orange-600 px-2 py-1 text-xs text-white hover:bg-orange-500 disabled:opacity-40"
            disabled={!claudeQuestion.trim()}
            onclick={sendToClaude}
          >
            Ask
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>
