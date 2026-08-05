<script lang="ts">
  import { onMount } from 'svelte'
  import Sidebar from './components/sidebar/Sidebar.svelte'
  import WorkspaceManager from './components/layout/WorkspaceManager.svelte'
  import ScreenPrsView from './components/screenprs/ScreenPrsView.svelte'
  import Welcome from './components/Welcome.svelte'
  import CommandPalette from './components/command-palette/CommandPalette.svelte'
  import { uiView } from './stores/uiView.svelte'
  import { initScreenPrsListeners } from './stores/screenprs.svelte'
  import { refreshWorktrees, setProjectRoot, projectRoot, mainWorktree } from './stores/worktrees.svelte'
  import { initAgentStatusListeners } from './stores/agent-status.svelte'
  import { isPaletteOpen, togglePalette } from './stores/commandPalette.svelte'
  import { sessionsStore, initSessionListeners } from './stores/sessions.svelte'
  import { hydrateSession, serializeSession } from './lib/sessionPersistence'
  import UpdateBanner from './components/UpdateBanner.svelte'
  import SettingsWindow from './components/settings/SettingsWindow.svelte'

  // A dedicated settings window loads the renderer with `?view=settings`. It's a
  // standalone surface — no Welcome/IDE bootstrap, palette, or session restore.
  const isSettingsView = new URLSearchParams(window.location.search).get('view') === 'settings'

  let sidebarWidth = $state(260)
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
    const unsubSessions = initSessionListeners()
    const unsubScreenPrs = initScreenPrsListeners()
    void initRepoFromMain()
    window.addEventListener('beforeunload', flushSessionSave)
    return () => {
      unsubStatus()
      unsubSessions()
      unsubScreenPrs()
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
    sessionsStore.reset()
    await refreshWorktrees()
    const saved = await window.api.invoke('session:load', path)
    if (saved) {
      hydrateSession(saved)
    }
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
    // ⌘T / Ctrl+T — new Claude session, focusing its terminal. Fires even while
    // a terminal is focused (the common case); xterm's helper textarea is
    // exempt from the text-field guard so the shortcut still reaches us there.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const inTextField =
        (tag === 'INPUT' || tag === 'TEXTAREA') &&
        !target?.classList.contains('xterm-helper-textarea')
      if (inTextField) return
      const wt = mainWorktree()
      const root = projectRoot() ?? wt?.path
      if (!root || !wt) return
      e.preventDefault()
      void window.api.invoke('models:config-get').then((config) => {
        const id = config.lastUsed?.provider === 'openai'
          ? sessionsStore.createCodex(root, wt.path, { model: config.lastUsed.model, reasoningEffort: config.lastUsed.reasoningEffort })
          : sessionsStore.createClaude(root, wt.path)
        sessionsStore.requestTerminalFocus(id)
      })
    }
  }

  function onMouseDown() {
    isResizing = true

    function onMouseMove(e: MouseEvent) {
      sidebarWidth = Math.max(180, Math.min(500, e.clientX))
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
      <div class="flex items-center gap-2 pl-[78px]" style:width="{sidebarWidth}px">
        <h1 class="text-xs font-semibold tracking-wide text-zinc-400">SimpleEdit [{repoName}]</h1>
      </div>
    </div>

    <!-- Main content below title bar -->
    <div class="flex min-h-0 flex-1">
      <aside
        class="flex-none overflow-y-auto border-r border-zinc-700 bg-zinc-900"
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

      <main class="flex-1 overflow-hidden bg-zinc-950">
        {#if uiView.current() === 'screenprs'}
          <ScreenPrsView />
        {:else}
          <WorkspaceManager />
        {/if}
      </main>
    </div>
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
