<script lang="ts">
  import Terminal from './Terminal.svelte'

  interface Props {
    worktreePath: string
  }

  let { worktreePath }: Props = $props()

  interface TabInfo {
    id: string
    label: string
  }

  let tabs: TabInfo[] = $state([])
  let activeTabId: string | undefined = $state(undefined)
  let nextIndex = $state(1)

  function createTab(): void {
    const id = `term-${Date.now()}-${nextIndex}`
    const label = `Terminal ${nextIndex}`
    nextIndex++
    tabs.push({ id, label })
    activeTabId = id

    window.api.invoke('pty:spawn', { id, worktreePath })
  }

  function closeTab(id: string): void {
    window.api.invoke('pty:kill', id)
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx === -1) return

    tabs.splice(idx, 1)

    if (activeTabId === id) {
      if (tabs.length > 0) {
        activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id
      } else {
        activeTabId = undefined
      }
    }
  }

  function selectTab(id: string): void {
    activeTabId = id
  }

  // Create an initial terminal tab on mount
  $effect(() => {
    if (tabs.length === 0) {
      createTab()
    }
  })
</script>

<div class="flex h-full flex-col">
  <!-- Tab bar -->
  <div class="flex items-center border-b border-zinc-800 bg-zinc-950 px-1">
    {#each tabs as tab (tab.id)}
      <button
        class="group flex items-center gap-1 px-3 py-1 text-xs transition-colors {tab.id === activeTabId
          ? 'bg-zinc-900 text-zinc-200'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => selectTab(tab.id)}
      >
        <span>{tab.label}</span>
        <span
          class="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-zinc-600 hover:bg-zinc-700 hover:text-zinc-300"
          role="button"
          tabindex="0"
          onclick={(e: MouseEvent) => { e.stopPropagation(); closeTab(tab.id) }}
          onkeydown={(e: KeyboardEvent) => {
            e.stopPropagation()
            if (e.key === 'Enter' || e.key === ' ') closeTab(tab.id)
          }}
        >
          x
        </span>
      </button>
    {/each}

    <button
      class="ml-1 flex h-5 w-5 items-center justify-center rounded text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      onclick={createTab}
      title="New terminal"
    >
      +
    </button>
  </div>

  <!-- Active terminal -->
  <div class="min-h-0 flex-1">
    {#if activeTabId}
      {#key activeTabId}
        <Terminal terminalId={activeTabId} />
      {/key}
    {:else}
      <div class="flex h-full items-center justify-center">
        <p class="text-xs text-zinc-500">No terminal open</p>
      </div>
    {/if}
  </div>
</div>
