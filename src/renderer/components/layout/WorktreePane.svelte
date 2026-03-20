<script lang="ts">
  import FileTree from '../filetree/FileTree.svelte'
  import TerminalTabs from '../terminal/TerminalTabs.svelte'
  import EditorTabs from '../editor/EditorTabs.svelte'
  import CodeEditor from '../editor/CodeEditor.svelte'
  import DiffReview from '../editor/DiffReview.svelte'
  import type { OpenFile } from '../../stores/activeFile.svelte'
  import { diffReviewStore, closeReview } from '../../stores/diffReview.svelte'

  interface Props {
    worktreePath: string
    paneId: string
  }

  let { worktreePath, paneId }: Props = $props()

  // Per-pane file state (independent from other panes)
  let openFiles = $state<OpenFile[]>([])
  let activeFilePath = $state<string | null>(null)

  // Diff review state from store
  let reviewingCommit = $derived(diffReviewStore.get(worktreePath) ?? null)

  // Reference to TerminalTabs for sending Claude messages
  let terminalTabsRef = $state<{ sendToClaude: (msg: string) => void } | null>(null)

  function openFile(path: string): void {
    closeReview(worktreePath)
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
    closeReview(worktreePath)
    if (openFiles.some((f) => f.path === path)) {
      activeFilePath = path
    }
  }

  function markModified(path: string, modified: boolean): void {
    openFiles = openFiles.map((f) => (f.path === path ? { ...f, modified } : f))
  }

  function closeDiffReview(): void {
    closeReview(worktreePath)
  }

  function sendToClaude(message: string): void {
    terminalTabsRef?.sendToClaude(message)
  }

  let verticalSplit = $state(60)
  let fileTreeWidth = $state(220)
  let isResizingVertical = $state(false)
  let isResizingFileTree = $state(false)

  function onVerticalResizeStart() {
    isResizingVertical = true
    const container = document.getElementById(`pane-${paneId}`)!

    function onMouseMove(e: MouseEvent) {
      const rect = container.getBoundingClientRect()
      const pct = ((e.clientY - rect.top) / rect.height) * 100
      verticalSplit = Math.max(20, Math.min(80, pct))
    }

    function onMouseUp() {
      isResizingVertical = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  function onFileTreeResizeStart() {
    isResizingFileTree = true
    const container = document.getElementById(`pane-${paneId}`)!

    function onMouseMove(e: MouseEvent) {
      const rect = container.getBoundingClientRect()
      const width = rect.right - e.clientX
      fileTreeWidth = Math.max(120, Math.min(500, width))
    }

    function onMouseUp() {
      isResizingFileTree = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  let isResizing = $derived(isResizingVertical || isResizingFileTree)
</script>

<div
  id="pane-{paneId}"
  class="flex h-full flex-col"
  class:select-none={isResizing}
>
  <!-- Top: editor/diff + file tree -->
  <div class="flex min-h-0" style:height="{verticalSplit}%">
    <!-- Editor / Diff review area (left, takes remaining space) -->
    <div class="flex flex-1 flex-col overflow-hidden">
      {#if reviewingCommit}
        <DiffReview
          commitHash={reviewingCommit.hash}
          commitMessage={reviewingCommit.message}
          {worktreePath}
          onclose={closeDiffReview}
          onsendtoclaude={sendToClaude}
        />
      {:else}
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
      {/if}
    </div>

    <!-- File tree resize handle -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="w-1 flex-none cursor-col-resize bg-zinc-800 hover:bg-blue-500 transition-colors"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      onmousedown={onFileTreeResizeStart}
    ></div>

    <!-- File tree (right side, resizable) -->
    <div
      class="flex-none overflow-y-auto border-l border-zinc-800 p-2"
      style:width="{fileTreeWidth}px"
    >
      {#key worktreePath}
        <FileTree rootPath={worktreePath} onselect={openFile} />
      {/key}
    </div>
  </div>

  <!-- Vertical resize handle -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="h-1 flex-none cursor-row-resize bg-zinc-800 hover:bg-blue-500 transition-colors"
    role="separator"
    aria-orientation="horizontal"
    tabindex="0"
    onmousedown={onVerticalResizeStart}
  ></div>

  <!-- Bottom: terminal area -->
  <div class="min-h-0 flex-1 bg-black">
    {#key worktreePath}
      <TerminalTabs
        {worktreePath}
        bind:this={terminalTabsRef}
      />
    {/key}
  </div>
</div>
