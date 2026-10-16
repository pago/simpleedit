<script lang="ts">
  /**
   * The Review Room's outline on the phone: behind a button, as a bottom
   * sheet, since the page has no room for a column. The desktop's filters and
   * groups (`renderer/lib/review-room.ts`); a tap closes the sheet and scrolls
   * the room to the thread or tour step.
   */
  import type { ReviewThread } from '../shared/review-room'
  import type { ReviewLayerInfo } from '../shared/review-room-ipc'
  import {
    OUTLINE_FILTERS,
    matchesFilter,
    originBadge,
    outlineGroups,
    outlineStatus,
    shortAnchorLabel,
    threadTitle,
    type OutlineFilter,
    type ThreadDraft,
  } from '../renderer/lib/review-room'

  interface Props {
    layers: ReviewLayerInfo[]
    threads: ReviewThread[]
    drafts: Map<string, ThreadDraft>
    reading: Map<string, { id: string; title: string; read: boolean }[]>
    onthread: (threadId: string) => void
    onstep: (stepId: string) => void
    onclose: () => void
  }

  let { layers, threads, drafts, reading, onthread, onstep, onclose }: Props = $props()

  let filter = $state<OutlineFilter>('open')
  let counts = $derived(new Map(OUTLINE_FILTERS.map((f) => [f.key, threads.filter((t) => matchesFilter(t, f.key, drafts.has(t.id))).length])))
  let groups = $derived(outlineGroups(threads.filter((t) => matchesFilter(t, filter, drafts.has(t.id))), layers))

  const SEVERITY_CLASS = { blocking: 'bg-red-500/15 text-red-300', consider: 'bg-amber-500/15 text-amber-300', nit: 'bg-zinc-700 text-zinc-300' } as const
</script>

<div role="dialog" aria-modal="true" aria-label="Review outline" tabindex="-1" class="fixed inset-0 z-40 flex flex-col justify-end" data-testid="outline-sheet">
  <button type="button" aria-label="Dismiss" onclick={onclose} class="flex-1 bg-black/60"></button>
  <div class="flex max-h-[80vh] flex-none flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-950 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
    <div class="mb-2 flex flex-none items-center gap-2">
      <h2 class="min-w-0 flex-1 text-[15px] font-semibold text-zinc-100">Outline</h2>
      <button type="button" onclick={onclose} class="-mr-1 min-h-9 px-2 text-sm text-zinc-400">Close</button>
    </div>
    <div class="flex flex-none flex-wrap gap-1.5" role="group" aria-label="Filter threads">
      {#each OUTLINE_FILTERS as f (f.key)}
        <button
          type="button"
          class="min-h-9 rounded-full border px-3 text-[12.5px] tabular-nums {filter === f.key ? 'border-zinc-200 bg-zinc-200 text-zinc-900' : 'border-zinc-700 text-zinc-300'}"
          aria-pressed={filter === f.key}
          data-testid="outline-filter-{f.key}"
          onclick={() => (filter = f.key)}
        >{f.label} {counts.get(f.key) ?? 0}</button>
      {/each}
    </div>
    <div class="mt-2 min-h-0 flex-1 overflow-y-auto">
      {#each groups as g (g.key)}
        <div class="mt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{g.label}</div>
        <ul class="mt-1 space-y-1">
          {#each g.items as t (t.id)}
            {@const badge = originBadge(t)}
            {@const severity = drafts.get(t.id)?.comment.severity ?? (t.origin.kind === 'finding' ? t.origin.severity : undefined)}
            <li>
              <button
                type="button"
                class="flex min-h-11 w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left active:bg-zinc-800 {t.status === 'done' ? 'opacity-60' : ''}"
                data-testid="outline-item"
                onclick={() => onthread(t.id)}
              >
                <span class="mt-0.5 flex h-5 min-w-5 flex-none items-center justify-center rounded px-0.5 text-[10px] font-bold {badge.tone}">{badge.mark}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13.5px] text-zinc-200">{threadTitle(t)}</span>
                  <span class="flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
                    {#if severity}<span class="rounded-full px-1.5 {SEVERITY_CLASS[severity]}">{severity}</span>{/if}
                    {#if t.outdated}<span class="rounded-full bg-amber-500/15 px-1.5 text-amber-300">outdated</span>{/if}
                    <span class="font-mono">{shortAnchorLabel(t.anchor)}</span> · {outlineStatus(t, drafts.has(t.id))}
                  </span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="px-1 py-3 text-[13px] text-zinc-500">Nothing here yet.</p>
      {/each}

      <div class="mt-4 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Reading</div>
      {#each layers as l (l.url)}
        {@const steps = reading.get(l.url) ?? []}
        {#if steps.length === 0}
          <p class="mt-1 px-1 text-[12px] text-zinc-500">#{l.number} · no reading order yet</p>
        {:else}
          <p class="mt-2 px-1 text-[12px] font-semibold text-zinc-500" data-testid="reading-progress">
            #{l.number} · {Math.round((100 * steps.filter((s) => s.read).length) / steps.length)}% read
          </p>
          {#each steps as s (s.id)}
            <button type="button" class="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] active:bg-zinc-800 {s.read ? 'text-zinc-500' : 'text-zinc-300'}" onclick={() => onstep(s.id)}>
              <span class="w-4 flex-none text-center text-[11px] text-blue-400">{s.read ? '✓' : ''}</span>
              <span class="truncate">{s.title}</span>
            </button>
          {/each}
        {/if}
      {/each}
    </div>
  </div>
</div>
