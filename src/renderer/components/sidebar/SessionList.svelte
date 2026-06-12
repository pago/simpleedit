<script lang="ts">
  import ContextMenu, { type ContextMenuItem } from '../ContextMenu.svelte'
  import ForkWorktreePicker, { type ForkTarget } from '../terminal/ForkWorktreePicker.svelte'
  import PromptModal from '../PromptModal.svelte'
  import { sessionsStore, type Session } from '../../stores/sessions.svelte'
  import { getClaudeStatusForTerminal } from '../../stores/claude-status.svelte'
  import { worktreeList, refreshWorktrees } from '../../stores/worktrees.svelte'

  let sessions = $derived(sessionsStore.sessions())
  let activeId = $derived(sessionsStore.activeSessionId())

  /** New sessions launch in the main worktree (Claude memory home). */
  function launchPath(): string | null {
    return worktreeList()[0]?.path ?? null
  }

  // ── new-session menu (✦ button: claude vs agent view) ────────────────────
  let newMenu: { x: number; y: number } | null = $state(null)
  let newButtonEl: HTMLButtonElement | undefined = $state()

  const newMenuItems: ContextMenuItem[] = [
    { id: 'new-claude', label: 'New Claude session' },
    { id: 'new-agents', label: 'New Agent View session' },
  ]

  function pickNewMenuItem(id: string): void {
    const path = launchPath()
    if (!path) return
    if (id === 'new-claude') sessionsStore.createClaude(path)
    else if (id === 'new-agents') sessionsStore.createAgents(path)
  }

  function openNewMenuAtPointer(e: MouseEvent): void {
    e.preventDefault()
    newMenu = { x: e.clientX, y: e.clientY }
  }

  // ── per-session context menu / rename / fork ─────────────────────────────
  let sessionMenu: { sessionId: string; x: number; y: number } | null = $state(null)
  let menuButtonEls: Map<string, HTMLElement> = $state(new Map())
  let renameTarget: { id: string; currentLabel: string } | null = $state(null)
  let forkPicker:
    | { sessionId: string; sourceLabel: string; sourceSessionId: string; x: number; y: number }
    | null = $state(null)

  function buildMenuItems(session: Session | undefined): ContextMenuItem[] {
    const items: ContextMenuItem[] = []
    if (session?.kind !== 'terminal') {
      let forkDisabled = false
      let forkTooltip: string | undefined
      if (!session) {
        forkDisabled = true
      } else if (session.kind === 'agents') {
        forkDisabled = true
        forkTooltip = 'Agent View sessions cannot be forked'
      } else if (!session.claudeSessionId) {
        forkDisabled = true
        forkTooltip = 'Waiting for Claude to initialize…'
      }
      items.push({
        id: 'fork',
        label: 'Fork into worktree…',
        disabled: forkDisabled,
        disabledTooltip: forkTooltip,
      })
    }
    items.push({ id: 'rename', label: 'Rename…' })
    items.push({
      id: 'close',
      label: 'Close session',
      tone: 'danger',
      separatorBefore: true,
    })
    return items
  }

  let sessionMenuItems: ContextMenuItem[] = $derived.by(() => {
    return buildMenuItems(sessions.find((s) => s.id === sessionMenu?.sessionId))
  })

  function openMenuAtPointer(e: MouseEvent, session: Session): void {
    e.preventDefault()
    e.stopPropagation()
    sessionMenu = { sessionId: session.id, x: e.clientX, y: e.clientY }
  }

  function openMenuAtButton(session: Session): void {
    const btn = menuButtonEls.get(session.id)
    if (!btn) return
    const r = btn.getBoundingClientRect()
    sessionMenu = { sessionId: session.id, x: r.left, y: r.bottom }
  }

  function closeSessionMenu(): void {
    const targetId = sessionMenu?.sessionId
    sessionMenu = null
    if (targetId) menuButtonEls.get(targetId)?.focus()
  }

  function pickMenuItem(id: string): void {
    const session = sessions.find((s) => s.id === sessionMenu?.sessionId)
    if (!session) return
    if (id === 'rename') {
      renameTarget = { id: session.id, currentLabel: session.label }
    } else if (id === 'close') {
      sessionsStore.close(session.id)
    } else if (id === 'fork') {
      if (!session.claudeSessionId || !sessionMenu) return
      forkPicker = {
        sessionId: session.id,
        sourceLabel: session.label,
        sourceSessionId: session.claudeSessionId,
        x: sessionMenu.x,
        y: sessionMenu.y,
      }
      // ContextMenu's onpick fires before onclose; null it here so the picker
      // isn't drawn under a still-open menu in the next paint.
      sessionMenu = null
    }
  }

  function forkPickerBack(): void {
    if (!forkPicker) return
    sessionMenu = { sessionId: forkPicker.sessionId, x: forkPicker.x, y: forkPicker.y }
    forkPicker = null
  }

  function forkPickerClose(): void {
    const targetId = forkPicker?.sessionId
    forkPicker = null
    if (targetId) menuButtonEls.get(targetId)?.focus()
  }

  function forkPickerPick(target: ForkTarget): void {
    if (!forkPicker) return
    const { sessionId, sourceLabel, sourceSessionId } = forkPicker
    const sourceWorktreePath = sessions.find((s) => s.id === sessionId)?.worktreePath
    forkPicker = null
    if (!sourceWorktreePath) return

    // Pre-mint the fork's session-id — passing it at spawn time eliminates
    // the race vs scraping claude's init line.
    const forkUuid = crypto.randomUUID()

    function runFork(targetWorktreePath: string): void {
      const placeholderId = sessionsStore.addForkPlaceholder(sourceLabel, targetWorktreePath)
      window.api
        .invoke('claude:fork', {
          sourceTerminalId: sessionId,
          sourceSessionId,
          sourceWorktreePath,
          targetWorktreePath,
          forkUuid,
          placeholderTabId: placeholderId,
        })
        .catch(() => {
          // The IPC handler emits claude:fork-result on its own error path; if
          // the invoke itself rejects (e.g. main crashed), surface a generic
          // error so the placeholder doesn't hang.
          sessionsStore.failFork(placeholderId, 'fork IPC failed')
        })
    }

    if (target.kind === 'existing') {
      runFork(target.worktreePath)
      return
    }

    // Create the worktree first, then fork into its path. The placeholder
    // points at the source worktree until the new one exists.
    const placeholderId = sessionsStore.addForkPlaceholder(sourceLabel, sourceWorktreePath)
    window.api
      .invoke('worktree:create', target.name)
      .then((created) => {
        void refreshWorktrees()
        sessionsStore.update(placeholderId, { worktreePath: created.path })
        window.api
          .invoke('claude:fork', {
            sourceTerminalId: sessionId,
            sourceSessionId,
            sourceWorktreePath,
            targetWorktreePath: created.path,
            forkUuid,
            placeholderTabId: placeholderId,
          })
          .catch(() => {
            sessionsStore.failFork(placeholderId, 'fork IPC failed')
          })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        sessionsStore.failFork(placeholderId, `could not create worktree: ${message}`)
      })
  }

  function submitRename(value: string): void {
    if (!renameTarget) return
    sessionsStore.rename(renameTarget.id, value)
    renameTarget = null
  }

  function validateRename(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed.length === 0) return 'Label cannot be empty'
    if (trimmed.length > 64) return 'Label must be 64 characters or fewer'
    return null
  }

  function activate(session: Session): void {
    if (session.pendingResume) {
      sessionsStore.resumePlaceholder(session.id)
    } else {
      sessionsStore.select(session.id)
    }
  }

  function handleKeydown(e: KeyboardEvent, session: Session): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate(session)
      return
    }
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault()
      openMenuAtButton(session)
    }
  }

  /** Status dot styling per session state. */
  function dotClass(session: Session): string {
    if (session.pendingResume) return 'bg-zinc-600'
    if (session.forkError) return 'bg-red-500'
    if (session.forking) return 'bg-zinc-500 animate-pulse'
    if (session.kind === 'terminal') return 'bg-zinc-600'
    const status = getClaudeStatusForTerminal(session.id)
    switch (status) {
      case 'running':
        return 'bg-emerald-400 animate-pulse'
      case 'waiting':
        return 'bg-amber-400'
      case 'error':
        return 'bg-red-500'
      default:
        return 'bg-zinc-600'
    }
  }

  function statusTitle(session: Session): string {
    if (session.pendingResume) return 'Resumable — click to resume'
    if (session.forkError) return `Fork failed: ${session.forkError}`
    if (session.forking) return `Forking… (from ${session.forking.sourceLabel})`
    if (session.kind === 'terminal') return 'Terminal'
    const status = getClaudeStatusForTerminal(session.id)
    switch (status) {
      case 'running':
        return 'Working'
      case 'waiting':
        return 'Awaiting input'
      case 'error':
        return 'Error'
      default:
        return 'Idle'
    }
  }

  function worktreeBranch(session: Session): string {
    const wt = worktreeList().find((w) => w.path === session.worktreePath)
    return wt?.branch ?? session.worktreePath.split('/').pop() ?? ''
  }
</script>

<div class="flex flex-col gap-1">
  <div class="sticky top-0 z-10 -mx-3 flex items-center justify-between bg-zinc-900 px-4 pb-1 pt-2">
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">Sessions</span>
    <div class="flex items-center gap-1">
      <button
        bind:this={newButtonEl}
        class="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-orange-400/70 hover:bg-zinc-700 hover:text-orange-300"
        onclick={() => {
          const path = launchPath()
          if (path) sessionsStore.createClaude(path)
        }}
        oncontextmenu={openNewMenuAtPointer}
        aria-label="New Claude session"
        aria-haspopup="menu"
        title="New Claude session (right-click for Agent View)"
      >
        ✦ Agent
      </button>
      <button
        class="flex h-5 items-center rounded px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
        onclick={() => {
          const path = launchPath()
          if (path) sessionsStore.createTerminal(path)
        }}
        title="New terminal"
      >
        + Term
      </button>
    </div>
  </div>

  {#if newMenu}
    <ContextMenu
      x={newMenu.x}
      y={newMenu.y}
      items={newMenuItems}
      onpick={pickNewMenuItem}
      onclose={() => {
        newMenu = null
        newButtonEl?.focus()
      }}
    />
  {/if}

  {#if sessions.length === 0}
    <p class="px-2 text-xs text-zinc-500">No sessions — start an agent or terminal</p>
  {:else}
    <div class="flex flex-col gap-0.5" role="listbox" aria-label="Sessions">
      {#each sessions as session (session.id)}
        {@const isActive = session.id === activeId}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="group flex items-center gap-2 rounded px-2 py-1.5 text-left transition-colors cursor-pointer
            {isActive ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}
            {session.pendingResume || session.forking ? 'italic opacity-70' : ''}
            {session.forkError ? 'text-red-400' : ''}"
          role="option"
          tabindex={isActive ? 0 : -1}
          aria-selected={isActive}
          aria-label={session.label}
          onclick={() => activate(session)}
          oncontextmenu={(e) => openMenuAtPointer(e, session)}
          onkeydown={(e) => handleKeydown(e, session)}
          title={statusTitle(session)}
        >
          <span class="relative flex h-2 w-2 flex-none">
            <span class="h-2 w-2 rounded-full {dotClass(session)}"></span>
          </span>
          <span class="flex-none text-[10px] {session.kind === 'terminal' ? 'text-zinc-500' : 'text-orange-400/70'}">
            {session.kind === 'terminal' ? '$' : '✦'}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs">
              {session.label}{session.pendingResume ? ' (resume)' : ''}{session.forking ? '…' : ''}{session.forkError ? ' (failed)' : ''}
            </span>
            <span class="block truncate text-[10px] text-zinc-500">{worktreeBranch(session)}</span>
          </span>
          <button
            type="button"
            bind:this={
              () => menuButtonEls.get(session.id),
              (el) => {
                if (el) menuButtonEls.set(session.id, el)
                else menuButtonEls.delete(session.id)
              }
            }
            class="inline-flex h-4 w-4 flex-none items-center justify-center rounded text-zinc-600 opacity-0 hover:bg-zinc-700 hover:text-zinc-300 focus:opacity-100 group-hover:opacity-100"
            aria-label="Session options"
            aria-haspopup="menu"
            onclick={(e: MouseEvent) => {
              e.stopPropagation()
              openMenuAtButton(session)
            }}
            onkeydown={(e: KeyboardEvent) => e.stopPropagation()}
          >
            ⋯
          </button>
          <button
            type="button"
            class="inline-flex h-4 w-4 flex-none items-center justify-center rounded text-zinc-600 opacity-0 hover:bg-zinc-700 hover:text-zinc-300 focus:opacity-100 group-hover:opacity-100"
            aria-label="Close session"
            title="Close session (sends exit to the agent)"
            onclick={(e: MouseEvent) => {
              e.stopPropagation()
              sessionsStore.close(session.id)
            }}
            onkeydown={(e: KeyboardEvent) => e.stopPropagation()}
          >
            ×
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if sessionMenu}
    <ContextMenu
      x={sessionMenu.x}
      y={sessionMenu.y}
      items={sessionMenuItems}
      onpick={pickMenuItem}
      onclose={closeSessionMenu}
    />
  {/if}

  {#if forkPicker}
    <ForkWorktreePicker
      x={forkPicker.x}
      y={forkPicker.y}
      sourceWorktreePath={sessions.find((s) => s.id === forkPicker?.sessionId)?.worktreePath ?? ''}
      onpick={forkPickerPick}
      onback={forkPickerBack}
      onclose={forkPickerClose}
    />
  {/if}
</div>

{#if renameTarget}
  <PromptModal
    title="Rename session"
    label="New label"
    defaultValue={renameTarget.currentLabel}
    confirmLabel="Rename"
    validate={validateRename}
    onsubmit={submitRename}
    oncancel={() => (renameTarget = null)}
  />
{/if}
