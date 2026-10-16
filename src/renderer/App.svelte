<script lang="ts">
  import { onMount } from 'svelte'
  import Sidebar from './components/sidebar/Sidebar.svelte'
  import SidebarRail from './components/sidebar/SidebarRail.svelte'
  import WorkspaceManager from './components/layout/WorkspaceManager.svelte'
  import ScreenPrsView from './components/screenprs/ScreenPrsView.svelte'
  import Welcome from './components/Welcome.svelte'
  import CommandPalette from './components/command-palette/CommandPalette.svelte'
  import { uiView } from './stores/uiView.svelte'
  import { clampSidebarWidth, loadSidebarWidths, saveSidebarWidth } from './lib/sidebarWidth'
  import { IS_MAC, sidebarShortcutsBlocked, viewForShortcut } from './lib/viewShortcuts'
  import { isToggleSidebarShortcut, SIDEBAR_RAIL_WIDTH } from './lib/sidebarCollapse'
  import { sidebarRail } from './stores/sidebarRail.svelte'
  import { initScreenPrsListeners } from './stores/screenprs.svelte'
  import { refreshWorktrees, setProjectRoot, projectRoot, mainWorktree } from './stores/worktrees.svelte'
  import { initAgentStatusListeners } from './stores/agent-status.svelte'
  import { initAgentMailListeners } from './stores/agent-mail.svelte'
  import { initSessionAttention } from './stores/sessionAttention.svelte'
  import { initAgentThreadsListeners } from './stores/agentThreads.svelte'
  import { backlogStore, initBacklogListeners } from './stores/backlog.svelte'
  import BacklogView from './components/backlog/BacklogView.svelte'
  import BacklogArrivalNotice from './components/backlog/BacklogArrivalNotice.svelte'
  import { initAgentCapabilities } from './stores/agent-capabilities.svelte'
  import { isPaletteOpen, togglePalette } from './stores/commandPalette.svelte'
  import { sessionsStore, initSessionListeners, createSessionFromDefaults } from './stores/sessions.svelte'
  import { hydrateSession, serializeSession } from './lib/sessionPersistence'
  import UpdateBanner from './components/UpdateBanner.svelte'
  import SettingsWindow from './components/settings/SettingsWindow.svelte'

  // A dedicated settings window loads the renderer with `?view=settings`. It's a
  // standalone surface — no Welcome/IDE bootstrap, palette, or session restore.
  const isSettingsView = new URLSearchParams(window.location.search).get('view') === 'settings'

  let sidebarWidths = $state(loadSidebarWidths())
  let sidebarWidth = $derived(sidebarWidths[uiView.current()])
  let sidebarCollapsed = $derived(sidebarRail.collapsed())
  let isResizing = $state(false)
  let repoPath = $state<string | null>(null)
  let sessionReady = $state(false)
  let repoName = $derived(
    repoPath
      ? repoPath.split('/').pop()?.replace('.git', '') ?? 'SimpleEdit'
      : 'SimpleEdit'
  )

  onMount(() => {
    if (isSettingsView) return
    const unsubStatus = initAgentStatusListeners()
    const unsubMail = initAgentMailListeners()
    const unsubAttention = initSessionAttention()
    const unsubSessions = initSessionListeners()
    const unsubScreenPrs = initScreenPrsListeners()
    const unsubThreads = initAgentThreadsListeners()
    const unsubBacklog = initBacklogListeners()
    // Cache every provider's capabilities up front: the session store reads
    // them synchronously when naming and labelling a new session.
    void initAgentCapabilities()
    void initRepoFromMain()
    window.addEventListener('beforeunload', flushSessionSave)
    return () => {
      unsubStatus()
      unsubMail()
      unsubAttention()
      unsubSessions()
      unsubScreenPrs()
      unsubThreads()
      unsubBacklog()
      window.removeEventListener('beforeunload', flushSessionSave)
    }
  })

  async function initRepoFromMain(): Promise<void> {
    const repo = await window.api.invoke('app:get-repo')
    if (repo) {
      await openRepo(repo)
    }
  }

  async function openRepo(path: string, persisted = true): Promise<void> {
    if (!persisted) {
      await window.api.invoke('app:set-repo', path)
    }
    repoPath = path
    setProjectRoot(path)
    void backlogStore.load()
    sessionsStore.reset()
    await refreshWorktrees()
    const saved = await window.api.invoke('session:load', path)
    if (saved) {
      hydrateSession(saved)
    }
    sessionsStore.markHydrated()
    // Defer enabling auto-save by one tick so initial hydration writes don't
    // round-trip back to disk before the user has done anything.
    queueMicrotask(() => { sessionReady = true })
  }

  async function handleRepoSelected(path: string): Promise<void> {
    await openRepo(path, false)
  }

  // ── Debounced auto-save ────────────────────────────────────
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleSave(): void {
    if (!sessionReady || !repoPath) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSessionSave, 500)
  }

  function flushSessionSave(): void {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (!repoPath) return
    const payload = serializeSession(repoPath)
    void window.api.invoke('session:save', payload)
  }

  // Watch for worktrees added/removed/moved outside SimpleEdit and refresh the
  // sidebar list when they change (#120). The main process watches the project
  // root per-window; we just react to its push event.
  $effect(() => {
    const repo = repoPath
    if (!repo) return
    void window.api.invoke('worktree:watch')
    const unsub = window.api.on('worktree:list-changed', () => {
      void refreshWorktrees()
    })
    return () => {
      unsub()
      void window.api.invoke('worktree:unwatch')
    }
  })

  // Reactive snapshot — touching every field we serialize triggers re-runs.
  $effect(() => {
    if (!sessionReady || !repoPath) return
    // Touch: serializeSession reads all of these via the store getters.
    // Calling it here makes the effect track them.
    serializeSession(repoPath)
    scheduleSave()
  })

  function handleGlobalKeydown(e: KeyboardEvent): void {
    if (isSettingsView) return
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      togglePalette()
      return
    }
    const target = e.target as HTMLElement | null
    const view = viewForShortcut(e, IS_MAC)
    const toggle = isToggleSidebarShortcut(e, IS_MAC, !!target?.classList.contains('xterm-helper-textarea'))
    if ((view || toggle) && !sidebarShortcutsBlocked(e)) {
      e.preventDefault()
      if (view) sidebarRail.showSection(view)
      else sidebarRail.toggleCollapsed()
      return
    }
    // ⌘T / Ctrl+T — new Claude session, focusing its terminal. Fires even while
    // a terminal is focused (the common case); xterm's helper textarea is
    // exempt from the text-field guard so the shortcut still reaches us there.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
      const tag = target?.tagName
      const inTextField =
        (tag === 'INPUT' || tag === 'TEXTAREA') &&
        !target?.classList.contains('xterm-helper-textarea')
      if (inTextField) return
      const wt = mainWorktree()
      const root = projectRoot() ?? wt?.path
      if (!root || !wt) return
      e.preventDefault()
      // A config that cannot be read is not a reason to start nothing: null
      // falls back to plain Claude, which is what the ✦ button and the phone
      // both do. Without this, ⌘T was the one gesture of the three that
      // silently did nothing at all.
      void window.api
        .invoke('models:config-get')
        .catch(() => null)
        .then((config) => {
          uiView.show('workspace')
          sessionsStore.requestTerminalFocus(createSessionFromDefaults(config, root, wt.path))
        })
    }
  }

  function onMouseDown() {
    isResizing = true
    // The open section's width; ⌘1–3 mid-drag doesn't move the drag to another.
    const view = uiView.current()

    function onMouseMove(e: MouseEvent) {
      sidebarWidths[view] = clampSidebarWidth(e.clientX)
    }

    function onMouseUp() {
      isResizing = false
      saveSidebarWidth(view, sidebarWidths[view])
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if isSettingsView}
  <SettingsWindow />
{:else}
{#if isPaletteOpen()}
  <CommandPalette />
{/if}

{#if repoPath}
  <div class="flex h-full flex-col" class:select-none={isResizing}>
    <UpdateBanner />
    <!-- Title bar / drag region -->
    <div class="drag-region flex h-9 flex-none items-center border-b border-zinc-700 bg-zinc-900">
      <!-- Collapsed, the block can't follow the rail: the traffic lights alone are wider. -->
      <div
        class="flex min-w-0 items-center gap-2 pl-[78px] pr-2"
        style:width={sidebarCollapsed ? undefined : `${sidebarWidth}px`}
      >
        <h1 class="min-w-0 truncate text-xs font-semibold tracking-wide text-zinc-400">SimpleEdit [{repoName}]</h1>
        <button
          class="ml-auto flex h-5 w-5 flex-none items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={sidebarCollapsed}
          title="{sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar ({IS_MAC ? '⌘B' : 'Ctrl+B'})"
          onclick={() => sidebarRail.toggleCollapsed()}
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d={sidebarCollapsed ? 'M6 4l4 4-4 4' : 'M10 4L6 8l4 4'} stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Main content below title bar -->
    <div class="relative flex min-h-0 flex-1">
      {#if sidebarCollapsed}
        <aside class="flex-none border-r border-zinc-700 bg-zinc-900" style:width="{SIDEBAR_RAIL_WIDTH}px">
          <SidebarRail widths={sidebarWidths} />
        </aside>
      {:else}
        <aside
          class="flex-none overflow-hidden border-r border-zinc-700 bg-zinc-900"
          style:width="{sidebarWidth}px"
        >
          <Sidebar />
        </aside>

        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div
          class="w-1 flex-none cursor-col-resize bg-zinc-800 hover:bg-blue-500 transition-colors"
          role="separator"
          aria-orientation="vertical"
          tabindex="0"
          onmousedown={onMouseDown}
        ></div>
      {/if}

      <main class="flex-1 overflow-hidden bg-zinc-950">
        {#if uiView.current() === 'screenprs'}
          <ScreenPrsView />
        {:else if uiView.current() === 'backlog'}
          <BacklogView />
        {/if}
        <!-- Hidden, not unmounted, behind the other views: a remount rebuilds
             every terminal from a truncated replay, loses editor state, and
             drops agent pushes (show_diff, tours) that arrive meanwhile. -->
        <div class="h-full" class:hidden={uiView.current() !== 'workspace'}>
          <WorkspaceManager />
        </div>
      </main>
    </div>
    <BacklogArrivalNotice />
  </div>
{:else}
  <div class="flex h-full flex-col">
    <UpdateBanner />
    <!-- Title bar / drag region (welcome) -->
    <div class="drag-region h-9 flex-none bg-zinc-950"></div>
    <Welcome onreposelected={handleRepoSelected} />
  </div>
{/if}
{/if}
