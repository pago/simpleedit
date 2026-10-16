<script lang="ts">
  /** The review's threads by filter and layer, and each layer's reading progress. A click scrolls the room to it. */
  import type { ReviewThread } from '../../../shared/review-room'
  import type { ReviewLayerInfo } from '../../../shared/review-room-ipc'
  import type { PrReviewComment } from '../../../shared/screenprs'
  import { OUTLINE_FILTERS, matchesFilter, originBadge, outlineGroups, outlineStatus, shortAnchorLabel, threadTitle, type OutlineFilter } from '../../lib/review-room'

  interface Props {
    layers: ReviewLayerInfo[]
    threads: ReviewThread[]
    drafts: Map<string, { url: string; comment: PrReviewComment }>
    reading: Map<string, { id: string; title: string; read: boolean }[]>
    onthread: (threadId: string) => void
    onjump: (targetId: string) => void
  }

  let { layers, threads, drafts, reading, onthread, onjump }: Props = $props()

  let filter = $state<OutlineFilter>('open')

  let counts = $derived(
    new Map(OUTLINE_FILTERS.map((f) => [f.key, threads.filter((t) => matchesFilter(t, f.key, drafts.has(t.id))).length])),
  )
  let shown = $derived(threads.filter((t) => matchesFilter(t, filter, drafts.has(t.id))))
  let groups = $derived(outlineGroups(shown, layers))

  const SEVERITY_CLASS = { blocking: 'bg-red-500/15 text-red-300', consider: 'bg-amber-500/15 text-amber-300', nit: 'bg-zinc-700 text-zinc-300' } as const

  const statusOf = (t: ReviewThread): string => outlineStatus(t, drafts.has(t.id))
</script>

<div class="flex flex-col gap-3 p-3" data-testid="review-outline">
  <div>
    <h3 class="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Threads</h3>
    <div class="flex flex-wrap gap-1" role="group" aria-label="Filter threads">
      {#each OUTLINE_FILTERS as f (f.key)}
        <button
          type="button"
          class="rounded-full border px-2 py-px text-[11px] tabular-nums {filter === f.key ? 'border-zinc-200 bg-zinc-200 text-zinc-900' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'}"
          aria-pressed={filter === f.key}
          data-testid="outline-filter-{f.key}"
          onclick={() => (filter = f.key)}
        >{f.label} {counts.get(f.key) ?? 0}</button>
      {/each}
    </div>
    <div class="mt-2 flex flex-col gap-0.5">
      {#each groups as g (g.key)}
        <div class="ml-1 mt-2 text-[11px] font-semibold text-zinc-500">{g.label}</div>
        {#each g.items as t (t.id)}
          {@const badge = originBadge(t)}
          {@const severity = drafts.get(t.id)?.comment.severity ?? (t.origin.kind === 'finding' ? t.origin.severity : undefined)}
          <button
            type="button"
            class="grid grid-cols-[auto_1fr] items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-zinc-800/70 {t.status === 'done' ? 'opacity-50' : ''}"
            data-testid="outline-item"
            onclick={() => onthread(t.id)}
          >
            <span class="mt-px flex h-4 min-w-4 items-center justify-center rounded px-0.5 text-[9px] font-bold {badge.tone}" title={badge.label}>{badge.mark}</span>
            <span class="min-w-0">
              <span class="block truncate text-[12px] text-zinc-200">{threadTitle(t)}</span>
              <span class="flex flex-wrap items-center gap-1 text-[10.5px] text-zinc-500">
                {#if severity}<span class="rounded-full px-1.5 {SEVERITY_CLASS[severity]}">{severity}</span>{/if}
                {#if t.outdated}<span class="rounded-full bg-amber-500/15 px-1.5 text-amber-300">outdated</span>{/if}
                <span class="font-mono">{shortAnchorLabel(t.anchor)}</span> · {statusOf(t)}
              </span>
            </span>
          </button>
        {/each}
      {:else}
        <p class="px-1.5 py-1 text-[11.5px] text-zinc-500">Nothing here yet.</p>
      {/each}
    </div>
  </div>

  <div>
    <h3 class="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Reading</h3>
    {#each layers as l (l.url)}
      {@const steps = reading.get(l.url) ?? []}
      {#if steps.length === 0}
        <div class="ml-1 mt-1.5 text-[11px] text-zinc-500">#{l.number} · no reading order yet</div>
      {:else}
        <div class="ml-1 mt-1.5 text-[11px] font-semibold text-zinc-500" data-testid="reading-progress">
          #{l.number} · {Math.round((100 * steps.filter((s) => s.read).length) / steps.length)}% read
        </div>
        {#each steps as s (s.id)}
          <button type="button" class="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-[12px] hover:bg-zinc-800/70 {s.read ? 'text-zinc-500' : 'text-zinc-300'}" onclick={() => onjump(`step-${s.id}`)}>
            <span class="w-3 flex-none text-center text-[10px] text-blue-400">{s.read ? '✓' : ''}</span>
            <span class="truncate">{s.title}</span>
          </button>
        {/each}
      {/if}
    {/each}
  </div>
</div>
