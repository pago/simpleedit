<script lang="ts">
  import type { OpenFile } from '../../stores/activeFile.svelte'

  interface Props {
    openFiles: OpenFile[]
    activeFilePath: string | null
    onclose: (path: string) => void
    onselect: (path: string) => void
    onreorder?: (fromIndex: number, toIndex: number) => void
  }

  let { openFiles, activeFilePath, onclose, onselect, onreorder }: Props = $props()

  let dragIndex: number | null = $state(null)
  let dropIndex: number | null = $state(null)

  function fileName(path: string): string {
    const parts = path.split('/')
    return parts[parts.length - 1] ?? path
  }

  function handleClose(e: MouseEvent, path: string): void {
    e.stopPropagation()
    onclose(path)
  }

  function handleDragStart(e: DragEvent, index: number): void {
    dragIndex = index
    e.dataTransfer!.effectAllowed = 'move'
  }

  function handleDragOver(e: DragEvent, index: number): void {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'move'
    dropIndex = index
  }

  function handleDrop(e: DragEvent, index: number): void {
    e.preventDefault()
    if (dragIndex !== null && dragIndex !== index) {
      onreorder?.(dragIndex, index)
    }
    dragIndex = null
    dropIndex = null
  }

  function handleDragEnd(): void {
    dragIndex = null
    dropIndex = null
  }
</script>

{#if openFiles.length > 0}
  <div class="flex h-9 items-center overflow-x-auto border-b border-zinc-800 bg-zinc-900">
    {#each openFiles as file, i (file.path)}
      <button
        class="group flex h-full items-center gap-1.5 border-r border-zinc-800 px-3 text-xs transition-colors
          {activeFilePath === file.path
          ? 'bg-zinc-950 text-zinc-200'
          : 'bg-zinc-900 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}
          {dragIndex !== null && dropIndex === i && dragIndex !== i ? 'border-l-2 border-l-blue-500' : ''}"
        onclick={() => onselect(file.path)}
        title={file.path}
        draggable="true"
        ondragstart={(e) => handleDragStart(e, i)}
        ondragover={(e) => handleDragOver(e, i)}
        ondrop={(e) => handleDrop(e, i)}
        ondragend={handleDragEnd}
      >
        {#if file.modified}
          <span class="h-2 w-2 flex-none rounded-full bg-amber-400" title="Unsaved changes"></span>
        {/if}
        <span class="truncate max-w-40">{fileName(file.path)}</span>
        <span
          role="button"
          tabindex="0"
          class="ml-1 flex-none rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-300 group-hover:opacity-100
            {activeFilePath === file.path ? 'opacity-100' : ''}"
          onclick={(e) => handleClose(e, file.path)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClose(e as unknown as MouseEvent, file.path) }}
        >
          &times;
        </span>
      </button>
    {/each}
  </div>
{/if}
