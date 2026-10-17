<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte'
  import { progressText, type TaskCard } from '../../lib/workflow-view'

  let { data }: { data: { card: TaskCard; onselect: (taskId: string) => void } } = $props()

  const TONE: Record<TaskCard['tone'], string> = {
    done: 'border-emerald-700/70 text-emerald-300',
    running: 'border-sky-600/80 text-sky-300',
    waiting: 'border-amber-500 text-amber-300',
    queued: 'border-zinc-700 text-zinc-400',
    failed: 'border-red-600 text-red-300',
    cancelled: 'border-zinc-800 text-zinc-600',
  }

  let card = $derived(data.card)
  let isMap = $derived(card.kind === 'map')
  let bar = $derived.by(() => {
    const s = card.stack
    if (!s || s.total === 0) return []
    return [
      { tone: 'bg-emerald-500', n: s.done },
      { tone: 'bg-amber-400', n: s.waiting },
      { tone: 'bg-red-500', n: s.failed },
      { tone: 'bg-sky-500', n: s.running },
    ]
      .filter((p) => p.n > 0)
      .map((p) => ({ ...p, width: `${(p.n / s.total) * 100}%` }))
  })
</script>

<Handle type="target" position={Position.Left} isConnectable={false} />
<div class="relative h-full w-full">
  {#if isMap}
    <!-- The stacked look of a fan-out: two cards peeking out behind it. -->
    <div class="pointer-events-none absolute inset-0 translate-x-2 -translate-y-2 rounded-lg border bg-zinc-900 {TONE[card.tone]} opacity-40" aria-hidden="true"></div>
    <div class="pointer-events-none absolute inset-0 translate-x-1 -translate-y-1 rounded-lg border bg-zinc-900 {TONE[card.tone]} opacity-70" aria-hidden="true"></div>
  {/if}
  <!-- `nokey`: xyflow would take Space on a focused card as its pan key. -->
  <button
    type="button"
    class="nokey relative flex h-full w-full cursor-pointer flex-col gap-0.5 overflow-hidden rounded-lg border bg-zinc-900 px-3 py-2 text-left text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 {TONE[card.tone]} {card.added ? 'border-dashed' : ''} {card.tone === 'cancelled' ? 'opacity-60' : ''} {card.highlight !== null ? 'ring-2 ring-violet-400' : ''}"
    onclick={() => data.onselect(card.id)}
    data-testid="workflow-card"
    data-task-id={card.id}
    data-tone={card.tone}
    data-kind={card.kind}
    data-highlight={card.highlight !== null ? 'true' : undefined}
  >
    <span class="flex items-center gap-1.5 font-medium">
      {#if card.highlight !== null}<span class="sr-only">Changed by patch {card.highlight}.</span>{/if}
      <span class="truncate">{card.status}</span>
      {#if card.round}
        <span class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-300" title="Review round {card.round.current} of {card.round.max}"
          >↻ {card.round.current}/{card.round.max}</span
        >
      {/if}
    </span>
    <b class="truncate text-[12px] text-zinc-100 {card.tone === 'cancelled' ? 'line-through' : ''}">{card.title}</b>
    <span class="truncate text-zinc-500">{card.agent}</span>
    {#if card.detail}<span class="truncate text-zinc-400">{card.detail}</span>{/if}
    {#if bar.length > 0 && card.stack}
      <span class="sr-only">Progress: {progressText(card.stack)}.</span>
      <span class="absolute inset-x-0 bottom-0 flex h-1 bg-zinc-800" aria-hidden="true" title={progressText(card.stack)} data-testid="workflow-map-progress">
        {#each bar as part (part.tone)}
          <span class="{part.tone} h-full" style:width={part.width}></span>
        {/each}
      </span>
    {/if}
  </button>
</div>
<Handle type="source" position={Position.Right} isConnectable={false} />
