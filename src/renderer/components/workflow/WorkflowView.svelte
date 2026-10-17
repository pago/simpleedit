<script lang="ts">
  import { workflowsStore } from '../../stores/workflows.svelte'
  import { sessionsStore } from '../../stores/sessions.svelte'
  import { getAgentStatusForTerminal } from '../../stores/agent-status.svelte'
  import { workflowOwner } from '../../../shared/session-owner'
  import { ownerIsCurrent } from '../../../shared/workflow'
  import { canCancel, canDismiss, canStart, cardIdOf, defaultSlot, needsYou, popupSlots, reviewerSlotKey, statusLine, taskCards } from '../../lib/workflow-view'
  import { patchRows } from '../../lib/workflow-patches'
  import WorkerPopup from './WorkerPopup.svelte'
  import PatchHistory from './PatchHistory.svelte'

  interface Props {
    workflowId: string
    /** The tab is on screen. */
    active: boolean
    onclose: () => void
  }

  let { workflowId, active, onclose }: Props = $props()

  let snapshot = $derived(workflowsStore.get(workflowId))
  /** Each current session restored and not resumed yet, by popup slot key. */
  let placeholders = $derived.by(() => {
    const bySlot = new Map<string, string>()
    const tasks = snapshot?.workflow.tasks ?? []
    for (const s of sessionsStore.sessions()) {
      const owner = workflowOwner(s)
      if (!s.pendingResume || owner?.workflowId !== workflowId) continue
      if (tasks.some((t) => ownerIsCurrent(t, owner))) bySlot.set(owner.review !== undefined ? reviewerSlotKey(owner.taskId) : owner.taskId, s.id)
    }
    return bySlot
  })
  let showPatches = $state(false)
  let selectedPatch = $state<number | null>(null)
  let highlighted = $derived.by(() => {
    if (!snapshot || selectedPatch === null) return undefined
    const row = patchRows(snapshot.workflow).find((r) => r.version === selectedPatch)
    return row ? { patch: row.number, taskIds: new Set(row.taskIds) } : undefined
  })
  let cards = $derived(snapshot ? taskCards(snapshot, getAgentStatusForTerminal, highlighted) : [])
  let needs = $derived(snapshot ? needsYou(snapshot, getAgentStatusForTerminal, new Set(placeholders.keys())) : [])
  let after = $derived(Object.fromEntries((snapshot?.workflow.tasks ?? []).map((t) => [t.id, t.after])))
  let open = $state<{ taskId: string; slot: string } | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)
  /** Cancel and Dismiss take a second click: one detaches workers, the other closes them. */
  let confirming = $state<'cancel' | 'dismiss' | null>(null)

  let openTask = $derived(open ? snapshot?.workflow.tasks.find((t) => t.id === open?.taskId) : undefined)
  let openCard = $derived(open ? cards.find((c) => c.id === open?.taskId) : undefined)
  let openSlots = $derived(snapshot && open ? popupSlots(snapshot, open.taskId, getAgentStatusForTerminal, placeholders) : [])

  function openSlot(slot: string): void {
    if (snapshot) open = { taskId: cardIdOf(snapshot.workflow, slot), slot }
  }

  let GraphView = $state<typeof import('./WorkflowGraph.svelte').default | null>(null)
  let graphError = $state<string | null>(null)
  $effect(() => {
    if (!GraphView) {
      // xyflow + elk are large; only a workflow tab pays for them.
      import('./WorkflowGraph.svelte')
        .then((m) => {
          GraphView = m.default
        })
        .catch((err: unknown) => {
          graphError = err instanceof Error ? err.message : String(err)
        })
    }
  })

  let disarmTimer: ReturnType<typeof setTimeout> | undefined
  function arm(action: 'cancel' | 'dismiss'): void {
    confirming = action
    clearTimeout(disarmTimer)
    disarmTimer = setTimeout(disarm, 4000)
  }
  function disarm(): void {
    clearTimeout(disarmTimer)
    confirming = null
  }
  $effect(() => disarm)

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true
    error = null
    try {
      await action()
    } catch (err) {
      error = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
    } finally {
      busy = false
      disarm()
    }
  }

  function startIt(): void {
    void run(() => workflowsStore.start(workflowId))
  }

  function cancelIt(): void {
    if (confirming !== 'cancel') {
      arm('cancel')
      return
    }
    void run(() => workflowsStore.cancel(workflowId))
  }

  function dismissIt(): void {
    if (confirming !== 'dismiss') {
      arm('dismiss')
      return
    }
    void run(async () => {
      await workflowsStore.dismiss(workflowId)
      onclose()
    })
  }
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-950" data-testid="workflow-view">
  {#if !snapshot && !workflowsStore.loaded()}
    <p class="p-5 text-xs text-zinc-500">Loading the workflow…</p>
  {:else if !snapshot}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-zinc-500">
      <p>This workflow was dismissed or belongs to another project.</p>
      <button type="button" class="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800" onclick={onclose}>Close tab</button>
    </div>
  {:else}
    {@const workflow = snapshot.workflow}
    <header class="flex flex-wrap items-start gap-x-6 gap-y-2 border-b border-zinc-800 px-5 py-3">
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-base font-semibold text-zinc-100">{workflow.title}</h1>
        <p class="text-xs text-zinc-400" data-testid="workflow-status">{statusLine(snapshot)}</p>
        <details class="mt-1 text-xs text-zinc-500">
          <summary class="cursor-pointer select-none">Goal</summary>
          <p class="mt-1 whitespace-pre-wrap text-zinc-400">{workflow.goal}</p>
        </details>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
          aria-expanded={showPatches}
          onclick={() => {
            showPatches = !showPatches
            if (!showPatches) selectedPatch = null
          }}
          data-testid="workflow-show-patches">{showPatches ? 'Hide patches' : 'Show patches'} ({workflow.patches.length})</button
        >
        {#if canStart(workflow)}
          <button
            type="button"
            class="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            disabled={busy}
            onclick={startIt}
            data-testid="workflow-start">Start</button
          >
        {/if}
        {#if canCancel(workflow)}
          <button
            type="button"
            class="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            disabled={busy}
            onclick={cancelIt}
            onblur={() => confirming === 'cancel' && disarm()}
            title="Running workers move to the sidebar as normal sessions">{confirming === 'cancel' ? 'Confirm cancel' : 'Cancel'}</button
          >
        {/if}
        {#if canDismiss(workflow)}
          <button
            type="button"
            class="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            disabled={busy}
            onclick={dismissIt}
            onblur={() => confirming === 'dismiss' && disarm()}
            title="Closes this workflow's worker sessions and archives it">{confirming === 'dismiss' ? 'Close workers and dismiss?' : 'Dismiss'}</button
          >
        {/if}
      </div>
      {#if error}
        <p class="w-full text-xs text-red-300" role="alert">{error}</p>
      {/if}
    </header>

    {#if needs.length > 0}
      <div class="border-b border-amber-900/50 bg-amber-950/20 px-5 py-2" data-testid="workflow-needs-you">
        <h2 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-300">Needs you · {needs.length}</h2>
        <ul class="flex flex-col gap-1">
          {#each needs as item (item.kind + item.slot)}
            <li class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span class="font-medium text-zinc-100">{item.title}</span>
              <span class="min-w-0 flex-1 text-zinc-400">{item.text}</span>
              {#if item.canOpen}
                <button
                  type="button"
                  class="rounded-md border border-amber-700/60 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-900/40"
                  onclick={() => openSlot(item.slot)}>Open terminal</button
                >
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if showPatches}
      <PatchHistory {workflow} selected={selectedPatch} onselect={(version) => (selectedPatch = version)} />
    {/if}

    <div class="min-h-0 flex-1">
      {#if GraphView}
        <GraphView {cards} {after} onselect={(id) => openSlot(defaultSlot(workflow, id))} />
      {:else if graphError}
        <p class="p-5 text-xs text-red-300" role="alert">The graph failed to load: {graphError}</p>
      {:else}
        <p class="p-5 text-xs text-zinc-500">Loading the graph…</p>
      {/if}
    </div>

    <footer class="flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-800 px-5 py-1.5 text-[11px] text-zinc-500">
      <span class="text-emerald-400">✓ done</span>
      <span class="text-sky-400">▶ running</span>
      <span class="text-amber-400">● waiting on you</span>
      <span>○ queued</span>
      <span>＋ added by a lead patch (dashed)</span>
      <span>✕ cancelled</span>
      <span>↻ review loop</span>
      <span>▤ fan-out</span>
      <span class="ml-auto">Click a card to open its worker</span>
    </footer>
  {/if}
</section>

{#if open && openTask && openCard}
  {#key `${open.taskId}|${open.slot}`}
    <WorkerPopup task={openTask} card={openCard} slots={openSlots} initialSlot={open.slot} {active} onclose={() => (open = null)} />
  {/key}
{/if}
