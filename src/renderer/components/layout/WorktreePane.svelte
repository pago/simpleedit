<script lang="ts">
  import FileTree from '../filetree/FileTree.svelte'
  import TerminalTabs from '../terminal/TerminalTabs.svelte'
  import EditorTabs from '../editor/EditorTabs.svelte'
  import CodeEditor from '../editor/CodeEditor.svelte'
  import DiffReview from '../editor/DiffReview.svelte'
  import PlanView from '../editor/PlanView.svelte'
  import AgentPopover from '../editor/AgentPopover.svelte'
  import type { OpenFile } from '../../stores/activeFile.svelte'
  import { diffReviewStore, closeReview, startReview, startPlanReview, startTourReview, isPlanHash, getClaudeTerminalFromHash } from '../../stores/diffReview.svelte'
  import { planStore } from '../../stores/planStore.svelte'
  import { tourStore } from '../../stores/tourStore.svelte'
  import { createAgentTerminalStore } from '../../stores/agentTerminals.svelte'
  import { pendingPaletteAction, consumePaletteAction } from '../../stores/commandPalette.svelte'
  import type { AgentContext } from '../../lib/agent-message'

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

  // Per-pane agent terminal store (shared between TerminalTabs and editors)
  const agentStore = createAgentTerminalStore()

  // Consume palette actions targeting this pane's worktree
  $effect(() => {
    const action = pendingPaletteAction()
    if (action?.type === 'open-file' && action.worktreePath === worktreePath) {
      consumePaletteAction()
      openFile(action.filePath)
    } else if (action?.type === 'start-review' && action.worktreePath === worktreePath) {
      consumePaletteAction()
      startReview(worktreePath, { hash: action.hash, message: action.message })
    }
  })

  // Plan-from-Claude notification state
  let pendingPlanNotification = $state<{ key: string; terminalId: string } | null>(null)

  // Listen for plan:from-claude events targeted at this worktree
  $effect(() => {
    const wt = worktreePath
    const unsub = window.api.on('plan:from-claude', (data) => {
      // The key format from MCP bridge is `worktreePath:claude-terminalId`
      if (!data.key.startsWith(wt + ':')) return

      // Store the plan data in the planStore
      planStore.receivePlanFromClaude(data.key, data.terminalId, data.plan)

      const claudePlanHash = `plan-claude:${data.terminalId}`
      const current = diffReviewStore.get(wt)

      if (current && isPlanHash(current.hash)) {
        // Already in plan mode — update in-place (store handles merge)
        startPlanReview(wt, { hash: claudePlanHash, message: 'Claude Plan' })
      } else {
        // Show non-intrusive notification instead of forcibly switching
        pendingPlanNotification = { key: data.key, terminalId: data.terminalId }
      }
    })
    return unsub
  })

  function activatePendingPlan(): void {
    if (!pendingPlanNotification) return
    const claudePlanHash = `plan-claude:${pendingPlanNotification.terminalId}`
    startPlanReview(worktreePath, { hash: claudePlanHash, message: 'Claude Plan' })
    pendingPlanNotification = null
  }

  function dismissPlanNotification(): void {
    pendingPlanNotification = null
  }

  // Tour-from-Claude notification state
  let pendingTourNotification = $state<{ commitHash: string | null; hasOpenQuestions: boolean } | null>(null)

  // Listen for tour:from-claude events targeted at this worktree
  $effect(() => {
    const wt = worktreePath
    const unsub = window.api.on('tour:from-claude', (data) => {
      if (data.worktreePath !== wt) return

      // Record the tour in the store so it's ready when the user opens it
      tourStore.receiveTourFromClaude(data.key, data.tour)

      const current = diffReviewStore.get(wt)
      const alreadyViewing = current !== undefined && current.hash === data.commitHash

      if (alreadyViewing) {
        // User is already in the matching review — leave their tab alone, tour content refreshes via the store
        return
      }

      const paneEmpty = current === undefined && openFiles.length === 0
      if (paneEmpty) {
        startTourReview(wt, data.commitHash, data.commitHash ? `Commit ${data.commitHash.slice(0, 7)}` : 'Uncommitted changes')
        return
      }

      pendingTourNotification = {
        commitHash: data.commitHash,
        hasOpenQuestions: (data.tour.openQuestions?.length ?? 0) > 0,
      }
    })
    return unsub
  })

  function activatePendingTour(): void {
    if (!pendingTourNotification) return
    const { commitHash } = pendingTourNotification
    startTourReview(worktreePath, commitHash, commitHash ? `Commit ${commitHash.slice(0, 7)}` : 'Uncommitted changes')
    pendingTourNotification = null
  }

  function dismissTourNotification(): void {
    pendingTourNotification = null
  }

  // Popover state
  let popoverState = $state<{ x: number; y: number; ctx: AgentContext } | null>(null)

  function openAgentPopover(ctx: AgentContext, pos: { x: number; y: number }): void {
    popoverState = { ...pos, ctx }
  }

  function handlePopoverSend(terminalId: string | 'new', message: string): void {
    if (terminalId === 'new') {
      agentStore.spawnAndSend(message)
    } else {
      agentStore.send(terminalId, message)
    }
    popoverState = null
  }

  function sendToAgent(terminalId: string | 'new', message: string): string | undefined {
    if (terminalId === 'new') {
      return agentStore.spawnAndSend(message)
    } else {
      agentStore.send(terminalId, message)
      return terminalId
    }
  }

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

  function reorderFiles(fromIndex: number, toIndex: number): void {
    const updated = [...openFiles]
    const [moved] = updated.splice(fromIndex, 1)
    updated.splice(toIndex, 0, moved)
    openFiles = updated
  }

  function closeDiffReview(): void {
    closeReview(worktreePath)
  }

  const FILE_TREE_COLLAPSED_KEY = 'simpleedit:fileTreeCollapsed'

  let fileTreeCollapsed = $state(localStorage.getItem(FILE_TREE_COLLAPSED_KEY) === 'true')

  function toggleFileTree(): void {
    fileTreeCollapsed = !fileTreeCollapsed
    localStorage.setItem(FILE_TREE_COLLAPSED_KEY, String(fileTreeCollapsed))
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
  class="relative flex h-full flex-col"
  class:select-none={isResizing}
>
  <!-- Plan notification toast -->
  {#if pendingPlanNotification}
    <div class="absolute left-1/2 top-2 z-20 -translate-x-1/2">
      <div class="flex items-center gap-2 rounded-lg border border-purple-800/50 bg-purple-950/90 px-3 py-2 shadow-lg backdrop-blur-sm">
        <span class="text-xs text-purple-300">✦ Claude generated a plan</span>
        <button
          class="rounded bg-purple-700 px-2 py-0.5 text-[10px] text-purple-200 hover:bg-purple-600"
          onclick={activatePendingPlan}
        >
          View
        </button>
        <button
          class="text-[10px] text-purple-500 hover:text-purple-300"
          onclick={dismissPlanNotification}
        >
          Dismiss
        </button>
      </div>
    </div>
  {/if}

  <!-- Tour notification toast -->
  {#if pendingTourNotification}
    <div class="absolute left-1/2 top-2 z-20 -translate-x-1/2">
      <div class="flex items-center gap-2 rounded-lg border border-sky-800/50 bg-sky-950/90 px-3 py-2 shadow-lg backdrop-blur-sm">
        <span class="text-xs text-sky-300">
          ✦ Claude finished a task
          {#if pendingTourNotification.hasOpenQuestions}
            <span class="ml-1 rounded bg-amber-900/60 px-1 py-px text-[9px] font-medium text-amber-200">Open questions</span>
          {/if}
        </span>
        <button
          class="rounded bg-sky-700 px-2 py-0.5 text-[10px] text-sky-200 hover:bg-sky-600"
          onclick={activatePendingTour}
        >
          View tour
        </button>
        <button
          class="text-[10px] text-sky-500 hover:text-sky-300"
          onclick={dismissTourNotification}
        >
          Dismiss
        </button>
      </div>
    </div>
  {/if}

  <!-- Top: editor/diff + file tree -->
  <div class="flex min-h-0" style:height="{verticalSplit}%">
    <!-- Editor / Diff review area (left, takes remaining space) -->
    <div class="flex flex-1 flex-col overflow-hidden">
      {#if reviewingCommit && isPlanHash(reviewingCommit.hash)}
        {@const claudeTerminalId = getClaudeTerminalFromHash(reviewingCommit.hash)}
        <PlanView
          {worktreePath}
          commitHash={claudeTerminalId ? `claude-${claudeTerminalId}` : 'user-plan'}
          terminals={agentStore.terminals}
          onclose={closeDiffReview}
          onsendtoagent={sendToAgent}
        />
      {:else if reviewingCommit}
        <DiffReview
          commitHash={reviewingCommit.hash}
          commitMessage={reviewingCommit.message}
          initialTab={reviewingCommit.initialTab}
          {worktreePath}
          terminals={agentStore.terminals}
          onclose={closeDiffReview}
          ondiscusswithagent={openAgentPopover}
          onsendtoagent={sendToAgent}
        />
      {:else}
        <EditorTabs
          {openFiles}
          {activeFilePath}
          onclose={closeFile}
          onselect={setActiveFile}
          onreorder={reorderFiles}
        />
        {#if activeFilePath}
          <div class="flex-1 min-h-0">
            <CodeEditor
              filePath={activeFilePath}
              worktreeRoot={worktreePath}
              onModified={markModified}
              ondiscusswithagent={openAgentPopover}
            />
          </div>
        {:else}
          <div class="flex flex-1 items-center justify-center">
            <p class="text-sm text-zinc-600">Open a file to start editing</p>
          </div>
        {/if}
      {/if}
    </div>

    {#if fileTreeCollapsed}
      <!-- Collapsed file tree: thin expand strip -->
      <button
        class="flex-none flex items-center justify-center w-6 border-l border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
        onclick={toggleFileTree}
        title="Expand file tree"
      >
        <span class="text-xs">⏴</span>
      </button>
    {:else}
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
        <FileTree
          rootPath={worktreePath}
          {activeFilePath}
          onselect={openFile}
          oncollapse={toggleFileTree}
        />
      </div>
    {/if}
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
    <TerminalTabs {worktreePath} {agentStore} />
  </div>

  {#if popoverState}
    <AgentPopover
      x={popoverState.x}
      y={popoverState.y}
      context={popoverState.ctx}
      terminals={agentStore.terminals}
      onclose={() => (popoverState = null)}
      onsend={handlePopoverSend}
    />
  {/if}
</div>
