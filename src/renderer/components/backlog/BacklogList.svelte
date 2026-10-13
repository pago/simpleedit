<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { backlogStore } from '../../stores/backlog.svelte'
  import { backlogView } from '../../stores/backlogViewState.svelte'
  import { sessionsStore } from '../../stores/sessions.svelte'
  import { uiView } from '../../stores/uiView.svelte'
  import { targetLabel } from '../../lib/agentModels'
  import { labelFromBrief } from '../../../shared/brief'
  import type { BacklogItem } from '../../../shared/backlog'

  interface Props {
    class?: string
  }

  let { class: className = '' }: Props = $props()

  let confirmingDelete = $state<string | null>(null)
  let dragId = $state<string | null>(null)
  let dropBefore = $state<string | null>(null)

  const items = $derived(backlogStore.items)
  const selectedId = $derived(backlogStore.selectedId)
  const orphanDrafts = $derived(Object.entries(backlogStore.drafts).filter(([id]) => !backlogStore.get(id)))

  onMount(() => backlogView.watchModels())

  // The first item is shown unless another is picked. An item that left the
  // backlog stays on screen while it holds unsaved text, so it can be saved as new.
  $effect(() => {
    const id = selectedId
    if (id && (id === backlogView.newId || backlogStore.get(id) || backlogView.unsaved || backlogStore.draft(id))) return
    backlogStore.select(items[0]?.id ?? null)
  })

  function title(item: BacklogItem): string {
    return item.label || labelFromBrief(item.prompt) || item.prompt.split('\n')[0] || 'Untitled'
  }

  function origin(item: BacklogItem): string {
    if (item.createdBy === 'agent') return `added by ${item.createdBySession ?? 'an agent'}`
    return item.createdBy === 'phone' ? 'added on the phone' : ''
  }

  /** The prompt Start would run once saved: unsaved text counts. */
  function promptOf(item: BacklogItem): string {
    return backlogStore.draft(item.id)?.prompt ?? item.prompt
  }

  async function start(item: BacklogItem): Promise<void> {
    // The session starts from main's copy, so it must have the latest text.
    // Unsaved text of another row is opened and saved first; if it can't be
    // saved, that item stays open showing why, and nothing starts.
    if (item.id !== selectedId && backlogStore.draft(item.id)) {
      backlogView.newId = null
      if (!(await backlogStore.requestSelect(item.id))) return
      await tick()
    }
    const shown = item.id === backlogStore.selectedId
    if (shown && !(await backlogView.flushEditor())) return
    const index = items.findIndex((i) => i.id === item.id)
    const next = items[index + 1]?.id ?? items[index - 1]?.id ?? null
    backlogView.setStartError(item.id, null)
    try {
      const { terminalId } = await backlogStore.start(item.id)
      if (shown) await backlogStore.requestSelect(next)
      sessionsStore.select(terminalId)
      uiView.show('workspace')
    } catch (err) {
      // A failure main recorded comes back on the item; anything else shows here.
      if (!backlogStore.get(item.id)?.lastStart) backlogView.setStartError(item.id, err instanceof Error ? err.message : String(err))
    }
  }

  async function remove(id: string): Promise<void> {
    confirmingDelete = null
    if (id === selectedId) backlogView.discardEditor()
    await backlogStore.remove(id).catch((err: unknown) => {
      backlogView.setStartError(id, `Not removed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  function onDragStart(e: DragEvent, id: string): void {
    dragId = id
    e.dataTransfer?.setData('text/x-backlog-item', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(e: DragEvent, id: string | null): void {
    if (!dragId) return
    e.preventDefault()
    dropBefore = id
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    const moving = dragId
    const before = dropBefore
    dragId = null
    dropBefore = null
    if (!moving || moving === before) return
    const ids = items.map((i) => i.id).filter((id) => id !== moving)
    const at = before ? ids.indexOf(before) : ids.length
    ids.splice(at < 0 ? ids.length : at, 0, moving)
    void backlogStore.reorder(ids).catch((err: unknown) => console.warn('[backlog] reorder failed:', err))
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="@container overflow-y-auto px-3 py-3 {className}" ondragover={(e) => onDragOver(e, null)} ondrop={onDrop} data-testid="backlog-list">
  {#if items.length === 0 && !backlogView.newId && orphanDrafts.length === 0}
    <p class="mt-16 px-4 text-center text-sm text-zinc-500">
      Nothing queued. Add a prompt you want to run later, or ask an agent to add one.
    </p>
  {:else}
    <!-- The gaps between rows keep the row last pointed at, not the end slot. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <ol
      class="flex flex-col gap-1"
      ondragover={(e) => {
        if (!dragId) return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {#each items as item (item.id)}
        {@const error = backlogView.startError(item.id)}
        {@const active = item.id === selectedId}
        <li
          class="group rounded-md border px-2 py-1.5 transition-colors
            {active ? 'border-zinc-700 bg-zinc-800' : 'border-transparent hover:bg-zinc-900'}
            {dropBefore === item.id && dragId && dragId !== item.id ? '!border-blue-500' : ''}
            {dragId === item.id ? 'opacity-50' : ''}"
          draggable={!item.starting}
          ondragstart={(e) => onDragStart(e, item.id)}
          ondragover={(e) => {
            e.stopPropagation()
            onDragOver(e, item.id)
          }}
          ondragend={() => {
            dragId = null
            dropBefore = null
          }}
          data-testid="backlog-item"
          aria-current={active ? 'true' : undefined}
        >
          <div class="flex items-start gap-2">
            <span class="mt-0.5 cursor-grab select-none text-zinc-600" aria-hidden="true">⋮⋮</span>
            <button class="min-w-0 flex-1 text-left" onclick={() => void backlogView.choose(item.id)}>
              <div class="truncate text-[13px] text-zinc-100">{title(item)}</div>
              <div class="mt-0.5 hidden truncate text-[11px] text-zinc-500 @2xs:block">
                {[targetLabel(item.target, backlogView.models), origin(item), backlogStore.draft(item.id) ? 'unsaved edits' : ''].filter(Boolean).join(' · ')}
              </div>
            </button>
            <div class="flex flex-none items-center gap-1">
              {#if item.starting}
                <span class="text-[11px] text-zinc-400">Starting…</span>
              {:else if confirmingDelete === item.id}
                <button class="rounded bg-red-700 px-2 py-0.5 text-[11px] text-white hover:bg-red-600" onclick={() => remove(item.id)}>Delete</button>
                <button class="rounded px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-700" onclick={() => (confirmingDelete = null)}>Keep</button>
              {:else}
                <button
                  class="rounded bg-blue-600 px-1.5 py-0.5 text-[11px] text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-blue-600 @3xs:px-2"
                  disabled={!promptOf(item).trim()}
                  title={promptOf(item).trim() ? undefined : 'Write a prompt before starting this item.'}
                  aria-label="Start"
                  onclick={() => start(item)}
                  ><span class="hidden @3xs:inline">Start</span><span class="@3xs:hidden" aria-hidden="true">▶</span></button
                >
                <button
                  class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
                  onclick={() => (confirmingDelete = item.id)}
                  aria-label="Delete {title(item)}">✕</button
                >
              {/if}
            </div>
          </div>
          {#if item.lastStart?.outcome === 'unconfirmed'}
            <p class="mt-1 pl-5 text-[11px] text-amber-300">May have started — check the sidebar before starting it again. {item.lastStart.reason}</p>
          {:else if item.lastStart}
            <p class="mt-1 pl-5 text-[11px] text-red-400">Didn't start: {item.lastStart.reason}</p>
          {/if}
          {#if error}<p class="mt-1 pl-5 text-[11px] text-red-400">{error}</p>{/if}
        </li>
      {/each}
      <!-- Unsaved text whose item is gone (or was never added) has no row of its own. -->
      {#each orphanDrafts as [id, draft] (id)}
        {@const active = id === selectedId}
        <li
          class="rounded-md border px-2 py-1.5 pl-7 {active ? 'border-zinc-700 bg-zinc-800' : 'border-amber-800/60 hover:bg-zinc-900'}"
          data-testid="backlog-draft"
          aria-current={active ? 'true' : undefined}
        >
          <button class="w-full min-w-0 text-left" onclick={() => void backlogView.choose(id)}>
            <div class="truncate text-[13px] text-zinc-100">{draft.label.trim() || labelFromBrief(draft.prompt) || 'Untitled'}</div>
            <div class="mt-0.5 truncate text-[11px] text-amber-300">
              {draft.created ? 'Unsaved draft — its item was started or removed' : 'Unsaved new item'}
            </div>
          </button>
        </li>
      {/each}
      {#if selectedId && selectedId === backlogView.newId && !backlogStore.get(selectedId) && !backlogStore.draft(selectedId)}
        <li class="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 pl-7 text-[13px] italic text-zinc-400" aria-current="true">New item</li>
      {/if}
    </ol>
    <!-- Drop here to move an item to the end. -->
    <div
      class="mt-1 h-8 rounded-md border border-dashed {dragId && dropBefore === null ? 'border-blue-500' : 'border-transparent'}"
      aria-hidden="true"
      data-testid="backlog-drop-end"
    ></div>
  {/if}
</div>
