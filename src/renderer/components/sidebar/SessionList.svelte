<script lang="ts">
  import { onMount } from 'svelte'
  import ContextMenu, { type ContextMenuItem } from '../ContextMenu.svelte'
  import ForkWorktreePicker, { type ForkTarget } from '../terminal/ForkWorktreePicker.svelte'
  import PromptModal from '../PromptModal.svelte'
  import SplitButton from '../SplitButton.svelte'
  import { loadAgentModels, type AgentModel } from '../../lib/agentModels'
  import { sessionsStore, type Session, type SessionGroup } from '../../stores/sessions.svelte'
  import { getClaudeStatusForTerminal } from '../../stores/claude-status.svelte'
  import { worktreeList, refreshWorktrees, projectRoot, mainWorktree } from '../../stores/worktrees.svelte'
  import { worktreeLabel } from '../../lib/worktreeLabel'
  import { uiView } from '../../stores/uiView.svelte'

  let sessions = $derived(sessionsStore.sessions())
  let activeId = $derived(sessionsStore.activeSessionId())

  /** Group members are kept contiguous in `sessions`, so a single linear walk
   * collapses each run into a group block; everything else is a standalone row. */
  type Row =
    | { type: 'group'; group: SessionGroup; members: Session[] }
    | { type: 'session'; session: Session }

  let rows = $derived.by<Row[]>(() => {
    const out: Row[] = []
    let i = 0
    while (i < sessions.length) {
      const s = sessions[i]
      const group = s.groupId ? sessionsStore.group(s.groupId) : undefined
      if (s.groupId && group) {
        const members: Session[] = []
        while (i < sessions.length && sessions[i].groupId === s.groupId) members.push(sessions[i++])
        out.push({ type: 'group', group, members })
      } else {
        out.push({ type: 'session', session: s })
        i++
      }
    }
    return out
  })

  // ── group colors ──────────────────────────────────────────────────────────
  // Full class strings (not interpolated) so Tailwind's scanner keeps them.
  const GROUP_COLOR_CLASS: Record<string, { dot: string; bar: string; ring: string }> = {
    sky: { dot: 'bg-sky-400', bar: 'border-sky-500', ring: 'ring-sky-500' },
    violet: { dot: 'bg-violet-400', bar: 'border-violet-500', ring: 'ring-violet-500' },
    emerald: { dot: 'bg-emerald-400', bar: 'border-emerald-500', ring: 'ring-emerald-500' },
    amber: { dot: 'bg-amber-400', bar: 'border-amber-500', ring: 'ring-amber-500' },
    rose: { dot: 'bg-rose-400', bar: 'border-rose-500', ring: 'ring-rose-500' },
    cyan: { dot: 'bg-cyan-400', bar: 'border-cyan-500', ring: 'ring-cyan-500' },
  }
  const COLOR_OPTIONS = [
    ['sky', 'Sky'], ['violet', 'Violet'], ['emerald', 'Emerald'],
    ['amber', 'Amber'], ['rose', 'Rose'], ['cyan', 'Cyan'],
  ] as const
  function groupColor(c: string): { dot: string; bar: string; ring: string } {
    return GROUP_COLOR_CLASS[c] ?? GROUP_COLOR_CLASS.sky
  }

  function startAgents(): void {
    const wt = mainWorktree()
    const root = projectRoot() ?? wt?.path
    if (root && wt) sessionsStore.createAgents(root, wt.path)
  }

  /** Terminals are working-tree tools — they launch in the main worktree. */
  function startTerminal(): void {
    const wt = mainWorktree()
    if (wt) sessionsStore.createTerminal(wt.path)
  }

  // ── new-session split button (✦ Agent: main = new Claude on the chosen model;
  //    caret = model menu + Agent View). "Default" keeps the plain-cloud spawn. ──
  const DEFAULT_MODEL: AgentModel = { id: 'default', label: 'Default', tier: 'cloud' }
  let agentModels = $state<AgentModel[]>([DEFAULT_MODEL])
  let agentModelId = $state<string>('default')
  onMount(async () => {
    agentModels = [DEFAULT_MODEL, ...(await loadAgentModels().catch(() => []))]
  })

  /** Start a Claude session on the picked model (no ref = the CLI default). */
  function startAgentSession(m: AgentModel): void {
    const wt = mainWorktree()
    const root = projectRoot() ?? wt?.path
    if (root && wt) sessionsStore.createClaude(root, wt.path, m.ref ? { model: m.ref } : {})
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

    // ── grouping ──
    if (session) {
      const otherGroups = sessionsStore.groups().filter((g) => g.id !== session.groupId)
      let first = true
      for (const g of otherGroups) {
        items.push({ id: `move-to-group:${g.id}`, label: `Move to “${g.name}”`, separatorBefore: first })
        first = false
      }
      const hasPartner = sessions.some((s) => s.id !== session.id && !s.groupId)
      if (hasPartner) {
        items.push({ id: 'new-group', label: 'New group with…', separatorBefore: first })
        first = false
      }
      if (session.groupId) {
        items.push({ id: 'remove-from-group', label: 'Remove from group', separatorBefore: first })
      }
    }

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
    } else if (id === 'remove-from-group') {
      sessionsStore.removeFromGroup(session.id)
    } else if (id.startsWith('move-to-group:')) {
      sessionsStore.moveSession(session.id, { mode: 'intoGroup', groupId: id.slice('move-to-group:'.length) })
    } else if (id === 'new-group') {
      if (sessionMenu) partnerPicker = { sessionId: session.id, x: sessionMenu.x, y: sessionMenu.y }
      sessionMenu = null
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

  // ── group context menu / color picker / partner picker / rename ───────────
  let groupMenu: { groupId: string; x: number; y: number } | null = $state(null)
  let colorMenu: { groupId: string; x: number; y: number } | null = $state(null)
  let partnerPicker: { sessionId: string; x: number; y: number } | null = $state(null)
  let groupRenameTarget: { id: string; currentLabel: string } | null = $state(null)

  const groupMenuItems: ContextMenuItem[] = [
    { id: 'group-rename', label: 'Rename…' },
    { id: 'group-color', label: 'Change color…' },
    { id: 'group-ungroup', label: 'Ungroup', tone: 'danger', separatorBefore: true },
  ]

  function openGroupMenu(e: MouseEvent, group: SessionGroup): void {
    e.preventDefault()
    e.stopPropagation()
    groupMenu = { groupId: group.id, x: e.clientX, y: e.clientY }
  }

  function pickGroupMenuItem(id: string): void {
    if (!groupMenu) return
    const group = sessionsStore.group(groupMenu.groupId)
    if (!group) return
    if (id === 'group-rename') {
      groupRenameTarget = { id: group.id, currentLabel: group.name }
    } else if (id === 'group-color') {
      colorMenu = { groupId: group.id, x: groupMenu.x, y: groupMenu.y }
      groupMenu = null
    } else if (id === 'group-ungroup') {
      sessionsStore.ungroup(group.id)
    }
  }

  const colorMenuItems: ContextMenuItem[] = COLOR_OPTIONS.map(([id, label]) => ({
    id: `color:${id}`,
    label,
  }))

  function pickColor(id: string): void {
    if (colorMenu) sessionsStore.setGroupColor(colorMenu.groupId, id.slice('color:'.length))
  }

  let partnerItems: ContextMenuItem[] = $derived.by(() => {
    const source = partnerPicker?.sessionId
    return sessions
      .filter((s) => s.id !== source && !s.groupId)
      .map((s) => ({ id: `partner:${s.id}`, label: s.label }))
  })

  function pickPartner(id: string): void {
    if (!partnerPicker) return
    const partnerId = id.slice('partner:'.length)
    sessionsStore.createGroup([partnerPicker.sessionId, partnerId])
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

  function submitGroupRename(value: string): void {
    if (!groupRenameTarget) return
    sessionsStore.renameGroup(groupRenameTarget.id, value)
    groupRenameTarget = null
  }

  function validateRename(value: string): string | null {
    const trimmed = value.trim()
    if (trimmed.length === 0) return 'Label cannot be empty'
    if (trimmed.length > 64) return 'Label must be 64 characters or fewer'
    return null
  }

  function activate(session: Session): void {
    // Selecting a session leaves any global view (e.g. Screen PRs) for the workspace.
    uiView.show('workspace')
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

  // ── drag & drop (reorder + dwell-to-group) ────────────────────────────────
  // Mirrors the native-HTML5 pattern in PaneTabBar.svelte, extended with a
  // three-zone hit test (top→before, bottom→after, center→group) and a dwell
  // timer so passing the pointer over a row's center doesn't group unless the
  // user pauses there (the gesture).
  type DropMode = 'before' | 'after' | 'group' | 'intoGroup'
  let draggedId: string | null = $state(null)
  let dropTargetId: string | null = $state(null)
  let dropMode: DropMode | null = $state(null)
  let dropOnGroupId: string | null = $state(null)
  let dropToEnd = $state(false)
  let groupPreview: { draggedId: string; targetId: string } | null = $state(null)

  const DWELL_MS = 600
  const DWELL_MOVE_PX = 4
  let dwellTimer: ReturnType<typeof setTimeout> | null = null
  let dwellAnchor: { x: number; y: number; targetId: string } | null = null

  function clearDwell(): void {
    if (dwellTimer) clearTimeout(dwellTimer)
    dwellTimer = null
    dwellAnchor = null
  }

  function resetDragState(): void {
    draggedId = null
    dropTargetId = null
    dropMode = null
    dropOnGroupId = null
    dropToEnd = false
    groupPreview = null
    clearDwell()
  }

  function handleDragStart(e: DragEvent, session: Session): void {
    draggedId = session.id
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      // Chromium won't initiate a drag without payload on the dataTransfer.
      e.dataTransfer.setData('text/plain', session.id)
    }
  }

  function zoneFor(e: DragEvent, el: HTMLElement): 'top' | 'center' | 'bottom' {
    const r = el.getBoundingClientRect()
    const rel = (e.clientY - r.top) / r.height
    if (rel < 0.33) return 'top'
    if (rel > 0.67) return 'bottom'
    return 'center'
  }

  function handleRowDragOver(e: DragEvent, session: Session): void {
    if (draggedId === null || draggedId === session.id) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropOnGroupId = null
    dropToEnd = false
    dropTargetId = session.id

    const zone = zoneFor(e, e.currentTarget as HTMLElement)
    if (zone !== 'center') {
      dropMode = zone === 'top' ? 'before' : 'after'
      groupPreview = null
      clearDwell()
      return
    }

    // Center zone: group intent, but only after the pointer dwells. Chromium
    // fires dragover continuously even while stationary, so only restart the
    // timer on real movement (or a new target) — otherwise the dwell never
    // completes. Until it fires we fall back to a plain reorder.
    const moved =
      !dwellAnchor ||
      dwellAnchor.targetId !== session.id ||
      Math.abs(dwellAnchor.x - e.clientX) > DWELL_MOVE_PX ||
      Math.abs(dwellAnchor.y - e.clientY) > DWELL_MOVE_PX

    if (moved) {
      clearDwell()
      groupPreview = null
      dropMode = 'after'
      dwellAnchor = { x: e.clientX, y: e.clientY, targetId: session.id }
      const targetId = session.id
      const targetGroupId = session.groupId
      dwellTimer = setTimeout(() => {
        if (draggedId === null || dropTargetId !== targetId) return
        groupPreview = { draggedId, targetId }
        dropMode = targetGroupId ? 'intoGroup' : 'group'
        dropOnGroupId = targetGroupId ?? null
      }, DWELL_MS)
    } else if (groupPreview?.targetId === session.id) {
      dropMode = session.groupId ? 'intoGroup' : 'group'
      dropOnGroupId = session.groupId ?? null
    }
  }

  function handleGroupDragOver(e: DragEvent, group: SessionGroup): void {
    if (draggedId === null) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropMode = 'intoGroup'
    dropOnGroupId = group.id
    dropTargetId = null
    dropToEnd = false
    groupPreview = null
    clearDwell()
  }

  function handleEndDragOver(e: DragEvent): void {
    if (draggedId === null) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropToEnd = true
    dropMode = null
    dropTargetId = null
    dropOnGroupId = null
    groupPreview = null
    clearDwell()
  }

  function handleDrop(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const dragged = draggedId
    if (!dragged) {
      resetDragState()
      return
    }
    if (dropToEnd) {
      sessionsStore.moveSession(dragged, { mode: 'toEnd' })
    } else if (dropMode === 'intoGroup' && dropOnGroupId) {
      sessionsStore.moveSession(dragged, { mode: 'intoGroup', groupId: dropOnGroupId })
    } else if (dropMode === 'group' && dropTargetId) {
      sessionsStore.createGroup([dragged, dropTargetId])
    } else if ((dropMode === 'before' || dropMode === 'after') && dropTargetId) {
      sessionsStore.moveSession(dragged, { mode: dropMode, refId: dropTargetId })
    }
    resetDragState()
  }

  /** Status dot styling per session state. */
  function dotClass(session: Session): string {
    if (session.exited) return 'bg-red-500'
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
    if (session.exited) return `Process exited with code ${session.exited.exitCode} — output preserved in the terminal`
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
    return wt ? worktreeLabel(wt) : (session.worktreePath.split('/').pop() ?? '')
  }
</script>

{#snippet sessionRow(session: Session, grouped: boolean)}
  {@const isActive = session.id === activeId}
  {@const isDragged = draggedId === session.id}
  {@const isGroupTarget =
    dropTargetId === session.id && (dropMode === 'group' || dropMode === 'intoGroup')}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="group flex items-center gap-2 rounded px-2 py-1.5 text-left transition-colors cursor-pointer
      {isActive ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}
      {session.pendingResume || session.forking ? 'italic opacity-70' : ''}
      {session.forkError ? 'text-red-400' : ''}
      {isDragged ? 'opacity-40' : ''}
      {dropTargetId === session.id && dropMode === 'before' ? 'border-t-2 border-t-blue-500' : ''}
      {dropTargetId === session.id && dropMode === 'after' ? 'border-b-2 border-b-blue-500' : ''}
      {isGroupTarget ? 'ring-2 ring-inset ring-blue-500' : ''}"
    role="option"
    tabindex={isActive ? 0 : -1}
    aria-selected={isActive}
    aria-label={session.label}
    draggable="true"
    onclick={() => activate(session)}
    oncontextmenu={(e) => openMenuAtPointer(e, session)}
    onkeydown={(e) => handleKeydown(e, session)}
    ondragstart={(e) => handleDragStart(e, session)}
    ondragover={(e) => handleRowDragOver(e, session)}
    ondrop={handleDrop}
    ondragend={resetDragState}
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
        {session.label}{session.pendingResume ? ' (resume)' : ''}{session.forking ? '…' : ''}{session.forkError ? ' (failed)' : ''}{session.exited ? ' (exited)' : ''}
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
{/snippet}

<div class="flex flex-col gap-1">
  <div class="sticky top-0 z-10 -mx-3 flex items-center justify-between bg-zinc-900 px-4 pb-1 pt-2">
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">Sessions</span>
    <div class="flex items-center gap-1">
      <SplitButton
        label="Agent"
        icon="✦"
        size="sm"
        tone="agent"
        models={agentModels}
        bind:selectedId={agentModelId}
        onstart={startAgentSession}
        disabled={worktreeList().length === 0}
        extraItems={[{ id: 'agents', label: 'New Agent View session' }]}
        onextra={() => startAgents()}
      />
      <button
        class="flex h-5 items-center rounded px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-50"
        onclick={startTerminal}
        disabled={worktreeList().length === 0}
        title="New terminal"
      >
        + Term
      </button>
    </div>
  </div>

  {#if sessions.length === 0}
    <p class="px-2 text-xs text-zinc-500">No sessions — start an agent or terminal</p>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_interactive_supports_focus -->
    <div
      class="flex flex-col gap-0.5"
      role="listbox"
      aria-label="Sessions"
      ondragover={handleEndDragOver}
      ondrop={handleDrop}
    >
      {#each rows as row (row.type === 'group' ? row.group.id : row.session.id)}
        {#if row.type === 'session'}
          {@render sessionRow(row.session, false)}
        {:else}
          {@const color = groupColor(row.group.color)}
          {@const isDropGroup = dropOnGroupId === row.group.id && dropMode === 'intoGroup'}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="rounded {isDropGroup ? `ring-2 ring-inset ${color.ring}` : ''}"
            ondragover={(e) => handleGroupDragOver(e, row.group)}
            ondrop={handleDrop}
          >
            <div
              class="group/header flex items-center gap-1.5 rounded px-1.5 py-1 text-left"
              role="group"
              aria-label={row.group.name}
              oncontextmenu={(e) => openGroupMenu(e, row.group)}
            >
              <button
                type="button"
                class="flex h-4 w-4 flex-none items-center justify-center rounded text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
                aria-expanded={!row.group.collapsed}
                aria-label={row.group.collapsed ? `Expand ${row.group.name}` : `Collapse ${row.group.name}`}
                onclick={() => sessionsStore.toggleGroupCollapsed(row.group.id)}
              >
                {row.group.collapsed ? '▸' : '▾'}
              </button>
              <span class="h-2 w-2 flex-none rounded-full {color.dot}"></span>
              <button
                type="button"
                class="min-w-0 flex-1 truncate text-left text-xs font-medium text-zinc-300 hover:text-zinc-100"
                ondblclick={() => (groupRenameTarget = { id: row.group.id, currentLabel: row.group.name })}
                onclick={() => sessionsStore.toggleGroupCollapsed(row.group.id)}
                title="{row.group.name} — double-click to rename"
              >
                {row.group.name}
              </button>
              <span class="flex-none text-[10px] text-zinc-500">{row.members.length}</span>
            </div>

            {#if !row.group.collapsed}
              <div class="ml-2 flex flex-col gap-0.5 border-l-2 {color.bar} pl-1">
                {#each row.members as member (member.id)}
                  {@render sessionRow(member, true)}
                {/each}
              </div>
            {/if}
          </div>
        {/if}
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

  {#if groupMenu}
    <ContextMenu
      x={groupMenu.x}
      y={groupMenu.y}
      items={groupMenuItems}
      onpick={pickGroupMenuItem}
      onclose={() => (groupMenu = null)}
    />
  {/if}

  {#if colorMenu}
    <ContextMenu
      x={colorMenu.x}
      y={colorMenu.y}
      items={colorMenuItems}
      onpick={pickColor}
      onclose={() => (colorMenu = null)}
    />
  {/if}

  {#if partnerPicker}
    <ContextMenu
      x={partnerPicker.x}
      y={partnerPicker.y}
      items={partnerItems}
      onpick={pickPartner}
      onclose={() => (partnerPicker = null)}
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

{#if groupRenameTarget}
  <PromptModal
    title="Rename group"
    label="Group name"
    defaultValue={groupRenameTarget.currentLabel}
    confirmLabel="Rename"
    validate={validateRename}
    onsubmit={submitGroupRename}
    oncancel={() => (groupRenameTarget = null)}
  />
{/if}
