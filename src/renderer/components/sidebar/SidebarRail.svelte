<script lang="ts">
  import { tick } from 'svelte'
  import SessionList from './SessionList.svelte'
  import NewSessionButtons from './NewSessionButtons.svelte'
  import StatusDot from './StatusDot.svelte'
  import SectionIcon from './SectionIcon.svelte'
  import BacklogList from '../backlog/BacklogList.svelte'
  import ScreenPrsQueue from '../screenprs/ScreenPrsQueue.svelte'
  import { uiView, type UiView } from '../../stores/uiView.svelte'
  import { sidebarRail } from '../../stores/sidebarRail.svelte'
  import { sessionsStore } from '../../stores/sessions.svelte'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { backlogStore } from '../../stores/backlog.svelte'
  import { currentSessionsAttention } from '../../stores/sessionAttention.svelte'
  import { attentionTooltip } from '../../lib/sessionsAttention'
  import { SIDEBAR_RAIL_WIDTH } from '../../lib/sidebarCollapse'

  /** Each section's remembered sidebar width: the overlay opens at it. */
  let { widths }: { widths: Record<UiView, number> } = $props()

  const OVERLAY_ID = 'sidebar-overlay'
  const SECTIONS: { view: UiView; label: string }[] = [
    { view: 'workspace', label: 'Sessions' },
    { view: 'backlog', label: 'Backlog' },
    { view: 'screenprs', label: 'Screen PRs' },
  ]

  let view = $derived(uiView.current())
  let overlay = $derived(sidebarRail.overlay())
  let overlayLabel = $derived(SECTIONS.find((s) => s.view === overlay?.view)?.label ?? '')
  let sessionsAttention = $derived(currentSessionsAttention())
  let attention = $derived(screenPrsStore.attentionCount())
  let backlogCount = $derived(backlogStore.items.length)

  let zoneEl: HTMLElement | undefined = $state()
  let overlayEl: HTMLElement | undefined = $state()
  let returnFocus: HTMLElement | null = null
  let focusedGeneration = -1

  // Opened by click or keyboard: focus moves in, and Esc gives it back. A
  // section switch from inside keeps the original place to return to.
  $effect(() => {
    const ov = overlay
    if (!ov?.focus || ov.generation === focusedGeneration) return
    focusedGeneration = ov.generation
    const active = document.activeElement
    if (active instanceof HTMLElement && !overlayEl?.contains(active)) returnFocus = active
    void tick().then(() => overlayEl?.focus())
  })

  interface NavState {
    view: UiView
    session: string | null
    backlog: string | null
    pr: string | null
  }
  let baseline: NavState | null = null
  let baselineGeneration = -1

  // Choosing an item closes the overlay. Rather than wire every row, watch what
  // the rows change: the view, the active session, the picked backlog item or PR.
  // A pick in the Backlog or Screen PRs overlay also brings its view forward,
  // since the overlay can be over another one.
  $effect(() => {
    const ov = overlay
    const now: NavState = {
      view: uiView.current(),
      session: sessionsStore.activeSessionId(),
      backlog: backlogStore.selectedId,
      pr: screenPrsStore.selectedKey(),
    }
    if (!ov) {
      baseline = null
      return
    }
    if (!baseline || ov.generation !== baselineGeneration) {
      baseline = now
      baselineGeneration = ov.generation
      return
    }
    const was = baseline
    const chosen =
      now.view !== was.view ||
      (ov.view === 'workspace' && now.session !== was.session) ||
      (ov.view === 'backlog' && now.backlog !== was.backlog && pickedBacklogItem(was.backlog, now.backlog)) ||
      (ov.view === 'screenprs' && now.pr !== was.pr && now.pr !== null)
    if (!chosen) {
      baseline = now
      return
    }
    if (now.view === was.view && ov.view !== 'workspace') uiView.show(ov.view)
    sidebarRail.close()
  })

  /**
   * The list selects its first item by itself when nothing (or a removed item)
   * is selected; only a move away from a selection that still exists is a pick.
   */
  function pickedBacklogItem(from: string | null, to: string | null): boolean {
    if (!from || !to) return false
    return !!(backlogStore.get(from) || backlogStore.draft(from))
  }

  // Context menus and modals opened from the overlay render inside it (fixed,
  // not portalled), so a click on them is inside too.
  $effect(() => {
    if (!overlay) return
    function onPointerDown(e: PointerEvent): void {
      if (zoneEl && !zoneEl.contains(e.target as Node)) sidebarRail.close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  })

  function onWindowKeydown(e: KeyboardEvent): void {
    // Menus and modals inside the overlay take Esc for themselves first.
    if (e.key !== 'Escape' || !overlay || e.defaultPrevented) return
    const hadFocus = !!zoneEl?.contains(document.activeElement)
    sidebarRail.close()
    if (hadFocus) returnFocus?.focus()
    returnFocus = null
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- One hover zone: the rail and the overlay beside it. -->
<div
  bind:this={zoneEl}
  class="h-full"
  role="presentation"
  onpointerenter={() => sidebarRail.enterZone()}
  onpointerleave={() => sidebarRail.leaveZone()}
>
  <nav class="flex h-full flex-col items-center gap-1 py-2" aria-label="Sidebar sections">
    {#each SECTIONS as section (section.view)}
      {@const current = view === section.view}
      {@const open = overlay?.view === section.view}
      <button
        class="relative flex h-8 w-8 items-center justify-center rounded-md transition-colors
          {current ? 'bg-zinc-800 text-zinc-100 shadow-[inset_2px_0_0_theme(colors.blue.500)]' : open ? 'bg-zinc-800' : 'hover:bg-zinc-800'}"
        aria-label={section.label}
        aria-expanded={open}
        aria-controls={open ? OVERLAY_ID : undefined}
        aria-current={current ? 'true' : undefined}
        title={section.view === 'workspace' ? attentionTooltip(sessionsAttention.counts) : undefined}
        onpointerenter={() => sidebarRail.hoverIcon(section.view)}
        onpointerleave={() => sidebarRail.leaveIcon()}
        onclick={() => sidebarRail.clickIcon(section.view)}
      >
        <SectionIcon view={section.view} class="h-4 w-4 {current ? 'text-zinc-100' : 'text-zinc-400'}" />
        {#if section.view === 'workspace'}
          <span class="absolute right-1 top-1 flex h-2 w-2" data-testid="rail-sessions-attention">
            <StatusDot level={sessionsAttention.level} />
          </span>
        {:else if section.view === 'backlog' && backlogCount > 0}
          <span class="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-zinc-700 px-1 text-[9px] font-bold tabular-nums text-zinc-200">{backlogCount}</span>
        {:else if section.view === 'screenprs' && attention > 0}
          <span class="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold tabular-nums text-white">{attention}</span>
        {/if}
      </button>
    {/each}
  </nav>

  {#if overlay}
    <!-- Over <main>, not beside it: opening and closing never moves the layout.
         Any interaction inside pins it, so a backlog drag or a context menu
         can't be cut short by the pointer leaving. -->
    <div
      bind:this={overlayEl}
      id={OVERLAY_ID}
      role="dialog"
      aria-modal="false"
      aria-label={overlayLabel}
      tabindex="-1"
      class="absolute bottom-0 top-0 z-40 flex flex-col border-r border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/50 outline-none"
      style:left="{SIDEBAR_RAIL_WIDTH}px"
      style:width="{widths[overlay.view]}px"
      onpointerdown={() => sidebarRail.pin()}
      onfocusin={() => sidebarRail.pin()}
    >
      <div class="flex flex-none items-center gap-2 border-b border-zinc-800 py-1 pl-4 pr-3">
        <SectionIcon view={overlay.view} />
        <span class="min-w-0 flex-1 truncate py-2 text-xs font-medium text-zinc-100">{overlayLabel}</span>
        {#if overlay.view === 'workspace'}
          <NewSessionButtons />
        {/if}
      </div>
      <div class="@container min-h-0 flex-1 overflow-y-auto">
        {#if overlay.view === 'workspace'}
          <div class="px-3 py-2">
            <SessionList />
          </div>
        {:else if overlay.view === 'backlog'}
          <BacklogList class="min-h-full" />
        {:else}
          <ScreenPrsQueue class="min-h-full" />
        {/if}
      </div>
    </div>
  {/if}
</div>
