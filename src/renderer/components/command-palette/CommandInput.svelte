<script lang="ts">
  import type { PalettePrefix } from '../../lib/command-palette/types'
  import { PREFIX_CATEGORY_MAP, CATEGORY_LABELS } from '../../lib/command-palette/types'

  interface Props {
    value: string
    oninput: (value: string) => void
  }

  let { value, oninput }: Props = $props()

  let inputEl = $state<HTMLInputElement | null>(null)

  let activePrefix = $derived.by<PalettePrefix>(() => {
    const trimmed = value.trimStart()
    if (trimmed.startsWith('>')) return '>'
    if (trimmed.startsWith('@')) return '@'
    if (trimmed.startsWith('#')) return '#'
    return null
  })

  let prefixLabel = $derived.by(() => {
    if (!activePrefix) return null
    const category = PREFIX_CATEGORY_MAP[activePrefix]
    return CATEGORY_LABELS[category]
  })

  let placeholder = $derived.by(() => {
    if (activePrefix === '>') return 'Search actions...'
    if (activePrefix === '@') return 'Search worktrees...'
    if (activePrefix === '#') return 'Search commits...'
    return 'Search files, actions, worktrees...'
  })

  export function focus(): void {
    inputEl?.focus()
  }
</script>

<div class="relative flex items-center border-b border-zinc-700 px-3">
  {#if prefixLabel}
    <span class="mr-2 flex-none rounded bg-blue-600/30 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
      {prefixLabel}
    </span>
  {/if}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    bind:this={inputEl}
    type="text"
    class="w-full bg-transparent py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
    placeholder={placeholder}
    {value}
    oninput={(e) => oninput(e.currentTarget.value)}
    autofocus
  />
</div>
