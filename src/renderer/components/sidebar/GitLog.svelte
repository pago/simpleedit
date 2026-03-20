<script lang="ts">
  import type { GitCommitInfo } from '../../../shared/ipc-types'
  import { diffReviewStore, startReview } from '../../stores/diffReview.svelte'

  interface Props {
    worktreePath: string | null
  }

  let { worktreePath }: Props = $props()

  let selectedCommitHash = $derived(
    worktreePath ? (diffReviewStore.get(worktreePath)?.hash ?? undefined) : undefined
  )

  let commits = $state<GitCommitInfo[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)
  let hasStagingChanges = $state(false)

  function relativeDate(dateStr: string): string {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffSec = Math.floor(diffMs / 1000)
    const diffMin = Math.floor(diffSec / 60)
    const diffHour = Math.floor(diffMin / 60)
    const diffDay = Math.floor(diffHour / 24)
    const diffWeek = Math.floor(diffDay / 7)

    if (diffSec < 60) return 'just now'
    if (diffMin < 60) return `${diffMin}m ago`
    if (diffHour < 24) return `${diffHour}h ago`
    if (diffDay < 7) return `${diffDay}d ago`
    if (diffWeek < 52) return `${diffWeek}w ago`
    return date.toLocaleDateString()
  }

  function shortHash(hash: string): string {
    return hash.slice(0, 7)
  }

  function firstLine(message: string): string {
    return message.split('\n')[0] ?? message
  }

  async function fetchLog(path: string): Promise<void> {
    loading = true
    error = null
    try {
      commits = await window.api.invoke('git:log', path)
      const stagingFiles = await window.api.invoke('git:staging-files', path)
      hasStagingChanges = stagingFiles.length > 0
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Failed to load git log'
      commits = []
      hasStagingChanges = false
    } finally {
      loading = false
    }
  }

  function selectStaging(): void {
    if (worktreePath) startReview(worktreePath, { hash: null, message: 'Uncommitted changes' })
  }

  function selectCommit(commit: GitCommitInfo): void {
    if (worktreePath) startReview(worktreePath, { hash: commit.hash, message: commit.message })
  }

  $effect(() => {
    if (worktreePath) {
      fetchLog(worktreePath)
    } else {
      commits = []
      hasStagingChanges = false
    }
  })

  // Auto-refresh git log on file changes (debounced)
  $effect(() => {
    const path = worktreePath
    if (!path) return

    let timer: ReturnType<typeof setTimeout>
    const unsubscribe = window.api.on('fs:changed', () => {
      clearTimeout(timer)
      timer = setTimeout(() => fetchLog(path), 500)
    })

    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  })
</script>

<div class="flex flex-col gap-1">
  <div class="flex items-center justify-between px-1">
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">Git Log</span>
    {#if worktreePath}
      <button
        class="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
        onclick={() => worktreePath && fetchLog(worktreePath)}
        title="Refresh"
      >
        ↻
      </button>
    {/if}
  </div>

  {#if !worktreePath}
    <p class="px-2 text-xs text-zinc-500">Select a worktree</p>
  {:else if loading}
    <p class="px-2 text-xs text-zinc-500">Loading...</p>
  {:else if error}
    <p class="px-2 text-xs text-red-400">{error}</p>
  {:else}
    <div class="flex flex-col gap-0.5 overflow-y-auto" role="listbox" aria-label="Commits">
      <!-- Staging entry -->
      {#if hasStagingChanges}
        <button
          class="flex flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors
            {selectedCommitHash === null && selectedCommitHash !== undefined
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}"
          role="option"
          aria-selected={selectedCommitHash === null}
          onclick={selectStaging}
        >
          <span class="truncate text-xs font-medium text-amber-400">Uncommitted changes</span>
          <span class="text-[10px] text-zinc-500">Working tree</span>
        </button>
      {/if}

      {#each commits as commit (commit.hash)}
        <button
          class="flex flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors
            {selectedCommitHash === commit.hash
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}"
          role="option"
          aria-selected={selectedCommitHash === commit.hash}
          onclick={() => selectCommit(commit)}
        >
          <span class="truncate text-xs font-medium">{firstLine(commit.message)}</span>
          <span class="flex items-center gap-1.5 text-[10px] text-zinc-500">
            <span class="font-mono">{shortHash(commit.hash)}</span>
            <span>&middot;</span>
            <span class="truncate">{commit.author}</span>
            <span>&middot;</span>
            <span class="shrink-0">{relativeDate(commit.date)}</span>
          </span>
        </button>
      {/each}

      {#if commits.length === 0 && !hasStagingChanges}
        <p class="px-2 text-xs text-zinc-500">No commits</p>
      {/if}
    </div>
  {/if}
</div>
