<script lang="ts">
  import type { PaletteItem, PaletteCategory } from '../../lib/command-palette/types'
  import { CATEGORY_LABELS } from '../../lib/command-palette/types'
  import ResultItem from './ResultItem.svelte'

  interface Props {
    groups: { category: PaletteCategory; items: PaletteItem[] }[]
    flat: PaletteItem[]
    selectedIndex: number
    onselect: (item: PaletteItem) => void
    onselectedindexchange: (index: number) => void
  }

  let { groups, flat, selectedIndex, onselect, onselectedindexchange }: Props = $props()

  let listEl = $state<HTMLDivElement | null>(null)

  $effect(() => {
    // Scroll selected item into view
    if (!listEl) return
    const selected = listEl.querySelector('[aria-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
  })
</script>

<div
  bind:this={listEl}
  class="overflow-y-auto"
  style="max-height: 340px"
  role="listbox"
>
  {#if flat.length === 0}
    <div class="px-3 py-6 text-center text-sm text-zinc-500">
      No results found
    </div>
  {:else}
    {#each groups as group}
      {#if group.items.length > 0}
        <div class="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {CATEGORY_LABELS[group.category]}
        </div>
        {#each group.items as item}
          <ResultItem
            {item}
            selected={flat[selectedIndex]?.id === item.id}
            onclick={() => onselect(item)}
          />
        {/each}
      {/if}
    {/each}
  {/if}
</div>
