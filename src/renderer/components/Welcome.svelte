<script lang="ts">
  import { onMount } from 'svelte'
  import type { RecentRepo } from '../../shared/ipc-types'

  interface Props {
    onreposelected: (repoPath: string) => void
  }

  let { onreposelected }: Props = $props()

  let recentRepos = $state<RecentRepo[]>([])

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

    <button
      class="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-200 transition-colors hover:border-blue-500 hover:bg-zinc-700"
      onclick={pickRepo}
    >
      Open Repository...
    </button>

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
