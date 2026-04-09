<script lang="ts">
  import MonacoDiffEditor from './MonacoDiffEditor.svelte'
  import ReviewPanel from './ReviewPanel.svelte'
  import TourPanel from './TourPanel.svelte'
  import PlanPanel from './PlanPanel.svelte'
  import type { DiffFileEntry } from '../../../shared/ipc-types'
  import type { AgentContext } from '../../lib/agent-message'
  import type { AgentTabInfo } from '../../stores/agentTerminals.svelte'
  import { tick } from 'svelte'
  import { reviewStore, reviewKey, triggerReview } from '../../stores/reviewStore.svelte'
  import { tourStore, tourKey, triggerTour } from '../../stores/tourStore.svelte'
  import { planStore, planKey } from '../../stores/planStore.svelte'

  interface Props {
    /** null means staging/uncommitted changes */
    commitHash: string | null
    commitMessage: string
    worktreePath: string
    terminals: AgentTabInfo[]
    onclose: () => void
    ondiscusswithagent?: (ctx: AgentContext, pos: { x: number; y: number }) => void
    onsendtoagent?: (terminalId: string | 'new', message: string) => string | undefined
  }

  let { commitHash, commitMessage, worktreePath, terminals, onclose, ondiscusswithagent, onsendtoagent }: Props = $props()

  let files = $state<DiffFileEntry[]>([])
  let selectedFile = $state<string | null>(null)
  let originalContent = $state('')
  let modifiedContent = $state('')
  let loading = $state(true)
  let fileListWidth = $state(224) // w-56 = 14rem = 224px
  let isResizing = $state(false)

  // Tab state: 'files', 'findings', 'tour', or 'plan'
  let activeTab = $state<'files' | 'findings' | 'tour' | 'plan'>('files')

  // Highlight range set by navigating to a finding
  let highlightLines = $state<[number, number] | undefined>(undefined)

  const rKey = $derived(reviewKey(worktreePath, commitHash))
  const reviewState = $derived(reviewStore.get(rKey))

  const reviewBadge = $derived.by(() => {
    if (!reviewState || reviewState.status === 'idle') return null
    if (reviewState.status === 'running') return 'running'
    const active = reviewState.findings.filter((f) => !reviewState.dismissed.has(f.id))
    const blocking = active.filter((f) => f.decoration === 'blocking').length
    return { total: active.length, blocking }
  })

  const tKey = $derived(tourKey(worktreePath, commitHash))
  const tourState = $derived(tourStore.get(tKey))

  const pKey = $derived(planKey(worktreePath, commitHash))
  const pState = $derived(planStore.get(pKey))

  function handleStartTour(): void {
    triggerTour(worktreePath, commitHash)
    activeTab = 'tour'
  }

  function onSplitterMouseDown(e: MouseEvent) {
    isResizing = true
    const startX = e.clientX
    const startWidth = fileListWidth

    function onMouseMove(ev: MouseEvent) {
      fileListWidth = Math.max(120, Math.min(500, startWidth + ev.clientX - startX))
    }

    function onMouseUp() {
      isResizing = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const isStaging = $derived(commitHash === null)
  const isBranch = $derived(commitHash === 'branch')

  // Auto-switch to Tour tab for branch tour
  $effect(() => {
    if (isBranch) activeTab = 'tour'
  })

  // Load file list when commit changes
  $effect(() => {
    void commitHash
    void worktreePath
    loadFiles(false)
  })

  // Auto-refresh staging diff on git status changes (debounced)
  $effect(() => {
    if (!isStaging) return

    let timer: ReturnType<typeof setTimeout>
    const unsubscribe = window.api.on('git:status-changed', (data) => {
      if (data.worktreePath !== worktreePath) return
      clearTimeout(timer)
      timer = setTimeout(() => refreshStaging(), 300)
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
      highlightLines = undefined
    }
    try {
      if (isBranch) {
        files = await window.api.invoke('git:branch-files', worktreePath)
      } else if (isStaging) {
        files = await window.api.invoke('git:staging-files', worktreePath)
      } else {
        files = await window.api.invoke('git:commit-files', worktreePath, commitHash!)
      }
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
    if (selectedFile) {
      await selectFile(selectedFile)
    }
  }

  async function selectFile(filePath: string): Promise<void> {
    selectedFile = filePath
    try {
      if (isBranch) {
        originalContent = await window.api.invoke('git:file-at-branch-base', worktreePath, filePath).catch(() => '')
        modifiedContent = await window.api.invoke('fs:read', `${worktreePath}/${filePath}`).catch(() => '')
      } else if (isStaging) {
        originalContent = await window.api.invoke('git:file-at-head', worktreePath, filePath)
        modifiedContent = await window.api.invoke('fs:read', `${worktreePath}/${filePath}`)
      } else {
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

  async function handleNavigateFinding(file: string, lineRange: [number, number]): Promise<void> {
    highlightLines = undefined
    await selectFile(file)
    await tick() // let Svelte flush the model-update effect before scrolling
    highlightLines = lineRange
  }

  function handleDiscussWithAgent(ctx: AgentContext, pos: { x: number; y: number }): void {
    if (ctx.kind === 'diff') {
      ondiscusswithagent?.({ ...ctx, commitHash }, pos)
    } else {
      ondiscusswithagent?.(ctx, pos)
    }
  }

  function handleStartReview(): void {
    triggerReview(worktreePath, commitHash)
    activeTab = 'findings'
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
      {#if isBranch}
        <span class="text-xs font-medium text-blue-400">Branch tour</span>
      {:else if isStaging}
        <span class="text-xs font-medium text-amber-400">Uncommitted changes</span>
      {:else}
        <span class="font-mono text-[10px] text-zinc-500">{commitHash?.slice(0, 7)}</span>
        <span class="ml-1.5 truncate text-xs text-zinc-300">{commitMessage.split('\n')[0]}</span>
      {/if}
    </div>

    <!-- Review button -->
    <button
      class="flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors
        {reviewState?.status === 'running'
          ? 'cursor-default text-zinc-500'
          : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'}"
      onclick={handleStartReview}
      disabled={reviewState?.status === 'running'}
      title={reviewState?.status === 'running' ? 'Review in progress…' : 'Review this diff with Claude'}
    >
      {#if reviewState?.status === 'running'}
        <span class="animate-spin text-[10px]">⠿</span>
        <span>Reviewing…</span>
      {:else if typeof reviewBadge === 'object' && reviewBadge !== null}
        <span>✦ Re-review</span>
        {#if reviewBadge.blocking > 0}
          <span class="rounded bg-red-900/60 px-1 py-0.5 text-[10px] text-red-300">
            {reviewBadge.blocking} blocking
          </span>
        {:else}
          <span class="rounded bg-zinc-700 px-1 py-0.5 text-[10px] text-zinc-400">
            {reviewBadge.total}
          </span>
        {/if}
      {:else}
        <span>✦ Review</span>
      {/if}
    </button>

    <!-- Tour button -->
    <button
      class="flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors
        {tourState?.status === 'running'
          ? 'cursor-default text-zinc-500'
          : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'}"
      onclick={handleStartTour}
      disabled={tourState?.status === 'running'}
      title={tourState?.status === 'running' ? 'Tour in progress…' : 'Generate a guided tour of this changeset'}
    >
      {#if tourState?.status === 'running'}
        <span class="animate-spin text-[10px]">⠿</span>
        <span>Touring…</span>
      {:else if tourState && tourState.topics.length > 0}
        <span>✦ Re-tour</span>
        <span class="rounded bg-zinc-700 px-1 py-0.5 text-[10px] text-zinc-400">
          {tourState.topics.length}
        </span>
      {:else}
        <span>✦ Tour</span>
      {/if}
    </button>

  </div>

  {#if activeTab === 'tour'}
    <TourPanel {worktreePath} {commitHash} {commitMessage} />
  {:else if activeTab === 'plan'}
    <PlanPanel {worktreePath} {commitHash} {terminals} {onsendtoagent} />
  {:else}
  <div class="flex min-h-0 flex-1" class:select-none={isResizing}>
    <!-- Left panel (file list or findings) -->
    <div class="flex flex-none flex-col border-r border-zinc-800 bg-zinc-950" style:width="{fileListWidth}px">

      <!-- Tab bar -->
      <div class="flex border-b border-zinc-800">
        <button
          class="flex-1 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider transition-colors
            {activeTab === 'files'
              ? 'border-b-2 border-blue-500 text-zinc-300'
              : 'text-zinc-600 hover:text-zinc-400'}"
          onclick={() => (activeTab = 'files')}
        >
          Files {files.length > 0 ? `(${files.length})` : ''}
        </button>
        <button
          class="flex-1 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider transition-colors
            {activeTab === 'findings'
              ? 'border-b-2 border-blue-500 text-zinc-300'
              : 'text-zinc-600 hover:text-zinc-400'}"
          onclick={() => (activeTab = 'findings')}
        >
          {#if reviewState && reviewState.findings.length > 0}
            {@const active = reviewState.findings.filter((f) => !reviewState.dismissed.has(f.id))}
            {@const blocking = active.filter((f) => f.decoration === 'blocking').length}
            Findings
            {#if blocking > 0}
              <span class="ml-1 rounded bg-red-900/60 px-1 text-red-300">{blocking}!</span>
            {:else if active.length > 0}
              <span class="ml-1 text-zinc-500">({active.length})</span>
            {/if}
          {:else}
            Findings
          {/if}
        </button>
        <button
          class="flex-1 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider transition-colors
            {activeTab === 'tour'
              ? 'border-b-2 border-blue-500 text-zinc-300'
              : 'text-zinc-600 hover:text-zinc-400'}"
          onclick={() => (activeTab = 'tour')}
        >
          Tour
          {#if tourState && tourState.topics.length > 0}
            <span class="ml-1 text-zinc-500">({tourState.topics.length})</span>
          {/if}
        </button>
        <button
          class="flex-1 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider transition-colors
            {activeTab === 'plan'
              ? 'border-b-2 border-blue-500 text-zinc-300'
              : 'text-zinc-600 hover:text-zinc-400'}"
          onclick={() => (activeTab = 'plan')}
        >
          Plan
          {#if pState && pState.tasks.length > 0}
            <span class="ml-1 text-zinc-500">({pState.tasks.length})</span>
          {/if}
        </button>
      </div>

      <!-- Tab content -->
      <div class="min-h-0 flex-1 overflow-y-auto">
        {#if activeTab === 'files'}
          {#if loading}
            <p class="px-2 py-2 text-xs text-zinc-500">Loading…</p>
          {:else}
            {#each files as file (file.path)}
              <button
                class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors
                  {selectedFile === file.path
                  ? 'bg-zinc-800 text-zinc-200'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-300'}"
                onclick={() => { highlightLines = undefined; selectFile(file.path) }}
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
        {:else}
          <ReviewPanel
            {worktreePath}
            {commitHash}
            {terminals}
            ondiscussfinding={handleDiscussWithAgent}
            onnavigate={handleNavigateFinding}
            {onsendtoagent}
          />
        {/if}
      </div>
    </div>

    <!-- Resize handle -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="w-1 flex-none cursor-col-resize bg-zinc-800 transition-colors hover:bg-blue-500"
      onmousedown={onSplitterMouseDown}
    ></div>

    <!-- Diff viewer -->
    <div class="flex min-w-0 flex-1 flex-col">
      {#if selectedFile}
        <div class="min-h-0 flex-1">
          <MonacoDiffEditor
            {originalContent}
            {modifiedContent}
            filePath={selectedFile}
            {highlightLines}
            ondiscusswithagent={handleDiscussWithAgent}
          />
        </div>
      {:else}
        <div class="flex flex-1 items-center justify-center">
          <p class="text-sm text-zinc-600">Select a file to view its diff</p>
        </div>
      {/if}
    </div>
  </div>
  {/if}
</div>
