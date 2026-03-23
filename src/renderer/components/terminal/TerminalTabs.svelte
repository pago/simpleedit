<script lang="ts">
  import Terminal from './Terminal.svelte'

  interface Props {
    worktreePath: string
  }

  let { worktreePath }: Props = $props()

  interface TabInfo {
    id: string
    label: string
    isClaude: boolean
  }

  let tabs: TabInfo[] = $state([])
  let activeTabId: string | undefined = $state(undefined)
  let nextIndex = $state(1)
  let nextClaudeIndex = $state(1)

  function createTab(): void {
    const id = `term-${Date.now()}-${nextIndex}`
    const label = `Terminal ${nextIndex}`
    nextIndex++
    tabs.push({ id, label, isClaude: false })
    activeTabId = id

    window.api.invoke('pty:spawn', { id, worktreePath })
  }

  function createClaudeTab(): void {
    const id = `claude-${Date.now()}-${nextClaudeIndex}`
    const label = nextClaudeIndex === 1 ? 'Claude' : `Claude ${nextClaudeIndex}`
    nextClaudeIndex++
    tabs.unshift({ id, label, isClaude: true })
    activeTabId = id

    window.api.invoke('claude:spawn', { id, worktreePath })
  }

  function closeTab(id: string): void {
    const tab = tabs.find((t) => t.id === id)
    if (tab?.isClaude) {
      window.api.invoke('claude:detach', id)
    }
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

  /**
   * Send a message to the first Claude terminal (if any).
   * If no Claude terminal exists, creates one first.
   */
  export function sendToClaude(message: string): void {
    let claudeTab = tabs.find((t) => t.isClaude)
    if (!claudeTab) {
      createClaudeTab()
      claudeTab = tabs.find((t) => t.isClaude)
    }
    if (claudeTab) {
      activeTabId = claudeTab.id
      // Small delay to ensure the terminal is ready if just created
      setTimeout(() => {
        window.api.invoke('pty:write', claudeTab!.id, message + '\n')
      }, claudeTab ? 100 : 1000)
    }
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
    <button
      class="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-orange-400/60 hover:bg-zinc-800 hover:text-orange-300"
      onclick={createClaudeTab}
      title="Run Claude Code"
    >
      <span>&#x2726;</span>
    </button>

    {#each tabs as tab (tab.id)}
      <button
        class="group flex items-center gap-1 px-3 py-1 text-xs transition-colors {tab.id === activeTabId
          ? tab.isClaude ? 'bg-zinc-900 text-orange-300' : 'bg-zinc-900 text-zinc-200'
          : tab.isClaude ? 'text-orange-400/60 hover:text-orange-300' : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => selectTab(tab.id)}
      >
        {#if tab.isClaude}
          <span class="text-[10px]">&#x2726;</span>
        {/if}
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

  <!-- All terminals rendered, only active one visible -->
  <div class="relative min-h-0 flex-1">
    {#each tabs as tab (tab.id)}
      <div
        class="absolute inset-0"
        class:hidden={tab.id !== activeTabId}
      >
        <Terminal terminalId={tab.id} active={tab.id === activeTabId} />
      </div>
    {/each}
    {#if tabs.length === 0}
      <div class="flex h-full items-center justify-center">
        <p class="text-xs text-zinc-500">No terminal open</p>
      </div>
    {/if}
  </div>
</div>
