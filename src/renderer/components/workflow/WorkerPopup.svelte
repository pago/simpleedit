<script lang="ts">
  import { onMount } from 'svelte'
  import Terminal from '../terminal/Terminal.svelte'
  import type { WorkflowTask } from '../../../shared/workflow'
  import type { TaskCard } from '../../lib/workflow-view'
  import { sessionsStore } from '../../stores/sessions.svelte'

  interface Props {
    task: WorkflowTask
    card: TaskCard
    /** The current worker's terminal, when it has a live one. */
    terminalId: string | null
    /** A restored worker not resumed yet. */
    placeholderId: string | null
    /** The tab is on screen: a hidden popup's terminal doesn't count as attended. */
    active: boolean
    onclose: () => void
  }

  let { task, card, terminalId, placeholderId, active, onclose }: Props = $props()
  let showBrief = $state(false)
  let dialog = $state<HTMLDivElement | null>(null)

  let provider = $derived(terminalId ? sessionsStore.get(terminalId)?.provider : undefined)

  const TONE: Record<TaskCard['tone'], string> = {
    done: 'text-emerald-300',
    running: 'text-sky-300',
    waiting: 'text-amber-300',
    queued: 'text-zinc-400',
    failed: 'text-red-300',
    cancelled: 'text-zinc-500',
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
    aria-label="{task.title}: worker terminal"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleKeydown}
    data-testid="workflow-worker-popup"
  >
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-800 px-4 py-2.5">
      <span class="text-[11px] font-semibold {TONE[card.tone]}">{card.status}</span>
      <span class="text-sm font-semibold text-zinc-100">{task.title}</span>
      <span class="truncate font-mono text-[11px] text-zinc-500">{card.agent}{task.worktreePath ? ` · ${task.worktreePath}` : ''}</span>
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

    {#if showBrief || !terminalId}
      <div class="max-h-[40%] shrink-0 overflow-auto border-b border-zinc-800 px-4 py-3 text-xs text-zinc-300" class:flex-1={!terminalId}>
        {#if task.result}
          <h3 class="mb-1 font-semibold text-zinc-200">Result · {task.result.status}{task.result.steered ? ' · you stepped in' : ''}</h3>
          <p class="mb-3 whitespace-pre-wrap">{task.result.summary}</p>
        {/if}
        {#if task.note}
          <p class="mb-3 whitespace-pre-wrap text-amber-200/80">{task.note}</p>
        {/if}
        <h3 class="mb-1 font-semibold text-zinc-200">Brief</h3>
        <p class="whitespace-pre-wrap font-mono text-[11px] text-zinc-400">{task.brief}</p>
        {#if task.acceptance}
          <h3 class="mb-1 mt-3 font-semibold text-zinc-200">Done means</h3>
          <p class="whitespace-pre-wrap">{task.acceptance}</p>
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
        You're typing straight into this worker. The lead is told you stepped in when the task reports back.
      </div>
    {:else if placeholderId}
      <div class="flex items-center gap-3 border-t border-zinc-800 px-4 py-3 text-xs text-zinc-400">
        <span>This worker was restored and hasn't been resumed.</span>
        <button
          type="button"
          class="rounded-md bg-sky-700 px-2.5 py-1 text-xs text-white hover:bg-sky-600"
          onclick={() => placeholderId && sessionsStore.resumePlaceholder(placeholderId)}>Resume</button
        >
      </div>
    {:else if task.attempt > 0}
      <div class="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">No worker session is open for this task.</div>
    {/if}
  </div>
</div>
