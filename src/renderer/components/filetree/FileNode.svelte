<script lang="ts">
  import type { FileEntry } from '../../../shared/ipc-types'
  import { tick } from 'svelte'
  import FileNode from './FileNode.svelte'

  interface Props {
    entry: FileEntry
    depth?: number
    highlightedFiles?: Set<string>
    revealRequest?: { path: string; nonce: number } | null
    onselect?: (path: string) => void
  }

  let {
    entry,
    depth = 0,
    highlightedFiles,
    revealRequest = null,
    onselect,
  }: Props = $props()

  let expanded = $state(false)
  let children = $state<FileEntry[]>([])
  let nodeEl = $state<HTMLDivElement | null>(null)

  async function loadChildren(): Promise<void> {
    children = await window.api.invoke('fs:list', entry.path)
  }

  async function toggle(): Promise<void> {
    if (!entry.isDirectory) {
      onselect?.(entry.path)
      return
    }

    expanded = !expanded

    if (expanded && children.length === 0) {
      await loadChildren()
    }
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }

  function isAncestorOf(target: string): boolean {
    if (!target.startsWith(entry.path)) return false
    if (target.length === entry.path.length) return false
    const next = target[entry.path.length]
    return next === '/' || next === '\\'
  }

  // Respond to reveal requests from the parent.
  // Re-runs whenever revealRequest.nonce changes, so re-revealing the same file works.
  $effect(() => {
    if (!revealRequest) return
    void revealRequest.nonce // track for reactivity
    const target = revealRequest.path

    if (target === entry.path) {
      void tick().then(() => {
        nodeEl?.scrollIntoView({ block: 'center' })
      })
      return
    }

    if (entry.isDirectory && isAncestorOf(target)) {
      if (!expanded) expanded = true
      if (children.length === 0) void loadChildren()
    }
  })

  let isHighlighted = $derived(highlightedFiles?.has(entry.path) ?? false)
  let isRevealTarget = $derived(revealRequest?.path === entry.path)
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={nodeEl}
  class="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-sm hover:bg-zinc-800 {isHighlighted ? 'bg-blue-900/30 text-blue-300' : isRevealTarget ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-300'}"
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
      {revealRequest}
      {onselect}
    />
  {/each}
{/if}
