<script lang="ts">
  import type { GitCommitInfo } from '../../../shared/ipc-types'
  import { openDiffTab, openPlanTab, openTourTab, activeDiffHash } from '../../stores/diffReview.svelte'
  import { triggerTour, tourStore, loadCachedTour } from '../../stores/tourStore.svelte'
  import { planStore } from '../../stores/planStore.svelte'
  import TabIcon from '../layout/TabIcon.svelte'

  interface Props {
    worktreePath: string | null
  }

  let { worktreePath }: Props = $props()

  let selectedCommitHash = $derived(
    worktreePath ? activeDiffHash(worktreePath) : undefined
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

  async function fetchLog(path: string, isRefresh = false): Promise<void> {
    if (!isRefresh) {
      loading = true
    }
    error = null
    try {
      commits = await window.api.invoke('git:log', path)
      const stagingFiles = await window.api.invoke('git:staging-files', path)
      hasStagingChanges = stagingFiles.length > 0

      // If we were viewing staging but there are no more uncommitted changes,
      // auto-select the newest commit so the view stays useful
      if (isRefresh && path) {
        const currentHash = activeDiffHash(path)
        if (currentHash === null && !hasStagingChanges && commits.length > 0) {
          openDiffTab(path, commits[0].hash, commits[0].message)
        }
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Failed to load git log'
      commits = []
      hasStagingChanges = false
    } finally {
      loading = false
    }
  }

  function selectStaging(): void {
    if (worktreePath) openDiffTab(worktreePath, null, 'Uncommitted changes', { peek: true })
  }

  function selectCommit(commit: GitCommitInfo): void {
    if (worktreePath) openDiffTab(worktreePath, commit.hash, commit.message, { peek: true })
  }

  function startBranchTour(): void {
    if (!worktreePath) return
    openTourTab(worktreePath, 'branch', 'Branch tour')
    triggerTour(worktreePath, 'branch')
  }

  async function openPlan(): Promise<void> {
    if (!worktreePath) return
    // Prefer reopening the most recent Claude-originated plan if one exists (check disk too)
    const claudeTerminalId = await planStore.loadLatestClaudePlanTerminalId(worktreePath)
    if (claudeTerminalId) {
      openPlanTab(worktreePath, `claude-${claudeTerminalId}`, 'Claude Plan', {
        claudeTerminalId,
      })
    } else {
      openPlanTab(worktreePath, 'user-plan', 'Plan')
    }
  }

  function openTour(commit: { hash: string | null; message: string }): void {
    if (!worktreePath) return
    const label = commit.hash
      ? `Tour: ${commit.message.split('\n')[0] || commit.hash.slice(0, 7)}`
      : 'Tour: Uncommitted changes'
    openTourTab(worktreePath, commit.hash, label)
    // Best-effort: warm the in-memory tourStore from disk so the user sees a
    // populated panel rather than an empty one.
    if (commit.hash !== null && !tourStore.hasTourForCommit(worktreePath, commit.hash)) {
      loadCachedTour(worktreePath, commit.hash).catch(() => undefined)
    }
  }

  function handleTourIconClick(e: MouseEvent, commit: GitCommitInfo): void {
    e.stopPropagation()
    openTour({ hash: commit.hash, message: commit.message })
  }

  $effect(() => {
    if (worktreePath) {
      fetchLog(worktreePath)
    } else {
      commits = []
      hasStagingChanges = false
    }
  })

  // Watch git refs for commit/staging changes and auto-refresh
  $effect(() => {
    const path = worktreePath
    if (!path) return

    window.api.invoke('git:watch', path)

    let timer: ReturnType<typeof setTimeout>

    const unsubStatus = window.api.on('git:status-changed', (data) => {
      if (data.worktreePath === path) {
        clearTimeout(timer)
        timer = setTimeout(() => fetchLog(path, true), 300)
      }
    })

    const unsubRefs = window.api.on('git:refs-changed', (data) => {
      if (data.worktreePath === path) {
        clearTimeout(timer)
        timer = setTimeout(() => fetchLog(path, true), 300)
      }
    })

    return () => {
      clearTimeout(timer)
      unsubStatus()
      unsubRefs()
      window.api.invoke('git:unwatch', path)
    }
  })
</script>

<div class="flex flex-col gap-1">
  <div class="flex items-center justify-between px-1">
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">Git Log</span>
    <div class="flex items-center gap-1">
      {#if worktreePath}
        <button
          class="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
          onclick={openPlan}
          title="Create an implementation plan"
        >
          ✦ Plan
        </button>
        <button
          class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
          onclick={startBranchTour}
          title="Generate a guided tour of all changes on this branch"
        >
          <TabIcon kind="tour" class="h-3 w-3" />
          Tour Branch
        </button>
        <button
          class="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
          onclick={() => worktreePath && fetchLog(worktreePath)}
          title="Refresh"
        >
          ↻
        </button>
      {/if}
    </div>
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
            {selectedCommitHash === null
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
        {@const isSelected = selectedCommitHash === commit.hash}
        {@const hasTour = worktreePath
          ? tourStore.hasTourForCommit(worktreePath, commit.hash)
          : false}
        <div class="group relative">
          <button
            class="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors
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
          <button
            type="button"
            data-testid="gitlog-tour-icon"
            data-has-tour={String(hasTour)}
            title="Tour"
            aria-label="Open tour for this commit"
            class="absolute right-1 top-1.5 rounded p-1 shadow-sm transition-opacity backdrop-blur-sm
              {hasTour
                ? 'text-sky-400 bg-zinc-800/85 hover:bg-zinc-600 hover:text-sky-300'
                : 'text-zinc-300 bg-zinc-700/90 opacity-0 hover:bg-zinc-600 hover:text-zinc-100 group-hover:opacity-100 focus:opacity-100'}
              {isSelected && !hasTour ? 'opacity-100' : ''}"
            onclick={(e) => handleTourIconClick(e, commit)}
          >
            <TabIcon kind="tour" class="h-3.5 w-3.5" />
          </button>
        </div>
      {/each}

      {#if commits.length === 0 && !hasStagingChanges}
        <p class="px-2 text-xs text-zinc-500">No commits</p>
      {/if}
    </div>
  {/if}
</div>
