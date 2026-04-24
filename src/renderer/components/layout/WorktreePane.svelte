<script lang="ts">
  import FileTree from '../filetree/FileTree.svelte'
  import TerminalTabs from '../terminal/TerminalTabs.svelte'
  import AgentPopover from '../editor/AgentPopover.svelte'
  import PaneTabBar from './PaneTabBar.svelte'
  import TabContainer from './TabContainer.svelte'
  import {
    diffReviewStore,
    closeReview,
    startReview,
    startPlanReview,
    startTourReview,
    isPlanHash,
    getClaudeTerminalFromHash,
  } from '../../stores/diffReview.svelte'
  import { planStore } from '../../stores/planStore.svelte'
  import { tourStore } from '../../stores/tourStore.svelte'
  import { tabsStore, tabIdFor, type Tab, type FileTab, type DiffTab, type PlanTab } from '../../stores/tabsStore.svelte'
  import { createAgentTerminalStore } from '../../stores/agentTerminals.svelte'
  import { pendingPaletteAction, consumePaletteAction } from '../../stores/commandPalette.svelte'
  import type { AgentContext } from '../../lib/agent-message'

  interface Props {
    worktreePath: string
    paneId: string
  }

  let { worktreePath, paneId }: Props = $props()

  // Per-pane agent terminal store (shared between TerminalTabs and editors)
  const agentStore = createAgentTerminalStore()

  // Reactive view of the unified tab list for this worktree.
  let tabs = $derived(tabsStore.list(worktreePath))
  let activeTab = $derived(tabsStore.active(worktreePath))
  let activeId = $derived(tabsStore.activeId(worktreePath))
  let peekId = $derived(tabsStore.peekId(worktreePath))
  let unreadIds = $derived(new Set(tabs.filter((t) => tabsStore.isUnread(worktreePath, t.id)).map((t) => t.id)))

  // Mirror diffReviewStore → tabsStore. diffReviewStore remains the external
  // API for GitLog / palette / claude bridges until Phases 2/3 migrate them.
  let lastMirroredId = $state<string | null>(null)
  $effect(() => {
    const review = diffReviewStore.get(worktreePath)
    let nextTab: Tab | null = null
    if (review) {
      if (isPlanHash(review.hash)) {
        const claudeTerminalId = getClaudeTerminalFromHash(review.hash)
        const planHash = claudeTerminalId ? `claude-${claudeTerminalId}` : 'user-plan'
        const id = tabIdFor({ kind: 'plan', planHash })
        nextTab = {
          kind: 'plan',
          id,
          planHash,
          label: review.message,
          claudeTerminalId: claudeTerminalId ?? null,
        } satisfies PlanTab
      } else {
        const id = tabIdFor({ kind: 'diff', commitHash: review.hash })
        nextTab = {
          kind: 'diff',
          id,
          commitHash: review.hash,
          commitMessage: review.message,
          initialTab: review.initialTab,
        } satisfies DiffTab
      }
    }
    // Close the previous mirrored tab if switching targets (e.g. commit A → B).
    if (lastMirroredId && lastMirroredId !== nextTab?.id) {
      tabsStore.close(worktreePath, lastMirroredId)
    }
    if (nextTab) {
      tabsStore.open(worktreePath, nextTab)
      lastMirroredId = nextTab.id
    } else {
      lastMirroredId = null
    }
  })

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

  $effect(() => {
    const wt = worktreePath
    const unsub = window.api.on('plan:from-claude', (data) => {
      if (!data.key.startsWith(wt + ':')) return

      planStore.receivePlanFromClaude(data.key, data.terminalId, data.plan)

      const claudePlanHash = `plan-claude:${data.terminalId}`
      const current = diffReviewStore.get(wt)

      if (current && isPlanHash(current.hash)) {
        startPlanReview(wt, { hash: claudePlanHash, message: 'Claude Plan' })
      } else {
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

  $effect(() => {
    const wt = worktreePath
    const unsub = window.api.on('tour:from-claude', (data) => {
      if (data.worktreePath !== wt) return

      tourStore.receiveTourFromClaude(data.key, data.tour)

      const current = diffReviewStore.get(wt)
      const alreadyViewing = current !== undefined && current.hash === data.commitHash

      if (alreadyViewing) {
        return
      }

      const fileTabCount = tabsStore.list(wt).filter((t) => t.kind === 'file').length
      const paneEmpty = current === undefined && fileTabCount === 0
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

  // File tabs flow through tabsStore; opening a file in Phase 1 still clears
  // any active diff/plan via closeReview — that matches today's UX where
  // opening a file takes over the whole editor area. Phases 2/3 relax this.
  function openFile(path: string): void {
    closeReview(worktreePath)
    const tab: FileTab = {
      kind: 'file',
      id: tabIdFor({ kind: 'file', path }),
      path,
      modified: false,
    }
    tabsStore.open(worktreePath, tab)
  }

  function closeTab(tabId: string): void {
    const tab = tabsStore.list(worktreePath).find((t) => t.id === tabId)
    if (!tab) return
    if (tab.kind === 'diff' || tab.kind === 'plan') {
      // Round-trip through diffReviewStore so its closeReview "restore previous
      // plan state" logic still runs. The mirror effect handles the tab close.
      closeReview(worktreePath)
      return
    }
    tabsStore.close(worktreePath, tabId)
  }

  function selectTab(tabId: string): void {
    const tab = tabsStore.list(worktreePath).find((t) => t.id === tabId)
    if (!tab) return
    if (tab.kind === 'file') {
      // Today's behavior: focusing a file closes any open diff/plan review.
      closeReview(worktreePath)
    }
    tabsStore.focus(worktreePath, tabId)
  }

  function pinTab(tabId: string): void {
    tabsStore.pinPeek(worktreePath, tabId)
  }

  function reorderTabs(fromIndex: number, toIndex: number): void {
    tabsStore.reorder(worktreePath, fromIndex, toIndex)
  }

  function markModified(path: string, modified: boolean): void {
    tabsStore.patch(worktreePath, tabIdFor({ kind: 'file', path }), { modified } as Partial<FileTab>)
  }

  function closeActiveReview(): void {
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
      <PaneTabBar
        {tabs}
        {activeId}
        {peekId}
        unread={unreadIds}
        onselect={selectTab}
        onclose={closeTab}
        onpin={pinTab}
        onreorder={reorderTabs}
      />

      {#if activeTab}
        {#if activeTab.kind === 'file'}
          <TabContainer
            tab={activeTab}
            {worktreePath}
            terminals={agentStore.terminals}
            onclose={() => closeTab(activeTab!.id)}
            onFileModified={markModified}
            ondiscusswithagent={openAgentPopover}
            onsendtoagent={sendToAgent}
          />
        {:else}
          <TabContainer
            tab={activeTab}
            {worktreePath}
            terminals={agentStore.terminals}
            onclose={closeActiveReview}
            onFileModified={markModified}
            ondiscusswithagent={openAgentPopover}
            onsendtoagent={sendToAgent}
          />
        {/if}
      {:else}
        <div class="flex flex-1 items-center justify-center">
          <p class="text-sm text-zinc-600">Open a file to start editing</p>
        </div>
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
        <FileTree rootPath={worktreePath} onselect={openFile} oncollapse={toggleFileTree} />
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
