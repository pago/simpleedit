<script lang="ts">
  import FileTree from '../filetree/FileTree.svelte'
  import TerminalTabs from '../terminal/TerminalTabs.svelte'
  import AgentPopover from '../editor/AgentPopover.svelte'
  import PaneTabBar from './PaneTabBar.svelte'
  import TabContainer from './TabContainer.svelte'
  import { openDiffTab, openPlanTab, openTourTab } from '../../stores/diffReview.svelte'
  import { planStore } from '../../stores/planStore.svelte'
  import { tourStore } from '../../stores/tourStore.svelte'
  import { tabsStore, tabIdFor, type FileTab, type ComposedTab } from '../../stores/tabsStore.svelte'
  import { createAgentTerminalStore } from '../../stores/agentTerminals.svelte'
  import { pendingPaletteAction, consumePaletteAction } from '../../stores/commandPalette.svelte'
  import type { AgentContext } from '../../lib/agent-message'

  interface Props {
    worktreePath: string
    paneId: string
    paneRole: 'primary' | 'secondary'
  }

  let { worktreePath, paneId, paneRole }: Props = $props()

  // Per-pane agent terminal store (shared between TerminalTabs and editors)
  const agentStore = createAgentTerminalStore()

  // Reactive view of the unified tab list for this worktree.
  let tabs = $derived(tabsStore.list(worktreePath))
  let activeTab = $derived(tabsStore.active(worktreePath))
  let activeId = $derived(tabsStore.activeId(worktreePath))
  let peekId = $derived(tabsStore.peekId(worktreePath))
  let unreadIds = $derived(new Set(tabs.filter((t) => tabsStore.isUnread(worktreePath, t.id)).map((t) => t.id)))
  let activeFilePath = $derived(activeTab?.kind === 'file' ? activeTab.path : null)

  // Consume palette actions targeting this pane's worktree
  $effect(() => {
    const action = pendingPaletteAction()
    if (action?.type === 'open-file' && action.worktreePath === worktreePath) {
      consumePaletteAction()
      openFile(action.filePath)
    }
  })

  // Plan-from-Claude: focus when the pane is idle, otherwise open in
  // background with the unread marker so we don't steal focus mid-task.
  $effect(() => {
    const wt = worktreePath
    const unsub = window.api.on('plan:from-claude', (data) => {
      if (!data.key.startsWith(wt + ':')) return

      planStore.receivePlanFromClaude(data.key, data.terminalId, data.plan)

      const paneIdle = tabsStore.activeId(wt) === null
      openPlanTab(wt, `claude-${data.terminalId}`, 'Claude Plan', {
        focus: paneIdle ? 'active' : 'background',
        claudeTerminalId: data.terminalId,
      })
    })
    return unsub
  })

  // Tour-from-Claude: same idle-vs-busy focus rule.
  $effect(() => {
    const wt = worktreePath
    const unsub = window.api.on('tour:from-claude', (data) => {
      if (data.worktreePath !== wt) return

      tourStore.receiveTourFromClaude(data.key, data.tour)

      const label = data.commitHash
        ? `Commit ${data.commitHash.slice(0, 7)}`
        : 'Uncommitted changes'
      const paneIdle = tabsStore.activeId(wt) === null
      openTourTab(wt, data.commitHash, label, {
        focus: paneIdle ? 'active' : 'background',
      })
    })
    return unsub
  })

  // Agent-composed panel from show_panel MCP call. One panel per source
  // terminal — re-opens replace the existing tab in place via tabsStore's
  // identity-based reuse. When the pane is idle (no active tab) we focus the
  // panel so the user sees it; when busy we open in the background with the
  // unread marker so we don't steal focus mid-task.
  $effect(() => {
    const wt = worktreePath
    const unsub = window.api.on('agent-panel:open', (data) => {
      if (data.worktreePath !== wt) return

      const composedId = `panel-${data.sourceTerminalId}`
      const tab: ComposedTab = {
        kind: 'composed',
        id: tabIdFor({ kind: 'composed', id: composedId }),
        title: data.title,
        spec: data.spec,
        terminalId: data.sourceTerminalId,
      }
      const paneIdle = tabsStore.activeId(wt) === null
      tabsStore.open(wt, tab, { focus: paneIdle ? 'active' : 'background' })
    })
    return unsub
  })

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
    const tab: FileTab = {
      kind: 'file',
      id: tabIdFor({ kind: 'file', path }),
      path,
      modified: false,
    }
    tabsStore.open(worktreePath, tab)
  }

  function closeTab(tabId: string): void {
    tabsStore.close(worktreePath, tabId)
  }

  function selectTab(tabId: string): void {
    tabsStore.focus(worktreePath, tabId)
  }

  function pinTab(tabId: string): void {
    tabsStore.pinPeek(worktreePath, tabId)
  }

  function reorderTabs(fromIndex: number, toIndex: number): void {
    tabsStore.reorder(worktreePath, fromIndex, toIndex)
  }

  function markModified(path: string, modified: boolean): void {
    tabsStore.setFileModified(worktreePath, tabIdFor({ kind: 'file', path }), modified)
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
    <TerminalTabs {worktreePath} {agentStore} {paneRole} />
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
