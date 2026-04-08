<script lang="ts">
  import { onMount } from 'svelte'
  import CommandInput from './CommandInput.svelte'
  import CategoryChips from './CategoryChips.svelte'
  import ResultList from './ResultList.svelte'
  import { closePalette } from '../../stores/commandPalette.svelte'
  import {
    activeWorktree,
    secondPaneWorktree,
    focusedPane
  } from '../../stores/worktrees.svelte'
  import { search, executeItem, type GroupedResults } from '../../lib/command-palette/palette-engine'
  import { parseQuery, type PalettePrefix } from '../../lib/command-palette/types'

  let query = $state('')
  let selectedIndex = $state(0)
  let results = $state<GroupedResults>({ groups: [], flat: [] })
  let inputComponent = $state<CommandInput | null>(null)

  let currentPrefix = $derived<PalettePrefix>(parseQuery(query).prefix)

  let context = $derived({
    focusedPane: focusedPane(),
    activeWorktree: activeWorktree(),
    secondaryWorktree: secondPaneWorktree()
  })

  // Debounced search
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  function handleInput(value: string): void {
    query = value
    selectedIndex = 0

    clearTimeout(searchTimer)
    searchTimer = setTimeout(async () => {
      results = await search(query, context)
    }, 16)
  }

  function handleChipSelect(prefix: string): void {
    query = prefix
    selectedIndex = 0
    inputComponent?.focus()

    clearTimeout(searchTimer)
    searchTimer = setTimeout(async () => {
      results = await search(query, context)
    }, 16)
  }

  function handleSelect(item: (typeof results.flat)[number]): void {
    closePalette()
    executeItem(item, context)
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (results.flat.length > 0) {
        selectedIndex = (selectedIndex + 1) % results.flat.length
      }
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.flat.length > 0) {
        selectedIndex = (selectedIndex - 1 + results.flat.length) % results.flat.length
      }
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      const item = results.flat[selectedIndex]
      if (item) handleSelect(item)
      return
    }
  }

  // Initial search on mount
  onMount(async () => {
    results = await search(query, context)
  })
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
<div
  class="fixed inset-0 z-50 flex justify-center bg-black/50"
  role="dialog"
  aria-modal="true"
  aria-label="Command palette"
  tabindex="-1"
  onclick={(e) => {
    if (e.target === e.currentTarget) closePalette()
  }}
  onkeydown={handleKeydown}
>
  <div class="mt-[15vh] h-fit w-[560px] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
    <CommandInput
      bind:this={inputComponent}
      value={query}
      oninput={handleInput}
    />
    <CategoryChips
      activePrefix={currentPrefix}
      onselect={handleChipSelect}
    />
    <ResultList
      groups={results.groups}
      flat={results.flat}
      {selectedIndex}
      onselect={handleSelect}
      onselectedindexchange={(i) => (selectedIndex = i)}
    />
  </div>
</div>
