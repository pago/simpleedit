<script lang="ts">
  import Terminal from './Terminal.svelte'
  import ContextMenu, { type ContextMenuItem } from '../ContextMenu.svelte'
  import ForkWorktreePicker, { type ForkTarget } from './ForkWorktreePicker.svelte'
  import PromptModal from '../PromptModal.svelte'
  import type { AgentTerminalStore } from '../../stores/agentTerminals.svelte'
  import { sessionRestoreStore } from '../../stores/sessionRestore.svelte'
  import { refreshWorktrees } from '../../stores/worktrees.svelte'

  interface Props {
    worktreePath: string
    agentStore: AgentTerminalStore
    paneRole: 'primary' | 'secondary'
  }

  let { worktreePath, agentStore, paneRole }: Props = $props()

  interface TabInfo {
    id: string
    label: string
    isClaude: boolean
    /** True for `claude agents` (Agent View) tabs. Implies isClaude is true. */
    isAgentView?: boolean
    /** True when the user explicitly renamed the tab. handleTitleChange skips
     * updates for these so the OSC title from the PTY can't overwrite it. */
    customLabel?: boolean
    /** When set, this is a placeholder for a Claude session that was running
     * before the last quit. The Terminal is not mounted; the tab renders a
     * "Resume" button that, on click, spawns claude --resume <id>. */
    pendingResume?: { sessionId: string }
    /** Fork-in-flight: italic-dimmed placeholder until claude:fork-result. */
    forking?: { sourceLabel: string }
    /** Fork failed: short-lived error chip; auto-cleared after ~6s. */
    forkError?: string
  }

  let tabs: TabInfo[] = $state([])
  let activeTabId: string | undefined = $state(undefined)
  let nextIndex = $state(1)
  let nextClaudeIndex = $state(1)
  let nextAgentsIndex = $state(1)

  let claudeMenu: { x: number; y: number } | null = $state(null)
  let claudeButtonEl: HTMLButtonElement | undefined = $state()

  /** Per-tab context menu state. Anchored at click position; null = closed. */
  let tabMenu: { tabId: string; x: number; y: number } | null = $state(null)
  /** References to each tab's ⋯ button so we can restore focus on menu close. */
  let tabMenuButtonEls: Map<string, HTMLElement> = $state(new Map())
  /** Tab being renamed (null when no rename modal is open). */
  let renameTarget: { id: string; currentLabel: string } | null = $state(null)
  /**
   * Worktree-picker state for the Fork flow. When set, the tab context menu
   * is hidden in favor of an inline picker anchored at the same point. Esc
   * goes back to the action menu (designer's "Esc-once pops" UX).
   */
  let forkPicker:
    | { tabId: string; sourceLabel: string; sourceSessionId: string; x: number; y: number }
    | null = $state(null)
  /**
   * Pending fork-error auto-dismiss timers, keyed by placeholder tab id. We
   * track these so closing the tab manually (or unmounting the component)
   * cancels the timer instead of letting it fire stale.
   */
  const forkErrorDismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

  let dragIndex: number | null = $state(null)
  let dropIndex: number | null = $state(null)

  // crypto.randomUUID() instead of `${Date.now()}-${nextIndex}`: when several
  // TerminalTabs instances mount in the same tick (e.g. PaneManager rendering
  // multiple visited worktrees after session restore), Date.now() returns the
  // same ms and each instance starts with nextIndex=1 — producing collisions
  // that wedge multiple xterm renderers onto a single PTY. See #88.
  function createTab(): void {
    const id = `term-${crypto.randomUUID()}`
    const label = `Terminal ${nextIndex}`
    nextIndex++
    tabs.push({ id, label, isClaude: false })
    activeTabId = id

    window.api.invoke('pty:spawn', { id, worktreePath })
  }

  function createClaudeTab(): string {
    const id = `claude-${crypto.randomUUID()}`
    const label = nextClaudeIndex === 1 ? 'Claude' : `Claude ${nextClaudeIndex}`
    nextClaudeIndex++
    tabs.unshift({ id, label, isClaude: true })
    activeTabId = id

    window.api.invoke('claude:spawn', { id, worktreePath })
    return id
  }

  function createAgentViewTab(): string {
    const id = `agents-${Date.now()}-${nextAgentsIndex}`
    const label = nextAgentsIndex === 1 ? 'Agents' : `Agents ${nextAgentsIndex}`
    nextAgentsIndex++
    // Agent View runs the `claude agents` TUI, which sets noisy OSC titles
    // we don't want to surface. Mark the tab as customLabel:true so
    // handleTitleChange ignores those updates and "Agents N" stays sticky.
    tabs.unshift({ id, label, isClaude: true, isAgentView: true, customLabel: true })
    activeTabId = id

    window.api.invoke('claude:spawn-agents', { id, worktreePath })
    return id
  }

  const claudeMenuItems: ContextMenuItem[] = [
    { id: 'new-claude', label: 'New Claude session' },
    { id: 'new-agents', label: 'New Agent View session' },
  ]

  function pickClaudeMenuItem(id: string): void {
    if (id === 'new-claude') {
      createClaudeTab()
    } else if (id === 'new-agents') {
      createAgentViewTab()
    }
  }

  function openClaudeMenuAtPointer(e: MouseEvent): void {
    e.preventDefault()
    claudeMenu = { x: e.clientX, y: e.clientY }
  }

  function openClaudeMenuAtButton(): void {
    if (!claudeButtonEl) return
    const r = claudeButtonEl.getBoundingClientRect()
    claudeMenu = { x: r.left, y: r.bottom }
  }

  function handleClaudeButtonKeydown(e: KeyboardEvent): void {
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault()
      openClaudeMenuAtButton()
    }
  }

  function closeClaudeMenu(): void {
    claudeMenu = null
    // Restore focus to the invoking button so keyboard users keep their place.
    claudeButtonEl?.focus()
  }

  function closeTab(id: string): void {
    // Cancel any pending fork-error auto-dismiss so the timer doesn't fire
    // after this tab is already gone.
    const pendingDismiss = forkErrorDismissTimers.get(id)
    if (pendingDismiss !== undefined) {
      clearTimeout(pendingDismiss)
      forkErrorDismissTimers.delete(id)
    }
    const tab = tabs.find((t) => t.id === id)
    // Placeholder tabs have no live PTY — just drop them from the list.
    if (tab && !tab.pendingResume) {
      // Agent View tabs (`claude agents` TUI) never had the stream parser
      // attached, so detach would be a no-op.
      if (tab.isClaude && !tab.isAgentView) {
        window.api.invoke('claude:detach', id)
      }
      window.api.invoke('pty:kill', id)
    }
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx === -1) return

    tabs.splice(idx, 1)

    if (activeTabId === id) {
      if (tabs.length > 0) {
        activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id
      } else {
        activeTabId = undefined
      }
    }
  }

  function resumePlaceholder(id: string): void {
    const tab = tabs.find((t) => t.id === id)
    if (!tab?.pendingResume) return
    const sessionId = tab.pendingResume.sessionId
    tab.pendingResume = undefined
    activeTabId = id
    window.api.invoke('claude:spawn', { id, worktreePath, resumeSessionId: sessionId })
  }

  function selectTab(id: string): void {
    activeTabId = id
  }

  function handleDragStart(e: DragEvent, index: number): void {
    dragIndex = index
    e.dataTransfer!.effectAllowed = 'move'
  }

  function handleDragOver(e: DragEvent, index: number): void {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'move'
    dropIndex = index
  }

  function handleDrop(e: DragEvent, index: number): void {
    e.preventDefault()
    if (dragIndex !== null && dragIndex !== index) {
      const [moved] = tabs.splice(dragIndex, 1)
      tabs.splice(index, 0, moved)
    }
    dragIndex = null
    dropIndex = null
  }

  function handleDropAfterLast(e: DragEvent): void {
    e.preventDefault()
    if (dragIndex !== null && dragIndex !== tabs.length - 1) {
      const [moved] = tabs.splice(dragIndex, 1)
      tabs.push(moved)
    }
    dragIndex = null
    dropIndex = null
  }

  function handleDragEnd(): void {
    dragIndex = null
    dropIndex = null
  }

  function handleTitleChange(tabId: string, rawTitle: string): void {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    // User-renamed tabs are sticky — never overwritten by the PTY's OSC title.
    if (tab.customLabel) return
    // Strip Claude Code's status prefix character (✳ U+2733 or braille spinner U+2800–U+28FF)
    // which is always followed by a space, e.g. "✳ Claude Code" → "Claude Code"
    const firstCp = rawTitle.codePointAt(0) ?? 0
    const hasPrefix =
      firstCp === 0x2733 || (firstCp >= 0x2800 && firstCp <= 0x28FF)
    tab.label = hasPrefix ? rawTitle.slice(String.fromCodePoint(firstCp).length).trimStart() : rawTitle
  }

  // ── Tab context menu ─────────────────────────────────────────────────────
  // Disable logic for the Fork item:
  //   - Agent View tabs: always disabled, dedicated tooltip
  //   - Claude tabs with no captured session_id: disabled with "waiting…" tooltip
  //   - Claude tabs with a session_id: enabled

  /**
   * Build the menu item list for a specific tab. The Fork item's disabled
   * state depends on the tab's `isAgentView` flag and whether the source
   * session_id has been captured yet, which is per-tab — so the items can't
   * be a single static array shared across all menu invocations.
   */
  function buildTabMenuItems(tab: TabInfo | undefined): ContextMenuItem[] {
    const items: ContextMenuItem[] = []
    const sessionId = tab ? sessionRestoreStore.sessionIdForTerminal(tab.id) : undefined
    let forkDisabled = false
    let forkTooltip: string | undefined
    if (!tab) {
      forkDisabled = true
    } else if (tab.isAgentView) {
      forkDisabled = true
      forkTooltip = 'Agent View sessions cannot be forked'
    } else if (sessionId == null) {
      // Race window: claude:session-id is emitted synchronously from main
      // for fresh tabs, so this branch is normally not visible. Kept as a
      // defensive disable in case capture is ever delayed.
      forkDisabled = true
      forkTooltip = 'Waiting for Claude to initialize…'
    }
    items.push({
      id: 'fork',
      label: 'Fork into worktree…',
      disabled: forkDisabled,
      disabledTooltip: forkTooltip,
    })
    items.push({ id: 'rename', label: 'Rename…' })
    items.push({
      id: 'close',
      label: 'Close session',
      tone: 'danger',
      separatorBefore: true,
    })
    return items
  }

  let tabMenuItems: ContextMenuItem[] = $derived.by(() => {
    const tab = tabs.find((t) => t.id === tabMenu?.tabId)
    return buildTabMenuItems(tab)
  })

  function openTabMenuAtPointer(e: MouseEvent, tab: TabInfo): void {
    if (!tab.isClaude) return // menu is Claude/Agent View tabs only
    e.preventDefault()
    e.stopPropagation()
    tabMenu = { tabId: tab.id, x: e.clientX, y: e.clientY }
  }

  function openTabMenuAtButton(tab: TabInfo): void {
    const btn = tabMenuButtonEls.get(tab.id)
    if (!btn) return
    const r = btn.getBoundingClientRect()
    tabMenu = { tabId: tab.id, x: r.left, y: r.bottom }
  }

  function handleTabKeydown(e: KeyboardEvent, tab: TabInfo): void {
    // Enter / Space on a focused tab activate it (the outer is now a
    // role="tab" div, not a <button>, so the browser doesn't do this for us).
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (tab.pendingResume) resumePlaceholder(tab.id)
      else selectTab(tab.id)
      return
    }
    if (!tab.isClaude) return
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault()
      openTabMenuAtButton(tab)
    }
  }

  function closeTabMenu(): void {
    const targetId = tabMenu?.tabId
    tabMenu = null
    // Restore focus to the invoking ⋯ button so keyboard users keep their place.
    if (targetId) {
      tabMenuButtonEls.get(targetId)?.focus()
    }
  }

  function pickTabMenuItem(id: string): void {
    const tab = tabs.find((t) => t.id === tabMenu?.tabId)
    if (!tab) return
    if (id === 'rename') {
      renameTarget = { id: tab.id, currentLabel: tab.label }
    } else if (id === 'close') {
      closeTab(tab.id)
    } else if (id === 'fork') {
      const sessionId = sessionRestoreStore.sessionIdForTerminal(tab.id)
      if (!sessionId) return // shouldn't happen — Fork is disabled when missing
      // Transition from action menu to worktree picker, anchored at the same
      // point so the panel doesn't jump.
      const anchor = tabMenu
      if (!anchor) return
      forkPicker = {
        tabId: tab.id,
        sourceLabel: tab.label,
        sourceSessionId: sessionId,
        x: anchor.x,
        y: anchor.y,
      }
      // ContextMenu's onpick fires before onclose; null tabMenu here so the
      // picker isn't drawn under a still-open menu in the next paint.
      tabMenu = null
    }
  }

  function forkPickerBack(): void {
    // Restore the action menu at the same anchor, then drop the picker.
    if (!forkPicker) return
    tabMenu = { tabId: forkPicker.tabId, x: forkPicker.x, y: forkPicker.y }
    forkPicker = null
  }

  function forkPickerClose(): void {
    const targetId = forkPicker?.tabId
    forkPicker = null
    if (targetId) {
      tabMenuButtonEls.get(targetId)?.focus()
    }
  }

  function forkPickerPick(target: ForkTarget): void {
    if (!forkPicker) return
    const { tabId, sourceLabel, sourceSessionId } = forkPicker
    forkPicker = null

    // Pre-mint the fork's session-id (critic's audit §4: passing this at
    // spawn time eliminates the race vs scraping claude's init line).
    const forkUuid = crypto.randomUUID()
    const placeholderTabId = `claude-fork-${Date.now()}-${nextClaudeIndex}`
    const placeholderLabel =
      nextClaudeIndex === 1 ? 'Claude' : `Claude ${nextClaudeIndex}`
    nextClaudeIndex++

    // The placeholder lives in THIS pane's tab list; the renderer doesn't
    // route forks to the secondary pane (that's a future enhancement). The
    // placeholder is rendered italic-dimmed until the fork resolves.
    tabs.unshift({
      id: placeholderTabId,
      label: placeholderLabel,
      isClaude: true,
      forking: { sourceLabel },
    })
    activeTabId = placeholderTabId

    function markForkError(message: string): void {
      const t = tabs.find((x) => x.id === placeholderTabId)
      if (t) {
        t.forking = undefined
        t.forkError = message
      }
    }

    function runFork(targetWorktreePath: string): void {
      window.api
        .invoke('claude:fork', {
          sourceTerminalId: tabId,
          sourceSessionId,
          sourceWorktreePath: worktreePath,
          targetWorktreePath,
          forkUuid,
          placeholderTabId,
        })
        .catch(() => {
          // The IPC handler emits claude:fork-result on its own error path; if
          // the invoke itself rejects (e.g. main crashed), surface a generic
          // error so the placeholder doesn't hang.
          markForkError('fork IPC failed')
        })
    }

    if (target.kind === 'existing') {
      runFork(target.worktreePath)
      return
    }

    // Create the worktree first, then fork into its path. The picker only
    // offers this row when the typed name doesn't match an existing worktree,
    // so a name collision here means the branch already exists on disk —
    // surface that as a fork error rather than silently reusing it.
    window.api
      .invoke('worktree:create', target.name)
      .then((created) => {
        void refreshWorktrees()
        runFork(created.path)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        markForkError(`could not create worktree: ${message}`)
      })
  }

  function submitRename(value: string): void {
    if (!renameTarget) return
    const tab = tabs.find((t) => t.id === renameTarget!.id)
    if (tab) {
      tab.label = value.trim()
      tab.customLabel = true
    }
    renameTarget = null
  }

  function validateRename(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed.length === 0) return 'Label cannot be empty'
    if (trimmed.length > 64) return 'Label must be 64 characters or fewer'
    return null
  }

  // Register callbacks and sync Claude tab list into agentStore
  $effect(() => {
    agentStore.registerCallbacks(
      createClaudeTab,
      (id: string) => { activeTabId = id },
    )
  })

  $effect(() => {
    agentStore.syncTabs(
      tabs
        // Exclude Agent View tabs — they're a `claude agents` TUI, not a
        // stream-json Claude Code session, so "Ask Claude" / spawn-and-send
        // can't target them.
        .filter((t) => t.isClaude && !t.isAgentView && !t.pendingResume)
        .map((t) => ({ id: t.id, label: t.label })),
    )
  })

  // Auto-close a tab when its PTY exits (e.g. user typed /exit in Claude)
  $effect(() => {
    return window.api.on('pty:exit', ({ id }) => {
      if (tabs.some((t) => t.id === id)) {
        closeTab(id)
      }
    })
  })

  // Listen for claude:fork-result. The placeholder tab's forking state is
  // cleared when the new PTY emits its first byte (see pty:data handler).
  // On error we surface a brief error chip that auto-dismisses after ~6s.
  $effect(() => {
    return window.api.on('claude:fork-result', (payload) => {
      const tab = tabs.find((t) => t.id === payload.placeholderTabId)
      if (!tab) return
      if (payload.ok) {
        // Success path is handled by the pty:data listener below — once
        // Claude emits anything the placeholder transitions to a live tab.
        return
      }
      tab.forking = undefined
      tab.forkError = payload.error
      // Auto-dismiss the error after a short window so the user can read it
      // but the tab doesn't stay broken-looking forever. The timer is tracked
      // in forkErrorDismissTimers so manual close or component unmount cancels
      // it cleanly instead of firing stale.
      const errId = tab.id
      const t = setTimeout(() => {
        forkErrorDismissTimers.delete(errId)
        const stillTab = tabs.find((x) => x.id === errId)
        if (stillTab && stillTab.forkError) {
          closeTab(errId)
        }
      }, 6_000)
      forkErrorDismissTimers.set(errId, t)
    })
  })

  // Cancel any outstanding fork-error timers on component unmount so they
  // can't fire after this TerminalTabs instance is gone.
  $effect(() => {
    return () => {
      for (const t of forkErrorDismissTimers.values()) clearTimeout(t)
      forkErrorDismissTimers.clear()
    }
  })

  // Drop the `forking` placeholder state as soon as the new PTY emits any
  // data — that's the signal the fork actually started running. The Terminal
  // component then mounts and renders the live session as usual.
  $effect(() => {
    return window.api.on('pty:data', ({ id }) => {
      const tab = tabs.find((t) => t.id === id)
      if (tab?.forking) {
        tab.forking = undefined
      }
    })
  })

  // Drain Claude resume placeholders staged by session restore. Runs once per
  // (paneRole, worktreePath) pair — drainPendingResume clears the entry.
  $effect(() => {
    const role = paneRole
    const path = worktreePath
    const pending = sessionRestoreStore.drainPendingResume(role, path)
    if (pending.length === 0) return
    for (const session of pending) {
      if (session.isAgentView) {
        // Agent View tabs don't expose a session-id, so we can't resume.
        // Best-effort: respawn a fresh `claude agents` tab in the same slot.
        const id = `agents-${Date.now()}-${nextAgentsIndex}`
        const label = session.label || (nextAgentsIndex === 1 ? 'Agents' : `Agents ${nextAgentsIndex}`)
        nextAgentsIndex++
        tabs.push({
          id,
          label,
          isClaude: true,
          isAgentView: true,
          ...(session.customLabel ? { customLabel: true as const } : {}),
        })
        window.api.invoke('claude:spawn-agents', { id, worktreePath: path })
        continue
      }
      // Sessions without a captured id can't be resumed — skip.
      if (!session.sessionId) continue
      const id = `claude-${crypto.randomUUID()}`
      const label = session.label || (nextClaudeIndex === 1 ? 'Claude' : `Claude ${nextClaudeIndex}`)
      nextClaudeIndex++
      tabs.push({
        id,
        label,
        isClaude: true,
        ...(session.customLabel ? { customLabel: true as const } : {}),
        pendingResume: { sessionId: session.sessionId },
      })
    }
  })

  // Create an initial plain-terminal tab on mount, but only if nothing else
  // populated the tab list (e.g. restored Claude placeholders).
  $effect(() => {
    if (tabs.length === 0) {
      createTab()
    }
  })

  // Publish live Claude tabs (including Agent View) to the session restore
  // store so the serializer can read them on save.
  $effect(() => {
    const claudeTabs = tabs
      .filter((t) => t.isClaude && !t.pendingResume)
      .map((t) => ({
        terminalId: t.id,
        label: t.label,
        ...(t.isAgentView ? { isAgentView: true as const } : {}),
        ...(t.customLabel ? { customLabel: true as const } : {}),
      }))
    sessionRestoreStore.publishClaudeTabs(paneRole, worktreePath, claudeTabs)
  })
</script>

<div class="flex h-full flex-col">
  <!-- Tab bar -->
  <div class="flex items-center border-b border-zinc-800 bg-zinc-950 px-1">
    <button
      bind:this={claudeButtonEl}
      class="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-orange-400/60 hover:bg-zinc-800 hover:text-orange-300"
      onclick={createClaudeTab}
      oncontextmenu={openClaudeMenuAtPointer}
      onkeydown={handleClaudeButtonKeydown}
      aria-label="Run Claude Code"
      aria-haspopup="menu"
      title="Run Claude Code (right-click for Agent View)"
    >
      <span>&#x2726;</span>
    </button>

    {#if claudeMenu}
      <ContextMenu
        x={claudeMenu.x}
        y={claudeMenu.y}
        items={claudeMenuItems}
        onpick={pickClaudeMenuItem}
        onclose={closeClaudeMenu}
      />
    {/if}

    {#each tabs as tab, i (tab.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="group flex items-center gap-1 px-3 py-1 text-xs transition-colors {tab.id === activeTabId
          ? tab.isClaude ? 'bg-zinc-900 text-orange-300' : 'bg-zinc-900 text-zinc-200'
          : tab.isClaude ? 'text-orange-400/60 hover:text-orange-300' : 'text-zinc-500 hover:text-zinc-300'}
          {tab.pendingResume || tab.forking ? 'italic opacity-70' : ''}
          {tab.forkError ? 'text-red-400' : ''}
          {dragIndex !== null && dropIndex === i && dragIndex !== i ? 'border-l-2 border-l-blue-500' : ''}"
        role="tab"
        tabindex={tab.id === activeTabId ? 0 : -1}
        aria-selected={tab.id === activeTabId}
        aria-label={tab.label}
        onclick={() => tab.pendingResume ? resumePlaceholder(tab.id) : selectTab(tab.id)}
        oncontextmenu={(e) => openTabMenuAtPointer(e, tab)}
        onkeydown={(e) => handleTabKeydown(e, tab)}
        draggable="true"
        ondragstart={(e) => handleDragStart(e, i)}
        ondragover={(e) => handleDragOver(e, i)}
        ondrop={(e) => handleDrop(e, i)}
        ondragend={handleDragEnd}
        title={
          tab.forkError
            ? `Fork failed: ${tab.forkError}`
            : tab.forking
              ? `Forking… (from ${tab.forking.sourceLabel})`
              : tab.pendingResume
                ? 'Click to resume this Claude session'
                : tab.label
        }
        aria-haspopup={tab.isClaude && !tab.pendingResume && !tab.forking ? 'menu' : undefined}
      >
        {#if tab.isClaude}
          <span class="text-[10px]">&#x2726;</span>
        {/if}
        <span>{tab.label}{tab.pendingResume ? ' (resume)' : ''}{tab.forking ? '…' : ''}{tab.forkError ? ' (failed)' : ''}</span>
        {#if tab.isClaude && !tab.pendingResume && !tab.forking && !tab.forkError}
          <button
            type="button"
            bind:this={
              () => tabMenuButtonEls.get(tab.id),
              (el) => {
                if (el) tabMenuButtonEls.set(tab.id, el)
                else tabMenuButtonEls.delete(tab.id)
              }
            }
            class="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-zinc-600 opacity-0 hover:bg-zinc-700 hover:text-zinc-300 focus:opacity-100 group-hover:opacity-100"
            aria-label="Tab options"
            aria-haspopup="menu"
            onclick={(e: MouseEvent) => {
              e.stopPropagation()
              openTabMenuAtButton(tab)
            }}
            onkeydown={(e: KeyboardEvent) => {
              e.stopPropagation()
            }}
          >
            ⋯
          </button>
        {/if}
        <button
          type="button"
          class="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-zinc-600 hover:bg-zinc-700 hover:text-zinc-300"
          aria-label="Close tab"
          onclick={(e: MouseEvent) => { e.stopPropagation(); closeTab(tab.id) }}
          onkeydown={(e: KeyboardEvent) => { e.stopPropagation() }}
        >
          x
        </button>
      </div>
    {/each}

    {#if tabMenu}
      <ContextMenu
        x={tabMenu.x}
        y={tabMenu.y}
        items={tabMenuItems}
        onpick={pickTabMenuItem}
        onclose={closeTabMenu}
      />
    {/if}

    {#if forkPicker}
      <ForkWorktreePicker
        x={forkPicker.x}
        y={forkPicker.y}
        sourceWorktreePath={worktreePath}
        onpick={forkPickerPick}
        onback={forkPickerBack}
        onclose={forkPickerClose}
      />
    {/if}

    <!-- Drop zone after last tab -->
    {#if dragIndex !== null}
      <div
        class="h-full min-w-2 flex-1 {dropIndex === tabs.length ? 'border-l-2 border-l-blue-500' : ''}"
        ondragover={(e) => { e.preventDefault(); dropIndex = tabs.length }}
        ondrop={handleDropAfterLast}
        ondragleave={() => { if (dropIndex === tabs.length) dropIndex = null }}
        role="none"
      ></div>
    {/if}

    <button
      class="ml-1 flex h-5 w-5 items-center justify-center rounded text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      onclick={createTab}
      title="New terminal"
    >
      +
    </button>
  </div>

  <!-- All terminals rendered, only active one visible -->
  <div class="relative min-h-0 flex-1">
    {#each tabs as tab (tab.id)}
      <div
        class="absolute inset-0"
        class:hidden={tab.id !== activeTabId}
      >
        {#if tab.pendingResume}
          <div class="flex h-full flex-col items-center justify-center gap-3 text-zinc-400">
            <p class="text-xs">Claude session from your last visit</p>
            <button
              class="rounded border border-orange-500/40 bg-orange-500/10 px-3 py-1 text-xs text-orange-300 hover:bg-orange-500/20"
              onclick={() => resumePlaceholder(tab.id)}
            >
              Resume {tab.label}
            </button>
            <p class="text-[10px] text-zinc-600">session id {tab.pendingResume.sessionId.slice(0, 8)}…</p>
          </div>
        {:else if tab.forking}
          <div class="flex h-full flex-col items-center justify-center gap-2 text-zinc-400">
            <p class="text-xs italic">Forking from {tab.forking.sourceLabel}…</p>
            <p class="text-[10px] text-zinc-600">Copying session transcript and starting Claude</p>
          </div>
        {:else if tab.forkError}
          <div class="flex h-full flex-col items-center justify-center gap-2 text-red-400">
            <p class="text-xs">Fork failed</p>
            <p class="max-w-md text-[10px] text-zinc-500">{tab.forkError}</p>
          </div>
        {:else}
          <Terminal
            terminalId={tab.id}
            active={tab.id === activeTabId}
            isClaude={tab.isClaude}
            ontitlechange={(title) => handleTitleChange(tab.id, title)}
          />
        {/if}
      </div>
    {/each}
    {#if tabs.length === 0}
      <div class="flex h-full items-center justify-center">
        <p class="text-xs text-zinc-500">No terminal open</p>
      </div>
    {/if}
  </div>
</div>

{#if renameTarget}
  <PromptModal
    title="Rename tab"
    label="New label"
    defaultValue={renameTarget.currentLabel}
    confirmLabel="Rename"
    validate={validateRename}
    onsubmit={submitRename}
    oncancel={() => (renameTarget = null)}
  />
{/if}
