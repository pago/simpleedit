<script lang="ts">
  import FileTree from '../filetree/FileTree.svelte'
  import Terminal from '../terminal/Terminal.svelte'
  import GitLog from '../sidebar/GitLog.svelte'
  import WorktreeList from '../sidebar/WorktreeList.svelte'
  import AgentPopover from '../editor/AgentPopover.svelte'
  import PaneTabBar from './PaneTabBar.svelte'
  import TabContainer from './TabContainer.svelte'
  import RepoPicker from './RepoPicker.svelte'
  import { openDiffTab, openTourTab } from '../../stores/diffReview.svelte'
  import { tourStore } from '../../stores/tourStore.svelte'
  import { tabsStore, tabIdFor, type FileTab, type ComposedTab } from '../../stores/tabsStore.svelte'
  import { sessionsStore } from '../../stores/sessions.svelte'
  import { providerLabel } from '../../stores/agent-capabilities.svelte'
  import { worktreeLabel } from '../../lib/worktreeLabel'
  import {
    projectRoot,
    primaryRepo,
    worktreeListFor,
    mainWorktreeFor,
    refreshWorktreesFor,
    repoForWorktree,
  } from '../../stores/worktrees.svelte'
  import { pendingPaletteAction, consumePaletteAction } from '../../stores/commandPalette.svelte'
  import type { AgentContext } from '../../lib/agent-message'
  import type { AgentTabInfo } from '../../stores/agentTerminals.svelte'

  interface Props {
    sessionId: string
  }

  let { sessionId }: Props = $props()

  let session = $derived(sessionsStore.get(sessionId))
  let worktreePath = $derived(session?.worktreePath ?? '')

  // Reactive view of this session's tab list (tabsStore keyed by session id).
  let tabs = $derived(tabsStore.list(sessionId))
  let activeTab = $derived(tabsStore.active(sessionId))
  let activeId = $derived(tabsStore.activeId(sessionId))
  let peekId = $derived(tabsStore.peekId(sessionId))
  let unreadIds = $derived(new Set(tabs.filter((t) => tabsStore.isUnread(sessionId, t.id)).map((t) => t.id)))
  let activeFilePath = $derived(activeTab?.kind === 'file' ? activeTab.path : null)

  /**
   * Progressive disclosure: a fresh session is just a full-bleed terminal.
   * The viewer chrome (tabs + file tree + git log) appears when the first tab
   * opens, or when the user toggles it explicitly; it never auto-hides.
   *
   * Lives on the session (not component-local) so the global cwd listener can
   * read it: the agent only auto-repoints the view while the viewer is CLOSED.
   */
  let viewerOpen = $derived(session?.viewerOpen ?? false)
  function setViewerOpen(open: boolean): void {
    sessionsStore.setViewerOpen(sessionId, open)
  }
  $effect(() => {
    if (tabs.length > 0) setViewerOpen(true)
  })

  // All live Claude sessions are valid "Discuss with Agent" targets; the
  // owning session naturally sorts first.
  let agentTargets = $derived.by((): AgentTabInfo[] => {
    const claude = sessionsStore
      .sessions()
      .filter((s) => s.kind === 'agent' && !s.pendingResume)
      .map((s) => ({ id: s.id, label: s.label }))
    return claude.sort((a, b) => (a.id === sessionId ? -1 : b.id === sessionId ? 1 : 0))
  })

  // Consume palette actions targeting this session's workspace
  $effect(() => {
    const action = pendingPaletteAction()
    if (action?.type === 'open-file' && action.workspaceKey === sessionId) {
      consumePaletteAction()
      openFile(action.filePath)
    }
  })

  // Tour-from-Claude: focus when the workspace is idle, otherwise open in
  // background with the unread marker so we don't steal focus mid-task. Routed by session.
  $effect(() => {
    const sid = sessionId
    const unsub = window.api.on('tour:from-agent', (data) => {
      if (data.terminalId !== sid) return

      tourStore.receiveTourFromClaude(data.key, data.tour)

      const label = data.commitHash
        ? `Commit ${data.commitHash.slice(0, 7)}`
        : 'Uncommitted changes'
      const idle = tabsStore.activeId(sid) === null
      openTourTab(sid, data.worktreePath, data.commitHash, label, {
        focus: idle ? 'active' : 'background',
      })
    })
    return unsub
  })

  // Agent-composed panel from show_panel MCP call. Panels are keyed by the
  // agent's `panelId` so a tour and a decision panel from the same session
  // coexist as separate tabs; without one, the session gets a single panel that
  // re-opens replace in place via tabsStore's identity-based reuse.
  $effect(() => {
    const sid = sessionId
    const unsub = window.api.on('agent-panel:open', (data) => {
      if (data.sourceTerminalId !== sid) return

      const composedId = data.panelId
        ? `panel-${data.sourceTerminalId}-${data.panelId}`
        : `panel-${data.sourceTerminalId}`
      const tabId = tabIdFor({ kind: 'composed', id: composedId })
      const tab: ComposedTab = {
        kind: 'composed',
        id: tabId,
        title: data.title,
        spec: data.spec,
        terminalId: data.sourceTerminalId,
      }
      const activeBefore = tabsStore.activeId(sid)
      const idle = activeBefore === null
      const wasOpenAndUnfocused =
        !idle && activeBefore !== tabId && tabsStore.list(sid).some((t) => t.id === tabId)
      tabsStore.open(sid, tab, { focus: idle ? 'active' : 'background' })
      // open() only adds the unread marker for *new* tabs — surface in-place
      // updates of a background panel explicitly.
      if (wasOpenAndUnfocused) tabsStore.markUnread(sid, tabId)
    })
    return unsub
  })

  // open_worktree MCP call: repoint this session's workspace at a worktree the
  // agent named. Opening the viewer makes the repoint visible immediately
  // (otherwise a fresh session stays full-bleed terminal).
  $effect(() => {
    const sid = sessionId
    const unsub = window.api.on('agent-workspace:open-worktree', (data) => {
      if (data.sourceTerminalId !== sid) return
      sessionsStore.setWorktree(sid, data.worktreePath, repoForWorktree(data.worktreePath))
      setViewerOpen(true)
    })
    return unsub
  })

  // show_diff MCP call: open a diff tab in this session's workspace, scoped to
  // the named worktree. Mirrors the idle-vs-busy focus rule of tour.
  $effect(() => {
    const sid = sessionId
    const unsub = window.api.on('agent-workspace:show-diff', (data) => {
      if (data.sourceTerminalId !== sid) return
      const label =
        data.commitHash === null
          ? 'Uncommitted changes'
          : data.commitHash === 'branch'
            ? 'Branch changes'
            : `Commit ${data.commitHash.slice(0, 7)}`
      const idle = tabsStore.activeId(sid) === null
      openDiffTab(sid, data.worktreePath, data.commitHash, label, {
        focus: idle ? 'active' : 'background',
      })
    })
    return unsub
  })

  // Popover state
  let popoverState = $state<{ x: number; y: number; ctx: AgentContext } | null>(null)

  function openAgentPopover(ctx: AgentContext, pos: { x: number; y: number }): void {
    popoverState = { ...pos, ctx }
  }

  function handlePopoverSend(terminalId: string | 'new', message: string): void {
    sendToAgent(terminalId, message)
    popoverState = null
  }

  function sendToAgent(terminalId: string | 'new', message: string): string | undefined {
    if (terminalId === 'new') {
      const target = session?.target ?? { provider: 'claude' as const }
      const id = sessionsStore.createAgent(target, projectRoot() ?? worktreePath, worktreePath, {
        initialPrompt: message,
        ...(target.provider === 'claude' && target.model ? { model: target.model } : {}),
      })
      return id
    }
    sessionsStore.select(terminalId)
    void window.api.invoke('pty:write', terminalId, message + '\r')
    return terminalId
  }

  function openFile(path: string): void {
    const tab: FileTab = {
      kind: 'file',
      id: tabIdFor({ kind: 'file', path }),
      path,
      modified: false,
    }
    tabsStore.open(sessionId, tab)
  }

  function closeTab(tabId: string): void {
    tabsStore.close(sessionId, tabId)
  }

  function selectTab(tabId: string): void {
    tabsStore.focus(sessionId, tabId)
  }

  function pinTab(tabId: string): void {
    tabsStore.pinPeek(sessionId, tabId)
  }

  function reorderTabs(fromIndex: number, toIndex: number): void {
    tabsStore.reorder(sessionId, fromIndex, toIndex)
  }

  function markModified(path: string, modified: boolean): void {
    tabsStore.setFileModified(sessionId, tabIdFor({ kind: 'file', path }), modified)
  }

  // ── worktree popover ─────────────────────────────────────────────────────
  // The header button opens the full worktree manager (select / create /
  // checkout / delete) — the only home for worktree CRUD since the sidebar
  // is sessions-only.
  let worktreePopoverOpen = $state(false)
  let worktreePopoverEl = $state<HTMLElement | null>(null)
  let worktreeButtonEl = $state<HTMLButtonElement | undefined>()

  // The repo this session's viewer is scoped to (undefined = window primary).
  let repoPath = $derived(session?.repoPath)

  // Lazily load a non-primary repo's worktrees so the popover/label resolve
  // (covers sessions restored pointing at another repo). Idempotent + cached.
  $effect(() => {
    const repo = repoPath
    if (repo && worktreeListFor(repo).length === 0) {
      void refreshWorktreesFor(repo)
    }
  })

  let worktreeBranch = $derived.by(() => {
    const wt = worktreeListFor(repoPath).find((w) => w.path === worktreePath)
    return wt ? worktreeLabel(wt) : (worktreePath.split('/').pop() ?? '—')
  })

  // "Open another repo…" fallback from RepoPicker: points this session's
  // workspace at a bare repo via the directory dialog (does not change
  // launchDir or the session model). Normal repo switching goes through the
  // RepoPicker dropdown over the agent's touched repos.
  async function pickRepo(): Promise<void> {
    const picked = await window.api.invoke('app:pick-repo')
    if (!picked) return
    // Loading the repo's worktrees registers it with the window (so cwd
    // tracking / open_worktree resolve across it) and lets us land on its main.
    await refreshWorktreesFor(picked)
    const main = mainWorktreeFor(picked)
    if (!main) return
    // Normalize: undefined repoPath = the window's primary repo, so
    // worktreeListFor / repoForWorktree agree on a single representation.
    const repoArg = picked === primaryRepo() ? undefined : picked
    sessionsStore.setActiveSessionWorktree(main.path, repoArg)
    setViewerOpen(true)
  }

  function handleWindowPointerDown(e: PointerEvent): void {
    if (!worktreePopoverOpen) return
    const target = e.target as Node
    if (worktreePopoverEl?.contains(target) || worktreeButtonEl?.contains(target)) return
    worktreePopoverOpen = false
  }

  function handleWindowKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && worktreePopoverOpen) {
      worktreePopoverOpen = false
      worktreeButtonEl?.focus()
    }
  }

  const FILE_TREE_COLLAPSED_KEY = 'simpleedit:fileTreeCollapsed'

  let fileTreeCollapsed = $state(localStorage.getItem(FILE_TREE_COLLAPSED_KEY) === 'true')

  function toggleFileTree(): void {
    fileTreeCollapsed = !fileTreeCollapsed
    localStorage.setItem(FILE_TREE_COLLAPSED_KEY, String(fileTreeCollapsed))
  }

  const GIT_LOG_COLLAPSED_KEY = 'simpleedit:gitLogCollapsed'

  let gitLogCollapsed = $state(localStorage.getItem(GIT_LOG_COLLAPSED_KEY) === 'true')

  function toggleGitLog(): void {
    gitLogCollapsed = !gitLogCollapsed
    localStorage.setItem(GIT_LOG_COLLAPSED_KEY, String(gitLogCollapsed))
  }

  let verticalSplit = $state(60)
  let rightColumnWidth = $state(260)
  let isResizingVertical = $state(false)
  let isResizingRightColumn = $state(false)

  function onVerticalResizeStart() {
    isResizingVertical = true
    const container = document.getElementById(`workspace-${sessionId}`)!

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

  function onRightColumnResizeStart() {
    isResizingRightColumn = true
    const container = document.getElementById(`workspace-${sessionId}`)!

    function onMouseMove(e: MouseEvent) {
      const rect = container.getBoundingClientRect()
      const width = rect.right - e.clientX
      rightColumnWidth = Math.max(160, Math.min(500, width))
    }

    function onMouseUp() {
      isResizingRightColumn = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  let isResizing = $derived(isResizingVertical || isResizingRightColumn)

  function resumeSession(): void {
    sessionsStore.resumePlaceholder(sessionId)
  }
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

{#if session}
  <div
    id="workspace-{sessionId}"
    class="relative flex h-full flex-col"
    class:select-none={isResizing}
  >
    <!-- Workspace header: worktree selector + viewer toggle -->
    <div class="flex h-7 flex-none items-center justify-between border-b border-zinc-800 bg-zinc-900 px-2">
      <span class="truncate text-[11px] font-medium text-zinc-400">{session.label}</span>
      <div class="relative flex items-center gap-1">
        <!-- Repo picker (viewer-only) — LEFT of the worktree picker. Lists the
             repos this agent has worked across; "Open another…" falls back to
             the directory dialog. -->
        <RepoPicker {repoPath} onpickother={pickRepo} />
        <button
          bind:this={worktreeButtonEl}
          class="max-w-[220px] truncate rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
          onclick={() => (worktreePopoverOpen = !worktreePopoverOpen)}
          aria-haspopup="dialog"
          aria-expanded={worktreePopoverOpen}
          title="Worktree this workspace is pointed at — click to switch or manage"
        >
          {worktreeBranch} ▾
        </button>
        <button
          class="rounded px-1.5 py-0.5 text-[10px] {viewerOpen ? 'text-zinc-300 bg-zinc-800' : 'text-zinc-500'} hover:bg-zinc-700 hover:text-zinc-300"
          onclick={() => setViewerOpen(!viewerOpen)}
          title={viewerOpen ? 'Hide files, git log and editor' : 'Show files, git log and editor'}
        >
          Files
        </button>

        {#if worktreePopoverOpen}
          <div
            bind:this={worktreePopoverEl}
            class="absolute right-0 top-full z-30 mt-1 max-h-96 w-72 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 px-3 pb-2 shadow-xl"
            role="dialog"
            aria-label="Worktrees"
          >
            <WorktreeList {repoPath} onselected={() => (worktreePopoverOpen = false)} />
          </div>
        {/if}
      </div>
    </div>

    {#if viewerOpen}
      <!-- Top: editor/diff + right column (file tree over git log) -->
      <div class="flex min-h-0" style:height="{verticalSplit}%">
        <div class="flex flex-1 flex-col overflow-hidden">
          <PaneTabBar
            {tabs}
            {activeId}
            {peekId}
            unread={unreadIds}
            {activeTab}
            onselect={selectTab}
            onclose={closeTab}
            onpin={pinTab}
            onreorder={reorderTabs}
          />

          {#if activeTab}
            <TabContainer
              tab={activeTab}
              workspaceKey={sessionId}
              {worktreePath}
              terminals={agentTargets}
              onclose={() => closeTab(activeTab!.id)}
              onFileModified={markModified}
              ondiscusswithagent={openAgentPopover}
              onsendtoagent={sendToAgent}
              onOpenFile={openFile}
            />
          {:else}
            <div class="flex flex-1 items-center justify-center">
              <p class="text-sm text-zinc-600">Open a file to start editing</p>
            </div>
          {/if}
        </div>

        {#if fileTreeCollapsed}
          <button
            class="flex-none flex items-center justify-center w-6 border-l border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            onclick={toggleFileTree}
            title="Expand file tree"
          >
            <span class="text-xs">⏴</span>
          </button>
        {:else}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div
            class="w-1 flex-none cursor-col-resize bg-zinc-800 hover:bg-blue-500 transition-colors"
            role="separator"
            aria-orientation="vertical"
            tabindex="0"
            onmousedown={onRightColumnResizeStart}
          ></div>

          <!-- Right column: file tree above git log, both scoped to the
               session's selected worktree. -->
          <div
            class="flex flex-none flex-col border-l border-zinc-800"
            style:width="{rightColumnWidth}px"
          >
            <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              <FileTree
                rootPath={worktreePath}
                {activeFilePath}
                onselect={openFile}
                oncollapse={toggleFileTree}
              />
            </div>
            <div
              class="border-t border-zinc-800 bg-zinc-900 px-3 {gitLogCollapsed
                ? 'flex-none pb-1'
                : 'min-h-0 flex-1 overflow-y-auto pb-2'}"
            >
              <GitLog
                workspaceKey={sessionId}
                worktreePath={worktreePath || null}
                collapsed={gitLogCollapsed}
                ontoggle={toggleGitLog}
              />
            </div>
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
    {/if}

    {#if session.exited}
      <div class="flex flex-none items-center gap-2 border-b border-red-900/50 bg-red-950/40 px-3 py-1.5">
        <span class="h-2 w-2 flex-none rounded-full bg-red-500"></span>
        <p class="flex-1 text-xs text-red-300">
          Process exited with code {session.exited.exitCode} — its last output is below.
        </p>
        <button
          class="rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
          onclick={() => sessionsStore.close(sessionId)}
        >
          Close session
        </button>
      </div>
    {/if}

    <!-- Terminal: full-bleed until the viewer opens, bottom strip after -->
    <div class="min-h-0 flex-1 bg-black">
      <!--
        The agent asks for hook trust itself, in its own terminal, on the first
        launch. This band only explains WHY it is asking and that answering is a
        one-time cost — it deliberately offers no button: typing a slash command
        into a live TUI races whatever the agent is already showing, and writing
        to the PTY is precisely what the messaging design avoids. It clears on
        the first provider-native signal.
      -->
      {#if session.reportingSetupNeeded && !session.pendingResume}
        <div class="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
          Answer {providerLabel(session.provider)}'s trust prompt below to turn on status and
          worktree tracking — once per machine. Until then this session uses basic PTY signals.
        </div>
      {/if}
      {#if session.pendingResume}
        <div class="flex h-full flex-col items-center justify-center gap-3 text-zinc-400">
          <p class="text-xs">{providerLabel(session.provider)} session from your last visit</p>
          <button
            class="rounded border border-orange-500/40 bg-orange-500/10 px-3 py-1 text-xs text-orange-300 hover:bg-orange-500/20"
            onclick={resumeSession}
          >
            Resume {session.label}
          </button>
          <p class="text-[10px] text-zinc-600">session id {session.pendingResume.sessionId.slice(0, 8)}…</p>
        </div>
      {:else}
        <Terminal
          terminalId={sessionId}
          active={sessionsStore.activeSessionId() === sessionId}
          provider={session.provider}
          ontitlechange={(title) => sessionsStore.applyOscTitle(sessionId, title)}
        />
      {/if}
    </div>

    {#if popoverState}
      <AgentPopover
        x={popoverState.x}
        y={popoverState.y}
        context={popoverState.ctx}
        terminals={agentTargets}
        onclose={() => (popoverState = null)}
        onsend={handlePopoverSend}
      />
    {/if}
  </div>
{/if}
