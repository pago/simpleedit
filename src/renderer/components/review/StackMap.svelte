<script lang="ts">
  /** The stack, bottom → top, as jump targets: open threads, drafts to post, reading progress, new commits. */
  import type { ReviewLayerInfo } from '../../../shared/review-room-ipc'
  import type { LayerFigures } from '../../lib/review-room'

  interface Props {
    layers: ReviewLayerInfo[]
    figures: Map<string, LayerFigures>
    stackThreads: number
    onjump: (targetId: string) => void
  }

  let { layers, figures, stackThreads, onjump }: Props = $props()
</script>

<nav class="flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Stack">
  {#if layers.length > 1 || stackThreads > 0}
    <button
      type="button"
      class="flex flex-none flex-col gap-0.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-left hover:border-zinc-600"
      onclick={() => onjump('review-stack')}
    >
      <span class="text-[12px] font-semibold text-zinc-200">Whole stack</span>
      <span class="text-[10.5px] text-zinc-500">{layers.length} layer{layers.length === 1 ? '' : 's'}</span>
    </button>
  {/if}
  {#each layers as l, i (l.url)}
    {@const f = figures.get(l.url)}
    {#if i > 0 || layers.length > 1}<span class="flex-none self-center text-zinc-600" aria-hidden="true">{i === 0 ? '·' : '→'}</span>{/if}
    <button
      type="button"
      class="flex min-w-[10rem] max-w-[15rem] flex-none flex-col gap-0.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-left hover:border-zinc-600"
      title={l.title}
      onclick={() => onjump(`layer-${l.number}`)}
      data-testid="stack-layer"
    >
      <span class="truncate text-[12px] font-semibold text-zinc-200">#{l.number} {l.title}</span>
      <span class="flex gap-2 text-[10.5px] tabular-nums text-zinc-500">
        <span><span class="text-emerald-400">+{l.additions}</span> <span class="text-red-400">−{l.deletions}</span></span>
        <span>{f?.open ?? 0} open</span>
        <span>{f?.toPost ?? 0} to post</span>
        {#if f?.newCommits}<span class="font-semibold text-blue-300">{f.newCommits} new</span>{/if}
      </span>
      <span class="mt-0.5 h-[3px] overflow-hidden rounded bg-zinc-800" aria-hidden="true">
        <span class="block h-full bg-blue-500 transition-[width]" style="width: {Math.round((f?.read ?? 0) * 100)}%"></span>
      </span>
    </button>
  {/each}
</nav>
