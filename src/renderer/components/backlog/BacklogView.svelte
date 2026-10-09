<script lang="ts">
  import { onMount, tick } from 'svelte'
  import BacklogItemDetail from './BacklogItemDetail.svelte'
  import { backlogStore } from '../../stores/backlog.svelte'
  import { sessionsStore } from '../../stores/sessions.svelte'
  import { uiView } from '../../stores/uiView.svelte'
  import { loadAllowlistedModels, refreshAllowlistedModelsOnFocus, targetLabel, type AllowlistedModel } from '../../lib/agentModels'
  import { labelFromBrief } from '../../../shared/brief'
  import { newBacklogItemId, type BacklogItem } from '../../../shared/backlog'

  let models = $state<AllowlistedModel[]>([])
  /** A new item's id while it is being written and not added yet. */
  let newId = $state<string | null>(null)
  /** The detail holds edits main doesn't have. */
  let unsaved = $state(false)
  let detail = $state<ReturnType<typeof BacklogItemDetail> | undefined>()
  let confirmingDelete = $state<string | null>(null)
  let dragId = $state<string | null>(null)
  let dropBefore = $state<string | null>(null)
  /** Errors that no snapshot carries (e.g. "already being started"), per item. */
  let startErrors = $state<Record<string, string>>({})

  const items = $derived(backlogStore.items)
  const selectedId = $derived(backlogStore.selectedId)
  const orphanDrafts = $derived(Object.entries(backlogStore.drafts).filter(([id]) => !backlogStore.get(id)))
  const projectName = $derived(backlogStore.project?.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/, '') ?? '')

  // Settings → Models has no change event: reread it when the picker or the
  // window gets focus. The old list stays up meanwhile.
  function takeModels(load: Promise<AllowlistedModel[]> | null): void {
    load?.then((list) => (models = list)).catch((err: unknown) => console.warn('[backlog] loading the models failed:', err))
  }
  const refreshModels = (): void => takeModels(loadAllowlistedModels())
  const onWindowFocus = (): void => takeModels(refreshAllowlistedModelsOnFocus())

  onMount(() => {
    refreshModels()
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  })

  // The first item is shown unless another is picked. An item that left the
  // backlog stays on screen while it holds unsaved text, so it can be saved as new.
  $effect(() => {
    const id = selectedId
    if (id && (id === newId || backlogStore.get(id) || unsaved || backlogStore.draft(id))) return
    backlogStore.select(items[0]?.id ?? null)
  })

  function title(item: BacklogItem): string {
    return item.label || labelFromBrief(item.prompt) || item.prompt.split('\n')[0] || 'Untitled'
  }

  function origin(item: BacklogItem): string {
    if (item.createdBy === 'agent') return `added by ${item.createdBySession ?? 'an agent'}`
    return item.createdBy === 'phone' ? 'added on the phone' : ''
  }

  /** Show another item (or a new one), once the current one is saved. */
  async function choose(id: string | 'new'): Promise<void> {
    if (id === selectedId || (id === 'new' && newId && selectedId === newId)) return
    const previous = newId
    // Set first: the selection lands before this resumes, and must not read as an unknown id.
    newId = id === 'new' ? newBacklogItemId() : null
    if (!(await backlogStore.requestSelect(newId ?? id))) newId = previous
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
      newId = null
      if (!(await backlogStore.requestSelect(item.id))) return
      await tick()
    }
    const shown = item.id === backlogStore.selectedId
    if (shown && detail && !(await detail.flush())) return
    const index = items.findIndex((i) => i.id === item.id)
    const next = items[index + 1]?.id ?? items[index - 1]?.id ?? null
    const { [item.id]: _, ...rest } = startErrors
    startErrors = rest
    try {
      const { terminalId } = await backlogStore.start(item.id)
      if (shown) await backlogStore.requestSelect(next)
      sessionsStore.select(terminalId)
      uiView.show('workspace')
    } catch (err) {
      // A failure main recorded comes back on the item; anything else shows here.
      if (!backlogStore.get(item.id)?.lastStart) {
        startErrors = { ...startErrors, [item.id]: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  async function remove(id: string): Promise<void> {
    confirmingDelete = null
    if (id === selectedId) detail?.discard()
    await backlogStore.remove(id).catch((err: unknown) => {
      startErrors = { ...startErrors, [id]: `Not removed: ${err instanceof Error ? err.message : String(err)}` }
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

<div class="flex h-full flex-col bg-zinc-950">
  <header class="flex flex-none items-center gap-3 border-b border-zinc-800 px-5 py-3">
    <div class="min-w-0 flex-1">
      <h1 class="text-[15px] font-semibold text-zinc-100">Backlog</h1>
      <p class="truncate text-xs text-zinc-500">
        Prepared sessions for {projectName || 'this project'}. Agents add here when you say “add this to our backlog”.
      </p>
    </div>
    <button class="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500" onclick={() => void choose('new')}>+ New</button>
  </header>

  <div class="flex min-h-0 flex-1">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="w-[340px] flex-none overflow-y-auto border-r border-zinc-800 px-3 py-3" ondragover={(e) => onDragOver(e, null)} ondrop={onDrop} data-testid="backlog-list">
      {#if items.length === 0 && !newId && orphanDrafts.length === 0}
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
            {@const error = startErrors[item.id]}
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
                <button class="min-w-0 flex-1 text-left" onclick={() => void choose(item.id)}>
                  <div class="truncate text-[13px] text-zinc-100">{title(item)}</div>
                  <div class="mt-0.5 truncate text-[11px] text-zinc-500">
                    {[targetLabel(item.target, models), origin(item), backlogStore.draft(item.id) ? 'unsaved edits' : ''].filter(Boolean).join(' · ')}
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
                      class="rounded bg-blue-600 px-2 py-0.5 text-[11px] text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-blue-600"
                      disabled={!promptOf(item).trim()}
                      title={promptOf(item).trim() ? undefined : 'Write a prompt before starting this item.'}
                      onclick={() => start(item)}>Start</button
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
              <button class="w-full min-w-0 text-left" onclick={() => void choose(id)}>
                <div class="truncate text-[13px] text-zinc-100">{draft.label.trim() || labelFromBrief(draft.prompt) || 'Untitled'}</div>
                <div class="mt-0.5 truncate text-[11px] text-amber-300">
                  {draft.created ? 'Unsaved draft — its item was started or removed' : 'Unsaved new item'}
                </div>
              </button>
            </li>
          {/each}
          {#if selectedId && selectedId === newId && !backlogStore.get(selectedId) && !backlogStore.draft(selectedId)}
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

    <div class="min-w-0 flex-1">
      {#if selectedId}
        <!-- Keyed: the detail takes a copy of its item when it opens. -->
        {#key selectedId}
          <BacklogItemDetail
            bind:this={detail}
            bind:unsaved
            id={selectedId}
            item={backlogStore.get(selectedId)}
            {models}
            focus={selectedId === newId}
            onmodelsfocus={refreshModels}
            oncreated={() => (newId = null)}
            onreplaced={(id) => {
              newId = null
              // The detail has just discarded its text, so nothing is held.
              backlogStore.select(id)
            }}
          />
        {/key}
      {:else}
        <div class="flex h-full items-center justify-center text-xs text-zinc-600">Pick an item, or add one with + New.</div>
      {/if}
    </div>
  </div>
</div>
