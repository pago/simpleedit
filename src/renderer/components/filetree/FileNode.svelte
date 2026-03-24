<script lang="ts">
  import type { FileEntry } from '../../../shared/ipc-types'
  import FileNode from './FileNode.svelte'

  interface Props {
    entry: FileEntry
    depth?: number
    highlightedFiles?: Set<string>
    onselect?: (path: string) => void
  }

  let { entry, depth = 0, highlightedFiles, onselect }: Props = $props()

  let expanded = $state(false)
  let children = $state<FileEntry[]>([])

  async function toggle(): Promise<void> {
    if (!entry.isDirectory) {
      onselect?.(entry.path)
      return
    }

    expanded = !expanded

    if (expanded) {
      children = await window.api.invoke('fs:list', entry.path)
    }
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }

  let isHighlighted = $derived(highlightedFiles?.has(entry.path) ?? false)
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-sm hover:bg-zinc-800 {isHighlighted ? 'bg-blue-900/30 text-blue-300' : 'text-zinc-300'}"
  style:padding-left="{depth * 12 + 4}px"
  role="treeitem"
  aria-selected={false}
  aria-expanded={entry.isDirectory ? expanded : undefined}
  tabindex="0"
  onclick={toggle}
  onkeydown={handleKeyDown}
>
  {#if entry.isDirectory}
    <span class="w-4 text-center text-xs text-zinc-500">{expanded ? '▼' : '▶'}</span>
    <span>📁</span>
  {:else}
    <span class="w-4"></span>
    <span>📄</span>
  {/if}
  <span class="truncate">{entry.name}</span>
</div>

{#if entry.isDirectory && expanded}
  {#each children as child (child.path)}
    <FileNode
      entry={child}
      depth={depth + 1}
      {highlightedFiles}
      {onselect}
    />
  {/each}
{/if}
