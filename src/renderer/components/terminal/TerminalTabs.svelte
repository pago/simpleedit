<script lang="ts">
  import Terminal from './Terminal.svelte'
  import ContextMenu, { type ContextMenuItem } from '../ContextMenu.svelte'
  import PromptModal from '../PromptModal.svelte'
  import type { AgentTerminalStore } from '../../stores/agentTerminals.svelte'
  import { sessionRestoreStore } from '../../stores/sessionRestore.svelte'

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

  let dragIndex: number | null = $state(null)
  let dropIndex: number | null = $state(null)

  function createTab(): void {
    const id = `term-${Date.now()}-${nextIndex}`
    const label = `Terminal ${nextIndex}`
    nextIndex++
    tabs.push({ id, label, isClaude: false })
    activeTabId = id

    window.api.invoke('pty:spawn', { id, worktreePath })
  }

  function createClaudeTab(): string {
    const id = `claude-${Date.now()}-${nextClaudeIndex}`
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
    tabs.unshift({ id, label, isClaude: true, isAgentView: true })
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
  // PR1 (#87): Rename is the only enabled action. Fork + Close session are
  // stubbed disabled until later PRs land.

  const tabMenuItems: ContextMenuItem[] = [
    {
      id: 'fork',
      label: 'Fork into worktree…',
      disabled: true,
      disabledTooltip: 'Coming soon',
    },
    { id: 'rename', label: 'Rename…' },
    {
      id: 'close',
      label: 'Close session',
      tone: 'danger',
      separatorBefore: true,
      disabled: true,
      disabledTooltip: 'Coming soon',
    },
  ]

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
    }
    // fork/close handled in PR2/PR3.
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
      const id = `claude-${Date.now()}-${nextClaudeIndex}`
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
      <button
        class="group flex items-center gap-1 px-3 py-1 text-xs transition-colors {tab.id === activeTabId
          ? tab.isClaude ? 'bg-zinc-900 text-orange-300' : 'bg-zinc-900 text-zinc-200'
          : tab.isClaude ? 'text-orange-400/60 hover:text-orange-300' : 'text-zinc-500 hover:text-zinc-300'}
          {tab.pendingResume ? 'italic opacity-70' : ''}
          {dragIndex !== null && dropIndex === i && dragIndex !== i ? 'border-l-2 border-l-blue-500' : ''}"
        onclick={() => tab.pendingResume ? resumePlaceholder(tab.id) : selectTab(tab.id)}
        oncontextmenu={(e) => openTabMenuAtPointer(e, tab)}
        onkeydown={(e) => handleTabKeydown(e, tab)}
        draggable="true"
        ondragstart={(e) => handleDragStart(e, i)}
        ondragover={(e) => handleDragOver(e, i)}
        ondrop={(e) => handleDrop(e, i)}
        ondragend={handleDragEnd}
        title={tab.pendingResume ? 'Click to resume this Claude session' : tab.label}
        aria-haspopup={tab.isClaude && !tab.pendingResume ? 'menu' : undefined}
      >
        {#if tab.isClaude}
          <span class="text-[10px]">&#x2726;</span>
        {/if}
        <span>{tab.label}{tab.pendingResume ? ' (resume)' : ''}</span>
        {#if tab.isClaude && !tab.pendingResume}
          <span
            bind:this={
              () => tabMenuButtonEls.get(tab.id),
              (el) => {
                if (el) tabMenuButtonEls.set(tab.id, el)
                else tabMenuButtonEls.delete(tab.id)
              }
            }
            class="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-zinc-600 opacity-0 hover:bg-zinc-700 hover:text-zinc-300 focus:opacity-100 group-hover:opacity-100"
            role="button"
            tabindex="0"
            aria-label="Tab options"
            aria-haspopup="menu"
            onclick={(e: MouseEvent) => {
              e.stopPropagation()
              openTabMenuAtButton(tab)
            }}
            onkeydown={(e: KeyboardEvent) => {
              e.stopPropagation()
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openTabMenuAtButton(tab)
              }
            }}
          >
            ⋯
          </span>
        {/if}
        <span
          class="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-zinc-600 hover:bg-zinc-700 hover:text-zinc-300"
          role="button"
          tabindex="0"
          onclick={(e: MouseEvent) => { e.stopPropagation(); closeTab(tab.id) }}
          onkeydown={(e: KeyboardEvent) => {
            e.stopPropagation()
            if (e.key === 'Enter' || e.key === ' ') closeTab(tab.id)
          }}
        >
          x
        </span>
      </button>
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
