<script lang="ts" module>
  export interface ContextMenuItem {
    id: string
    label: string
    tone?: 'default' | 'danger'
    separatorBefore?: boolean
    disabled?: boolean
    disabledTooltip?: string
  }
</script>

<script lang="ts">
  import { tick, untrack } from 'svelte'

  interface Props {
    x: number
    y: number
    items: ContextMenuItem[]
    onpick: (id: string) => void
    onclose: () => void
  }

  let { x, y, items, onpick, onclose }: Props = $props()

  let menuEl: HTMLDivElement | undefined = $state()
  let itemEls: (HTMLButtonElement | null)[] = $state([])
  // Initial focus index is computed once at mount from the props as observed
  // at construction — untracked so the linter doesn't flag the read.
  let focusedIndex: number = $state(untrack(() => firstEnabledIndex(items)))

  let posX = $state(untrack(() => x))
  let posY = $state(untrack(() => y))

  // Keep posX/posY in sync if the caller repositions the menu mid-life.
  $effect(() => {
    posX = x
    posY = y
  })

  // Reposition so the menu stays inside the viewport.
  $effect(() => {
    if (!menuEl) return
    const rect = menuEl.getBoundingClientRect()
    const margin = 4
    if (rect.right > window.innerWidth - margin) {
      posX = Math.max(margin, window.innerWidth - rect.width - margin)
    }
    if (rect.bottom > window.innerHeight - margin) {
      posY = Math.max(margin, window.innerHeight - rect.height - margin)
    }
  })

  // Focus the initially-active item once it's in the DOM.
  $effect(() => {
    void items
    tick().then(() => {
      itemEls[focusedIndex]?.focus()
    })
  })

  $effect(() => {
    function onPointerDown(e: PointerEvent): void {
      if (menuEl && !menuEl.contains(e.target as Node)) onclose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  })

  function firstEnabledIndex(list: ContextMenuItem[]): number {
    return list.findIndex((it) => !it.disabled)
  }

  function nextEnabledIndex(from: number, direction: 1 | -1): number {
    const n = items.length
    if (n === 0) return -1
    let i = from
    for (let step = 0; step < n; step++) {
      i = (i + direction + n) % n
      if (!items[i].disabled) return i
    }
    return from
  }

  function pick(item: ContextMenuItem): void {
    if (item.disabled) return
    onpick(item.id)
    onclose()
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onclose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusedIndex = nextEnabledIndex(focusedIndex, 1)
      itemEls[focusedIndex]?.focus()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusedIndex = nextEnabledIndex(focusedIndex, -1)
      itemEls[focusedIndex]?.focus()
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      const first = firstEnabledIndex(items)
      if (first >= 0) {
        focusedIndex = first
        itemEls[focusedIndex]?.focus()
      }
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      for (let i = items.length - 1; i >= 0; i--) {
        if (!items[i].disabled) {
          focusedIndex = i
          itemEls[focusedIndex]?.focus()
          break
        }
      }
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const item = items[focusedIndex]
      if (item) pick(item)
    }
  }
</script>

<div
  bind:this={menuEl}
  role="menu"
  tabindex="-1"
  class="fixed z-50 min-w-[180px] rounded border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-xl outline-none"
  style:left="{posX}px"
  style:top="{posY}px"
  onkeydown={handleKeydown}
>
  {#each items as item, i (item.id)}
    {#if item.separatorBefore}
      <hr class="my-1 border-zinc-700" />
    {/if}
    <button
      bind:this={itemEls[i]}
      role="menuitem"
      type="button"
      class="block w-full px-3 py-1 text-left outline-none {item.disabled
        ? 'cursor-not-allowed text-zinc-500'
        : item.tone === 'danger'
          ? 'text-red-400 hover:bg-red-950/30 focus:bg-red-950/30'
          : 'hover:bg-zinc-800 focus:bg-zinc-800'}"
      disabled={item.disabled}
      title={item.disabled ? item.disabledTooltip ?? '' : ''}
      aria-disabled={item.disabled ? 'true' : undefined}
      onclick={() => pick(item)}
      onmouseenter={() => {
        if (!item.disabled) focusedIndex = i
      }}
    >
      {item.label}
    </button>
  {/each}
</div>
