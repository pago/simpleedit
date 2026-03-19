<script lang="ts">
  import {
    openFiles,
    activeFile,
    closeFile,
    setActiveFile
  } from '../../stores/activeFile.svelte'

  function fileName(path: string): string {
    const parts = path.split('/')
    return parts[parts.length - 1] ?? path
  }

  function handleClose(e: MouseEvent, path: string): void {
    e.stopPropagation()
    closeFile(path)
  }
</script>

{#if openFiles.value.length > 0}
  <div class="flex h-9 items-center overflow-x-auto border-b border-zinc-800 bg-zinc-900">
    {#each openFiles.value as file (file.path)}
      <button
        class="group flex h-full items-center gap-1.5 border-r border-zinc-800 px-3 text-xs transition-colors
          {activeFile.value === file.path
          ? 'bg-zinc-950 text-zinc-200'
          : 'bg-zinc-900 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}"
        onclick={() => setActiveFile(file.path)}
        title={file.path}
      >
        {#if file.modified}
          <span class="h-2 w-2 flex-none rounded-full bg-amber-400" title="Unsaved changes"></span>
        {/if}
        <span class="truncate max-w-40">{fileName(file.path)}</span>
        <span
          role="button"
          tabindex="0"
          class="ml-1 flex-none rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-300 group-hover:opacity-100
            {activeFile.value === file.path ? 'opacity-100' : ''}"
          onclick={(e) => handleClose(e, file.path)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClose(e as unknown as MouseEvent, file.path) }}
        >
          &times;
        </span>
      </button>
    {/each}
  </div>
{/if}
