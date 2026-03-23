<script lang="ts">
  import { onMount } from 'svelte'
  import type { RecentRepo } from '../../shared/ipc-types'

  interface Props {
    onreposelected: (repoPath: string) => void
  }

  let { onreposelected }: Props = $props()

  let recentRepos = $state<RecentRepo[]>([])

  // Clone form state
  let showCloneForm = $state(false)
  let cloneUrl = $state('')
  let cloneDir = $state('')
  let cloneError = $state('')
  let cloning = $state(false)

  onMount(async () => {
    recentRepos = await window.api.invoke('app:recent-repos')
  })

  async function pickRepo(): Promise<void> {
    const path = await window.api.invoke('app:pick-repo')
    if (path) {
      onreposelected(path)
    }
  }

  function openRecent(repo: RecentRepo): void {
    onreposelected(repo.path)
  }

  function openInNewWindow(repo: RecentRepo): void {
    window.api.invoke('app:open-window', repo.path)
  }

  async function pickCloneDir(): Promise<void> {
    const dir = await window.api.invoke('app:pick-directory')
    if (dir) {
      cloneDir = dir
    }
  }

  async function cloneRepo(): Promise<void> {
    if (!cloneUrl.trim() || !cloneDir.trim()) return

    cloneError = ''
    cloning = true
    try {
      const bareRepoPath = await window.api.invoke('app:clone-repo', cloneUrl.trim(), cloneDir.trim())
      onreposelected(bareRepoPath)
    } catch (err) {
      cloneError = err instanceof Error ? err.message : String(err)
    } finally {
      cloning = false
    }
  }

  function relativeDate(dateStr: string): string {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDay = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDay === 0) return 'Today'
    if (diffDay === 1) return 'Yesterday'
    if (diffDay < 7) return `${diffDay} days ago`
    if (diffDay < 30) return `${Math.floor(diffDay / 7)} weeks ago`
    return date.toLocaleDateString()
  }
</script>

<div class="flex h-full items-center justify-center bg-zinc-950">
  <div class="flex w-full max-w-md flex-col gap-6 px-8">
    <div class="text-center">
      <h1 class="text-xl font-semibold text-zinc-200">SimpleEdit</h1>
      <p class="mt-1 text-sm text-zinc-500">Agentic IDE for Claude Code + worktrees</p>
    </div>

    <div class="flex gap-3">
      <button
        class="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-200 transition-colors hover:border-blue-500 hover:bg-zinc-700"
        onclick={pickRepo}
      >
        Open Repository...
      </button>
      <button
        class="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-200 transition-colors hover:border-blue-500 hover:bg-zinc-700"
        onclick={() => (showCloneForm = !showCloneForm)}
      >
        Checkout Repository...
      </button>
    </div>

    {#if showCloneForm}
      <div class="flex flex-col gap-3 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
        <div class="flex flex-col gap-1.5">
          <label for="clone-url" class="text-xs font-medium text-zinc-400">Repository URL</label>
          <input
            id="clone-url"
            type="text"
            placeholder="https://github.com/user/repo.git"
            bind:value={cloneUrl}
            disabled={cloning}
            class="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none transition-colors focus:border-blue-500 disabled:opacity-50"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="clone-dir" class="text-xs font-medium text-zinc-400">Destination</label>
          <div class="flex gap-2">
            <input
              id="clone-dir"
              type="text"
              placeholder="Select a directory..."
              bind:value={cloneDir}
              disabled={cloning}
              class="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none transition-colors focus:border-blue-500 disabled:opacity-50"
            />
            <button
              class="shrink-0 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-blue-500 hover:bg-zinc-700 disabled:opacity-50"
              onclick={pickCloneDir}
              disabled={cloning}
            >
              Browse...
            </button>
          </div>
        </div>
        {#if cloneError}
          <p class="text-xs text-red-400">{cloneError}</p>
        {/if}
        {#if cloning}
          <div class="flex items-center gap-2 py-1">
            <div class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"></div>
            <span class="text-xs text-zinc-400">Cloning repository...</span>
          </div>
        {:else}
          <button
            class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            onclick={cloneRepo}
            disabled={!cloneUrl.trim() || !cloneDir.trim()}
          >
            Clone
          </button>
        {/if}
      </div>
    {/if}

    {#if recentRepos.length > 0}
      <div class="flex flex-col gap-1">
        <span class="px-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Recently Opened
        </span>
        {#each recentRepos as repo (repo.path)}
          <div class="group flex items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-zinc-800">
            <button
              class="min-w-0 flex-1 text-left"
              onclick={() => openRecent(repo)}
            >
              <div class="truncate text-sm text-zinc-300">{repo.name}</div>
              <div class="truncate text-[11px] text-zinc-600">{repo.path}</div>
            </button>
            <span class="shrink-0 text-[10px] text-zinc-600">{relativeDate(repo.lastOpened)}</span>
            <button
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-300 group-hover:opacity-100"
              onclick={() => openInNewWindow(repo)}
              title="Open in new window"
            >
              ⧉
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
