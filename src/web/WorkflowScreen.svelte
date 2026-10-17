<script lang="ts">
  /**
   * One workflow, read-only: the phone's form of the lead's Workflow tab.
   *
   * Starting, cancelling and dismissing are the desk's (main refuses them from
   * a socket). What the phone does is answer: Needs you sits on top, then the
   * desk's columns as sections ("Stage n"), and a tap on a row opens the
   * terminal of whoever speaks for that task (its worker, or a loop's reviewer
   * while it reviews). Typing there steers the task, as at the desk.
   *
   * Terminals open only while this phone is joined to the lead's window:
   * workers are that window's PTYs. Otherwise the screen still reads, and says
   * why nothing opens.
   */
  import { tick } from 'svelte'
  import type { WorkflowSnapshot } from '../shared/workflow'
  import { needsYou, statusLine, taskCards, type CardTone, type TaskCard } from '../renderer/lib/workflow-view'
  import { childCards, slotTerminal, stagesOf, taskTerminal, type StatusOf } from './lib/workflow-phone'

  interface Props {
    snapshot: WorkflowSnapshot
    statusOf: StatusOf
    /** The lead's other workflows, to switch to. */
    siblings?: WorkflowSnapshot[]
    /** Why no terminal can be opened from this phone right now, or null. */
    blocked: string | null
    /** A fresh object per ask: highlight this task's row and scroll to it. */
    focusTask?: { taskId: string }
    /** This is the screen on top of the tab being shown. */
    visible?: boolean
    onopen: (terminalId: string) => void
    onswitch?: (workflowId: string) => void
  }

  let { snapshot, statusOf, siblings = [], blocked, focusTask, visible = true, onopen, onswitch }: Props = $props()

  const cards = $derived(taskCards(snapshot, statusOf))
  const stages = $derived(stagesOf(cards))
  const needs = $derived(needsYou(snapshot, statusOf))
  const focused = $derived(focusTask?.taskId ?? null)
  let scroller = $state<HTMLElement | undefined>()
  /** The ask already scrolled to: coming Back to this screen keeps the user's scroll. */
  let scrolledFor: { taskId: string } | undefined

  $effect(() => {
    const ask = focusTask
    if (!ask || ask === scrolledFor || !visible) return
    scrolledFor = ask
    const target = ask.taskId
    void tick().then(() => {
      const row = scroller?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(target)}"]`)
      row?.scrollIntoView({ block: 'center' })
    })
  })

  function dotClass(tone: CardTone): string {
    switch (tone) {
      case 'waiting': return 'bg-amber-400'
      case 'running': return 'bg-emerald-400 animate-pulse'
      case 'done': return 'bg-emerald-600'
      case 'failed': return 'bg-red-500'
      case 'cancelled': return 'bg-zinc-700'
      default: return 'bg-zinc-500'
    }
  }
</script>

{#snippet row(card: TaskCard, terminalId: string | null, nested: boolean)}
  {@const openable = terminalId !== null && blocked === null}
  <button
    type="button"
    disabled={!openable}
    onclick={() => { if (terminalId) onopen(terminalId) }}
    data-testid="workflow-task"
    data-task-id={card.id}
    data-focused={focused === card.id ? 'true' : undefined}
    class="flex w-full items-start gap-3 rounded-lg border bg-zinc-900 px-3 py-2.5 text-left
      enabled:active:bg-zinc-800 disabled:cursor-default
      {focused === card.id ? 'border-sky-500 ring-1 ring-sky-500' : 'border-zinc-800'}
      {nested ? 'py-2' : ''}"
  >
    <span class="mt-1.5 h-2 w-2 flex-none rounded-full {dotClass(card.tone)}"></span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm text-zinc-100">{card.title}</span>
      <span class="block truncate text-[11px] text-zinc-400">{card.status}</span>
      {#if card.detail}<span class="block truncate text-[11px] text-zinc-500">{card.detail}</span>{/if}
      <span class="mt-1 flex flex-wrap gap-1.5 text-[10px] text-zinc-400">
        <span class="rounded bg-zinc-800 px-1.5 py-0.5">{card.agent}</span>
        {#if card.round}
          <span class="rounded bg-zinc-800 px-1.5 py-0.5" data-testid="loop-round">Round {card.round.current}/{card.round.max}</span>
        {/if}
      </span>
    </span>
    {#if openable}<span class="flex-none self-center text-zinc-600" aria-hidden="true">›</span>{/if}
  </button>
{/snippet}

<div bind:this={scroller} class="h-full min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="workflow-screen">
  <div class="mb-4 px-1">
    <p class="text-[11px] text-zinc-500">Led by {snapshot.workflow.leadLabel}</p>
    <p class="mt-0.5 text-xs leading-relaxed text-zinc-300" data-testid="workflow-status">{statusLine(snapshot)}</p>
    {#if siblings.length > 1}
      <div class="mt-2 flex gap-1.5 overflow-x-auto" data-testid="workflow-siblings">
        {#each siblings as other (other.workflow.id)}
          <button
            type="button"
            onclick={() => onswitch?.(other.workflow.id)}
            disabled={other.workflow.id === snapshot.workflow.id}
            aria-current={other.workflow.id === snapshot.workflow.id ? 'page' : undefined}
            class="max-w-[60%] flex-none truncate rounded-full border px-2.5 py-1 text-[11px]
              {other.workflow.id === snapshot.workflow.id ? 'border-zinc-500 text-zinc-100' : 'border-zinc-800 text-zinc-400 active:bg-zinc-800'}"
          >{other.workflow.title}</button>
        {/each}
      </div>
    {/if}
  </div>

  {#if blocked}
    <div
      class="mb-4 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-300"
      data-testid="workflow-open-blocked"
    >{blocked}</div>
  {/if}

  {#if needs.length > 0}
    <section class="mb-5" data-testid="workflow-needs-you">
      <h2 class="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-wider text-amber-400">Needs you</h2>
      <ul class="space-y-1.5">
        {#each needs as item (`${item.kind}:${item.taskId}`)}
          {@const terminalId = slotTerminal(snapshot, item.slot)}
          {@const openable = terminalId !== null && blocked === null}
          <li>
            <button
              type="button"
              disabled={!openable}
              onclick={() => { if (terminalId) onopen(terminalId) }}
              data-testid="needs-you-item"
              data-task-id={item.taskId}
              class="flex w-full items-start gap-3 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2.5
                text-left enabled:active:bg-amber-950/40 disabled:cursor-default"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-zinc-100">{item.title}</span>
                <span class="block text-[12px] leading-snug text-zinc-400">{item.text}</span>
                {#if terminalId === null && blocked === null}
                  <span class="mt-0.5 block text-[11px] text-zinc-500">No live terminal to answer in. Answer at the desk.</span>
                {/if}
              </span>
              {#if openable}<span class="flex-none self-center text-zinc-500" aria-hidden="true">›</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#each stages as stage (stage.depth)}
    <section class="mb-5" data-testid="workflow-stage" data-depth={stage.depth}>
      <h2 class="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Stage {stage.depth + 1}</h2>
      <ul class="space-y-1.5">
        {#each stage.cards as card (card.id)}
          <li>
            {@render row(card, card.kind === 'map' ? null : taskTerminal(snapshot, card.id), false)}
            {#if card.kind === 'map'}
              {@const children = childCards(snapshot, card.id, statusOf)}
              {#if children.length > 0}
                <ul class="mt-1.5 ml-4 space-y-1.5 border-l border-zinc-800 pl-2" data-testid="map-children">
                  {#each children as child (child.id)}
                    <li>{@render row(child, taskTerminal(snapshot, child.id), true)}</li>
                  {/each}
                </ul>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>
