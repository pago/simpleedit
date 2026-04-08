<script lang="ts">
  import type { FileEntry } from '../../../shared/ipc-types'
  import FileNode from './FileNode.svelte'

  interface Props {
    rootPath: string
    highlightedFiles?: Set<string>
    onselect?: (path: string) => void
    oncollapse?: () => void
  }

  let { rootPath, highlightedFiles = new Set(), onselect, oncollapse }: Props = $props()

  let entries = $state<FileEntry[]>([])

  async function loadRoot(): Promise<void> {
    entries = await window.api.invoke('fs:list', rootPath)
  }

  // Reload when rootPath changes
  $effect(() => {
    void rootPath
    loadRoot()
  })
</script>

<div class="flex flex-col">
  <div class="flex items-center justify-between px-1 pb-1">
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">Files</span>
    <div class="flex items-center gap-0.5">
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
      <FileNode {entry} {highlightedFiles} {onselect} />
    {/each}
  </div>
</div>
