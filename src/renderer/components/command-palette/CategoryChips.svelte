<script lang="ts">
  import type { PaletteCategory, PalettePrefix } from '../../lib/command-palette/types'
  import { CATEGORY_PREFIXES } from '../../lib/command-palette/types'

  interface Props {
    activePrefix: PalettePrefix
    onselect: (prefix: string) => void
  }

  let { activePrefix, onselect }: Props = $props()

  const chips: { label: string; key: PaletteCategory | 'all'; prefix: string }[] = [
    { label: 'All', key: 'all', prefix: '' },
    { label: 'Files', key: 'file', prefix: '' },
    { label: 'Worktrees', key: 'worktree', prefix: '@' },
    { label: 'Actions', key: 'action', prefix: '>' },
    { label: 'Commits', key: 'commit', prefix: '#' }
  ]

  function isActive(chip: { prefix: string }): boolean {
    if (activePrefix === null && chip.prefix === '') return true
    return activePrefix === chip.prefix
  }
</script>

<div class="flex gap-1 border-b border-zinc-700/50 px-3 py-1.5">
  {#each chips as chip}
    <button
      class="rounded px-2 py-0.5 text-[10px] font-medium transition-colors
        {isActive(chip)
          ? 'bg-blue-600/30 text-blue-300'
          : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}"
      onclick={() => onselect(chip.prefix)}
    >
      {chip.label}
    </button>
  {/each}
</div>
