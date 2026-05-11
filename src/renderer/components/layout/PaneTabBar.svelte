<script lang="ts">
  import type { Tab } from '../../stores/tabsStore.svelte'
  import TabIcon from './TabIcon.svelte'

  interface Props {
    tabs: Tab[]
    activeId: string | null
    peekId: string | null
    unread: ReadonlySet<string>
    onselect: (tabId: string) => void
    onclose: (tabId: string) => void
    onpin?: (tabId: string) => void
    onreorder?: (fromIndex: number, toIndex: number) => void
  }

  let {
    tabs,
    activeId,
    peekId,
    unread,
    onselect,
    onclose,
    onpin,
    onreorder,
  }: Props = $props()

  let dragIndex: number | null = $state(null)
  let dropIndex: number | null = $state(null)

  function labelFor(tab: Tab): string {
    switch (tab.kind) {
      case 'file': {
        const parts = tab.path.split('/')
        return parts[parts.length - 1] ?? tab.path
      }
      case 'diff':
        if (tab.commitHash === null) return 'Uncommitted changes'
        if (tab.commitHash === 'branch') return 'Branch tour'
        return tab.commitMessage.split('\n')[0] || tab.commitHash.slice(0, 7)
      case 'tour':
        if (tab.commitHash === null) return 'Tour: Uncommitted changes'
        if (tab.commitHash === 'branch') return 'Branch tour'
        return `Tour: ${tab.commitMessage.split('\n')[0] || tab.commitHash.slice(0, 7)}`
      case 'plan':
        return tab.label
      case 'composed':
        return tab.title
    }
  }

  function titleFor(tab: Tab): string {
    if (tab.kind === 'file') return tab.path
    return labelFor(tab)
  }

  function handleClose(e: MouseEvent, tabId: string): void {
    e.stopPropagation()
    onclose(tabId)
  }

  function handleAuxClick(e: MouseEvent, tabId: string): void {
    // Middle-click closes the tab (matches VS Code / browsers).
    if (e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    onclose(tabId)
  }

  function handleMouseDown(e: MouseEvent): void {
    // Suppress the platform auto-scroll cursor that some browsers show on a
    // middle-button mousedown. Left-button drags must still work, so only
    // intercept button 1.
    if (e.button === 1) e.preventDefault()
  }

  function handleDblClick(tabId: string): void {
    if (peekId === tabId) onpin?.(tabId)
  }

  function handleDragStart(e: DragEvent, index: number): void {
    dragIndex = index
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOver(e: DragEvent, index: number): void {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropIndex = index
  }

  function handleDrop(e: DragEvent, index: number): void {
    e.preventDefault()
    if (dragIndex !== null && dragIndex !== index) {
      onreorder?.(dragIndex, index)
    }
    dragIndex = null
    dropIndex = null
  }

  function handleDragEnd(): void {
    dragIndex = null
    dropIndex = null
  }
</script>

{#if tabs.length > 0}
  <div
    data-testid="worktree-tab-bar"
    class="flex h-9 items-center overflow-x-auto border-b border-zinc-800 bg-zinc-900"
  >
    {#each tabs as tab, i (tab.id)}
      {@const isActive = activeId === tab.id}
      {@const isPeek = peekId === tab.id}
      {@const isUnread = unread.has(tab.id)}
      {@const isModified = tab.kind === 'file' && tab.modified}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        role="tab"
        tabindex="0"
        aria-selected={isActive}
        data-testid="worktree-tab"
        data-kind={tab.kind}
        data-peek={String(isPeek)}
        data-active={String(isActive)}
        data-unread={String(isUnread)}
        class="group flex h-full cursor-pointer items-center gap-1.5 border-r border-zinc-800 px-3 text-xs transition-colors
          {isActive
            ? 'bg-zinc-950 text-zinc-200'
            : 'bg-zinc-900 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}
          {isUnread && !isActive ? 'font-semibold text-zinc-200' : ''}
          {dragIndex !== null && dropIndex === i && dragIndex !== i ? 'border-l-2 border-l-blue-500' : ''}"
        onclick={() => onselect(tab.id)}
        ondblclick={() => handleDblClick(tab.id)}
        onauxclick={(e) => handleAuxClick(e, tab.id)}
        onmousedown={handleMouseDown}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onselect(tab.id)
          }
        }}
        title={titleFor(tab)}
        draggable="true"
        ondragstart={(e) => handleDragStart(e, i)}
        ondragover={(e) => handleDragOver(e, i)}
        ondrop={(e) => handleDrop(e, i)}
        ondragend={handleDragEnd}
      >
        {#if isUnread && !isActive}
          <span class="h-1.5 w-1.5 flex-none rounded-full bg-blue-400" title="Unread"></span>
        {:else if isModified}
          <span class="h-2 w-2 flex-none rounded-full bg-amber-400" title="Unsaved changes"></span>
        {/if}
        <TabIcon kind={tab.kind} class="h-3.5 w-3.5 flex-none text-zinc-500" />
        <span class="truncate max-w-40" class:italic={isPeek}>{labelFor(tab)}</span>
        <button
          type="button"
          data-testid="worktree-tab-close"
          aria-label="Close tab"
          class="ml-1 flex-none rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-300 group-hover:opacity-100
            {isActive ? 'opacity-100' : ''}"
          onclick={(e) => handleClose(e, tab.id)}
        >
          &times;
        </button>
      </div>
    {/each}
  </div>
{/if}
