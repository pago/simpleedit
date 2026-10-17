<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import Terminal from '../terminal/Terminal.svelte'
  import { overSource, type WorkflowTask } from '../../../shared/workflow'
  import type { CardTone, PopupSlot, TaskCard } from '../../lib/workflow-view'
  import { sessionsStore } from '../../stores/sessions.svelte'

  interface Props {
    /** The card's task: a map's children are its slots. */
    task: WorkflowTask
    card: TaskCard
    slots: PopupSlot[]
    initialSlot: string
    /** The tab is on screen: a hidden popup's terminal doesn't count as attended. */
    active: boolean
    onclose: () => void
  }

  let { task, card, slots, initialSlot, active, onclose }: Props = $props()
  let showBrief = $state(false)
  let selectedKey = $state(untrack(() => initialSlot))
  let dialog = $state<HTMLDivElement | null>(null)

  let slot = $derived(slots.find((s) => s.key === selectedKey) ?? slots[0])
  let terminalId = $derived(slot?.terminalId ?? null)
  let placeholderId = $derived(slot?.placeholderId ?? null)
  let shown = $derived(slot?.task ?? task)
  let provider = $derived(terminalId ? sessionsStore.get(terminalId)?.provider : undefined)
  let who = $derived(slot?.role === 'reviewer' ? 'reviewer' : 'worker')
  let showStrip = $derived(slots.length > 1 || task.kind === 'map')

  const TONE: Record<CardTone, string> = {
    done: 'text-emerald-300',
    running: 'text-sky-300',
    waiting: 'text-amber-300',
    queued: 'text-zinc-400',
    failed: 'text-red-300',
    cancelled: 'text-zinc-500',
  }
  const DOT: Record<CardTone, string> = {
    done: 'bg-emerald-400',
    running: 'bg-sky-400',
    waiting: 'bg-amber-400',
    queued: 'bg-zinc-500',
    failed: 'bg-red-400',
    cancelled: 'bg-zinc-700',
  }

  onMount(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  })

  function handleKeydown(e: KeyboardEvent): void {
    // The terminal owns Escape while it has focus: agents use it.
    if (e.key === 'Escape' && e.target === dialog) {
      e.preventDefault()
      onclose()
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onclick={onclose}>
  <div
    bind:this={dialog}
    class="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl outline-none"
    role="dialog"
    aria-modal="true"
    aria-label="{task.title}: {who} terminal"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleKeydown}
    data-testid="workflow-worker-popup"
  >
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-800 px-4 py-2.5">
      <span class="text-[11px] font-semibold {TONE[card.tone]}">{card.status}</span>
      <span class="text-sm font-semibold text-zinc-100">{task.title}</span>
      <span class="truncate font-mono text-[11px] text-zinc-500">{slot?.agent ?? card.agent}{shown.worktreePath ? ` · ${shown.worktreePath}` : ''}</span>
      <span class="ml-auto flex gap-2">
        <button
          type="button"
          class="rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
          aria-pressed={showBrief}
          onclick={() => (showBrief = !showBrief)}>Brief</button
        >
        <button type="button" class="rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700" aria-label="Close" onclick={onclose}>✕</button>
      </span>
    </div>

    {#if showStrip}
      <div class="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 px-3 py-1.5" role="group" aria-label="Sessions of this task" data-testid="workflow-popup-slots">
        {#each slots as s (s.key)}
          <button
            type="button"
            class="flex max-w-64 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] {s.key === slot?.key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'}"
            aria-pressed={s.key === slot?.key}
            onclick={() => (selectedKey = s.key)}
            data-slot={s.key}
          >
            <span class="size-1.5 shrink-0 rounded-full {DOT[s.tone]}" aria-hidden="true"></span>
            <span class="truncate">{s.label}</span>
            <span class="shrink-0 {TONE[s.tone]}">{s.status}</span>
          </button>
        {:else}
          <span class="px-1 py-1 text-[11px] text-zinc-500">Its items aren't known yet: the map fans out once {(task.over && overSource(task.over)) || 'its source'} reports.</span>
        {/each}
      </div>
    {/if}

    {#if showBrief || !terminalId}
      <div class="max-h-[40%] shrink-0 overflow-auto border-b border-zinc-800 px-4 py-3 text-xs text-zinc-300" class:flex-1={!terminalId}>
        {#if slot?.role === 'reviewer' && slot.round}
          {@const round = slot.round}
          <h3 class="mb-1 font-semibold text-zinc-200">
            Review of round {round.round}{round.verdict ? ` · ${round.verdict}` : ''}{round.reviewerSteered ? ' · you stepped in' : ''}
          </h3>
          {#if round.reviewerSummary}<p class="mb-2 whitespace-pre-wrap">{round.reviewerSummary}</p>{/if}
          {#if round.note}<p class="mb-2 whitespace-pre-wrap text-amber-200/80">{round.note}</p>{/if}
          {#if round.findings?.length}
            <ol class="mb-3 list-decimal space-y-1 pl-5">
              {#each round.findings as finding, i (i)}<li class="whitespace-pre-wrap">{finding}</li>{/each}
            </ol>
          {/if}
          {#if task.reviewer}
            <h3 class="mb-1 font-semibold text-zinc-200">Reviewer brief</h3>
            <p class="whitespace-pre-wrap font-mono text-[11px] text-zinc-400">{task.reviewer.brief}</p>
          {/if}
        {:else}
          {#if shown.item !== undefined}
            <h3 class="mb-1 font-semibold text-zinc-200">Item {shown.index ?? ''}</h3>
            <p class="mb-3 whitespace-pre-wrap">{shown.item}</p>
          {/if}
          {#if shown.result}
            <h3 class="mb-1 font-semibold text-zinc-200">Result · {shown.result.status}{shown.result.steered ? ' · you stepped in' : ''}</h3>
            <p class="mb-3 whitespace-pre-wrap">{shown.result.summary}</p>
          {/if}
          {#if shown.note}
            <p class="mb-3 whitespace-pre-wrap text-amber-200/80">{shown.note}</p>
          {/if}
          {#if shown.kind === 'loop' && shown.rounds?.length}
            <h3 class="mb-1 font-semibold text-zinc-200">Rounds</h3>
            <ol class="mb-3 space-y-2" data-testid="workflow-loop-rounds">
              {#each shown.rounds as round (round.round)}
                <li class="rounded-md border border-zinc-800 px-2.5 py-1.5">
                  <div class="flex flex-wrap gap-x-2 text-[11px]">
                    <b class="text-zinc-200">Round {round.round}</b>
                    <span class="text-zinc-400">
                      {round.review === 'pending'
                        ? 'working'
                        : round.review === 'done'
                          ? round.verdict === 'clean'
                            ? 'clean'
                            : `${round.findings?.length ?? 0} findings`
                          : `review ${round.review}`}
                    </span>
                    {#if round.work?.steered}<span class="text-amber-300/80">you stepped in (worker)</span>{/if}
                    {#if round.reviewerSteered}<span class="text-amber-300/80">you stepped in (reviewer)</span>{/if}
                  </div>
                  {#if round.work}<p class="mt-1 whitespace-pre-wrap text-zinc-400">{round.work.summary}</p>{/if}
                  {#if round.findings?.length}
                    <ol class="mt-1 list-decimal space-y-0.5 pl-5 text-zinc-300">
                      {#each round.findings as finding, i (i)}<li class="whitespace-pre-wrap">{finding}</li>{/each}
                    </ol>
                  {/if}
                  {#if round.note}<p class="mt-1 text-amber-200/80">{round.note}</p>{/if}
                </li>
              {/each}
            </ol>
          {/if}
          <h3 class="mb-1 font-semibold text-zinc-200">Brief</h3>
          <p class="whitespace-pre-wrap font-mono text-[11px] text-zinc-400">{shown.brief}</p>
          {#if shown.acceptance}
            <h3 class="mb-1 mt-3 font-semibold text-zinc-200">Done means</h3>
            <p class="whitespace-pre-wrap">{shown.acceptance}</p>
          {/if}
        {/if}
      </div>
    {/if}

    {#if terminalId}
      <div class="min-h-0 flex-1 bg-zinc-950">
        {#key terminalId}
          <Terminal {terminalId} {active} {provider} />
        {/key}
      </div>
      <div class="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
        You're typing straight into this {who}. The lead is told you stepped in when the task reports back.
      </div>
    {:else if placeholderId}
      <div class="flex items-center gap-3 border-t border-zinc-800 px-4 py-3 text-xs text-zinc-400">
        <span>This {who} was restored and hasn't been resumed.</span>
        <button
          type="button"
          class="rounded-md bg-sky-700 px-2.5 py-1 text-xs text-white hover:bg-sky-600"
          onclick={() => placeholderId && sessionsStore.resumePlaceholder(placeholderId)}>Resume</button
        >
      </div>
    {:else if slot && shown.attempt > 0}
      <div class="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">No {who} session is open for this task.</div>
    {/if}
  </div>
</div>
