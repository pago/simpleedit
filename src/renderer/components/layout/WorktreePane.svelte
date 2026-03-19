<script lang="ts">
  import FileTree from '../filetree/FileTree.svelte'
  import TerminalTabs from '../terminal/TerminalTabs.svelte'
  import EditorTabs from '../editor/EditorTabs.svelte'
  import CodeEditor from '../editor/CodeEditor.svelte'
  import type { OpenFile } from '../../stores/activeFile.svelte'

  interface Props {
    worktreePath: string
    paneId: string
  }

  let { worktreePath, paneId }: Props = $props()

  // Per-pane file state (independent from other panes)
  let openFiles = $state<OpenFile[]>([])
  let activeFilePath = $state<string | null>(null)

  function openFile(path: string): void {
    if (!openFiles.some((f) => f.path === path)) {
      openFiles = [...openFiles, { path, modified: false }]
    }
    activeFilePath = path
  }

  function closeFile(path: string): void {
    const idx = openFiles.findIndex((f) => f.path === path)
    if (idx === -1) return
    openFiles = openFiles.filter((f) => f.path !== path)
    if (activeFilePath === path) {
      activeFilePath = openFiles.length > 0
        ? openFiles[Math.min(idx, openFiles.length - 1)].path
        : null
    }
  }

  function setActiveFile(path: string): void {
    if (openFiles.some((f) => f.path === path)) {
      activeFilePath = path
    }
  }

  function markModified(path: string, modified: boolean): void {
    openFiles = openFiles.map((f) => (f.path === path ? { ...f, modified } : f))
  }

  let splitPosition = $state(60)
  let isResizing = $state(false)

  function onResizeStart() {
    isResizing = true
    const container = document.getElementById(`pane-${paneId}`)!

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
  id="pane-{paneId}"
  class="flex h-full flex-col"
  class:select-none={isResizing}
>
  <!-- Top: file tree + editor area -->
  <div class="flex min-h-0" style:height="{splitPosition}%">
    <div class="w-48 flex-none overflow-y-auto border-r border-zinc-800 p-2">
      {#key worktreePath}
        <FileTree rootPath={worktreePath} onselect={openFile} />
      {/key}
    </div>
    <div class="flex flex-1 flex-col overflow-hidden">
      <EditorTabs
        {openFiles}
        {activeFilePath}
        onclose={closeFile}
        onselect={setActiveFile}
      />
      {#if activeFilePath}
        <div class="flex-1 min-h-0">
          <CodeEditor filePath={activeFilePath} onModified={markModified} />
        </div>
      {:else}
        <div class="flex flex-1 items-center justify-center">
          <p class="text-sm text-zinc-600">Open a file to start editing</p>
        </div>
      {/if}
    </div>
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="h-1 flex-none cursor-row-resize bg-zinc-800 hover:bg-blue-500 transition-colors"
    role="separator"
    aria-orientation="horizontal"
    tabindex="0"
    onmousedown={onResizeStart}
  ></div>

  <!-- Bottom: terminal area -->
  <div class="min-h-0 flex-1 bg-black">
    {#key worktreePath}
      <TerminalTabs {worktreePath} />
    {/key}
  </div>
</div>
