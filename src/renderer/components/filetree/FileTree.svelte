<script lang="ts">
  import type { FileEntry } from '../../../shared/ipc-types'
  import FileNode from './FileNode.svelte'

  interface Props {
    rootPath: string
    activeFilePath?: string | null
    highlightedFiles?: Set<string>
    onselect?: (path: string) => void
    oncollapse?: () => void
  }

  let {
    rootPath,
    activeFilePath = null,
    highlightedFiles = new Set(),
    onselect,
    oncollapse,
  }: Props = $props()

  let entries = $state<FileEntry[]>([])
  let revealRequest = $state<{ path: string; nonce: number } | null>(null)

  async function loadRoot(): Promise<void> {
    entries = await window.api.invoke('fs:list', rootPath)
  }

  // Reload when rootPath changes
  $effect(() => {
    void rootPath
    loadRoot()
  })

  function revealActive(): void {
    if (!activeFilePath) return
    revealRequest = {
      path: activeFilePath,
      nonce: (revealRequest?.nonce ?? 0) + 1,
    }
  }
</script>

<div class="flex flex-col">
  <div class="flex items-center justify-between px-1 pb-1">
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">Files</span>
    <div class="flex items-center gap-0.5">
      <button
        class="rounded px-1 py-0.5 text-zinc-400 enabled:hover:bg-zinc-700 enabled:hover:text-zinc-200 disabled:opacity-40"
        onclick={revealActive}
        disabled={!activeFilePath}
        title="Select opened file"
        aria-label="Select opened file"
      >
        <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round">
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 0.5v3" />
          <path d="M8 12.5v3" />
          <path d="M0.5 8h3" />
          <path d="M12.5 8h3" />
        </svg>
      </button>
      <button
        class="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
        onclick={loadRoot}
        title="Refresh"
      >
        ↻
      </button>
      {#if oncollapse}
        <button
          class="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
          onclick={oncollapse}
          title="Collapse file tree"
        >
          ⏵
        </button>
      {/if}
    </div>
  </div>

  <div role="tree" class="select-none text-sm">
    {#each entries as entry (entry.path)}
      <FileNode {entry} {highlightedFiles} {revealRequest} {onselect} />
    {/each}
  </div>
</div>
