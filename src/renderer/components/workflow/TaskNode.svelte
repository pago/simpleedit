<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte'
  import type { TaskCard } from '../../lib/workflow-view'

  let { data }: { data: { card: TaskCard; onselect: (taskId: string) => void } } = $props()

  const TONE: Record<TaskCard['tone'], string> = {
    done: 'border-emerald-700/70 text-emerald-300',
    running: 'border-sky-600/80 text-sky-300',
    waiting: 'border-amber-500 text-amber-300',
    queued: 'border-zinc-700 text-zinc-400',
    failed: 'border-red-600 text-red-300',
    cancelled: 'border-zinc-800 text-zinc-600',
  }
</script>

<Handle type="target" position={Position.Left} isConnectable={false} />
<!-- `nokey`: xyflow would take Space on a focused card as its pan key. -->
<button
  type="button"
  class="nokey flex h-full w-full cursor-pointer flex-col gap-0.5 rounded-lg border bg-zinc-900 px-3 py-2 text-left text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 {TONE[data.card.tone]} {data.card.added ? 'border-dashed' : ''} {data.card.tone === 'cancelled' ? 'opacity-60' : ''}"
  onclick={() => data.onselect(data.card.id)}
  data-testid="workflow-card"
  data-task-id={data.card.id}
  data-tone={data.card.tone}
>
  <span class="font-medium">{data.card.status}</span>
  <b class="truncate text-[12px] text-zinc-100 {data.card.tone === 'cancelled' ? 'line-through' : ''}">{data.card.title}</b>
  <span class="truncate text-zinc-500">{data.card.agent}</span>
  {#if data.card.detail}<span class="truncate text-zinc-400">{data.card.detail}</span>{/if}
</button>
<Handle type="source" position={Position.Right} isConnectable={false} />
