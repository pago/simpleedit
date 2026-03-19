<script lang="ts">
  import type { GitCommitInfo } from '../../../shared/ipc-types'
  import { showDiff, diffView } from '../../stores/diffViewer.svelte'

  interface Props {
    worktreePath: string | null
  }

  let { worktreePath }: Props = $props()

  let commits = $state<GitCommitInfo[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)

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
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Failed to load git log'
      commits = []
    } finally {
      loading = false
    }
  }

  async function selectCommit(commit: GitCommitInfo): Promise<void> {
    if (!worktreePath) return
    try {
      const diff = await window.api.invoke('git:diff', worktreePath, commit.hash)
      showDiff({
        commitHash: commit.hash,
        commitMessage: commit.message,
        diffContent: diff
      })
    } catch (err: unknown) {
      console.error('Failed to load diff:', err)
    }
  }

  $effect(() => {
    if (worktreePath) {
      fetchLog(worktreePath)
    } else {
      commits = []
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
  {:else if commits.length === 0}
    <p class="px-2 text-xs text-zinc-500">No commits</p>
  {:else}
    <div class="flex flex-col gap-0.5 overflow-y-auto" role="listbox" aria-label="Commits">
      {#each commits as commit (commit.hash)}
        {@const isSelected = diffView.value?.commitHash === commit.hash}
        <button
          class="flex flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors
            {isSelected
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}"
          role="option"
          aria-selected={isSelected}
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
    </div>
  {/if}
</div>
