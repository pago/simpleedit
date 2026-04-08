<script lang="ts">
  import type { PaletteItem } from '../../lib/command-palette/types'

  interface Props {
    item: PaletteItem
    selected: boolean
    onclick: () => void
  }

  let { item, selected, onclick }: Props = $props()

  function highlightLabel(label: string, indices?: number[]): { char: string; highlighted: boolean }[] {
    if (!indices || indices.length === 0) {
      return label.split('').map((char) => ({ char, highlighted: false }))
    }
    const indexSet = new Set(indices)
    return label.split('').map((char, i) => ({
      char,
      highlighted: indexSet.has(i)
    }))
  }

  let segments = $derived(highlightLabel(item.label, item.matchIndices))

  const categoryIcons: Record<string, string> = {
    file: '\u{1F4C4}',
    worktree: '\u{1F333}',
    action: '\u{26A1}',
    commit: '\u{1F4DD}'
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm {selected
    ? 'bg-blue-600/20 text-zinc-100'
    : 'text-zinc-300 hover:bg-zinc-800'}"
  role="option"
  tabindex="-1"
  aria-selected={selected}
  {onclick}
>
  <span class="flex-none text-xs opacity-60">{categoryIcons[item.category] ?? ''}</span>
  <span class="min-w-0 truncate">
    {#each segments as seg}{#if seg.highlighted}<span class="font-semibold text-blue-400">{seg.char}</span>{:else}{seg.char}{/if}{/each}
  </span>
  {#if item.description}
    <span class="ml-auto flex-none truncate text-xs text-zinc-500">{item.description}</span>
  {/if}
</div>
