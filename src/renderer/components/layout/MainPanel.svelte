<script lang="ts">
  import FileTree from '../filetree/FileTree.svelte'
  import TerminalTabs from '../terminal/TerminalTabs.svelte'
  import EditorTabs from '../editor/EditorTabs.svelte'
  import CodeEditor from '../editor/CodeEditor.svelte'
  import { activeFile, openFile } from '../../stores/activeFile.svelte'
  import { worktreeStore } from '../../stores/worktrees.svelte'

  let rootPath = $derived(worktreeStore.active?.path ?? null)

  function onFileSelect(path: string): void {
    openFile(path)
  }

  let splitPosition = $state(60) // percentage for editor vs terminal
  let isResizing = $state(false)

  function onMouseDown() {
    isResizing = true
    const container = document.getElementById('main-panel')!

    function onMouseMove(e: MouseEvent) {
      const rect = container.getBoundingClientRect()
      const pct = ((e.clientY - rect.top) / rect.height) * 100
      splitPosition = Math.max(20, Math.min(80, pct))
    }

    function onMouseUp() {
      isResizing = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
</script>

<div
  id="main-panel"
  class="flex h-full flex-col"
  class:select-none={isResizing}
>
  {#if rootPath}
    <!-- Top: file tree + editor area -->
    <div class="flex min-h-0" style:height="{splitPosition}%">
      <div class="flex flex-1 flex-col overflow-hidden">
        <EditorTabs />
        {#if activeFile.value}
          <div class="flex-1 min-h-0">
            <CodeEditor filePath={activeFile.value} worktreeRoot={rootPath} />
          </div>
        {:else}
          <div class="flex flex-1 items-center justify-center">
            <p class="text-sm text-zinc-600">Open a file to start editing</p>
          </div>
        {/if}
      </div>
      <div class="w-52 flex-none overflow-y-auto border-r border-zinc-800 p-2">
        {#key rootPath}
          <FileTree {rootPath} onselect={onFileSelect} />
        {/key}
      </div>
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="h-1 flex-none cursor-row-resize bg-zinc-800 hover:bg-blue-500 transition-colors"
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      onmousedown={onMouseDown}
    ></div>

    <!-- Bottom: terminal area -->
    <div class="min-h-0 flex-1 bg-black">
      {#key rootPath}
        <TerminalTabs worktreePath={rootPath} />
      {/key}
    </div>
  {:else}
    <div class="flex h-full items-center justify-center">
      <p class="text-sm text-zinc-600">Select a worktree from the sidebar to get started</p>
    </div>
  {/if}
</div>
