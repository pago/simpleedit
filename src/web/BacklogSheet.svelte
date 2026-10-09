<script lang="ts">
  /**
   * Add or edit a backlog item from the phone: the prompt, by voice or typing,
   * and an optional model.
   *
   * The text is the user's until main has it. Save goes through the composer,
   * which keeps the text whenever the save throws; a conflict throws too, after
   * offering Keep mine / Take theirs (or Save as new, for an item that is
   * gone). Leaving with unsaved text asks first, from every way out.
   */
  import { onMount, tick, untrack } from 'svelte'
  import VoiceComposer from './VoiceComposer.svelte'
  import DiscardConfirm from './DiscardConfirm.svelte'
  import { backlogStore } from '../renderer/stores/backlog.svelte'
  import { loadAllowlistedModels, refreshAllowlistedModelsOnFocus, targetKey, targetLabel, type AllowlistedModel } from '../renderer/lib/agentModels'
  import { draftAtRisk } from './lib/nav'
  import { SESSION_BRIEF_MAX } from '../shared/brief'
  import { newBacklogItemId, type BacklogItem } from '../shared/backlog'
  import type { InteractiveTarget } from '../shared/ipc-types'

  interface Props {
    /** The item to edit; null for a new one. */
    itemId: string | null
    connected: boolean
    onclose: () => void
  }

  let { itemId, connected, onclose }: Props = $props()

  const opened: BacklogItem | undefined = untrack(() => (itemId ? backlogStore.get(itemId) : undefined))

  let editingId = $state(opened?.id ?? null)
  let baseVersion = $state(opened?.version ?? 0)
  let newId = newBacklogItemId()
  let initial = $state(opened?.prompt ?? '')
  /** `targetKey` of the model as opened: a changed model is unsaved too. */
  let initialModel = $state(targetKey(opened?.target))
  let text = $state(opened?.prompt ?? '')
  let target = $state<InteractiveTarget | null>(opened?.target ?? null)
  let models = $state<AllowlistedModel[]>([])
  let conflict = $state<{ current: BacklogItem | null } | null>(null)
  let confirmingDiscard = $state(false)
  let confirmingDelete = $state(false)
  let composer = $state<VoiceComposer | undefined>()

  const modelKey = $derived(targetKey(target))
  const tooLong = $derived(text.length > SESSION_BRIEF_MAX)

  // Settings → Models on the Mac has no change event: reread it when the
  // picker gets focus or the app comes back. The old list stays up meanwhile.
  function takeModels(load: Promise<AllowlistedModel[]> | null): void {
    load?.then((list) => (models = list)).catch(() => {})
  }
  const refreshModels = (): void => takeModels(loadAllowlistedModels())
  const onWindowFocus = (): void => takeModels(refreshAllowlistedModelsOnFocus())

  onMount(() => {
    void tick().then(() => composer?.focusField())
    refreshModels()
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  })

  function pickModel(key: string): void {
    target = key ? (JSON.parse(key) as InteractiveTarget) : null
  }

  async function save(body: string): Promise<void> {
    if (!connected) throw new Error('Not connected to the Mac. The text is safe here — save once the dot goes green.')
    if (body.length > SESSION_BRIEF_MAX) throw new Error(`That prompt is ${body.length} characters; the limit is ${SESSION_BRIEF_MAX}.`)
    conflict = null
    if (!editingId) {
      await backlogStore.add({ id: newId, prompt: body, ...(target ? { target: $state.snapshot(target) } : {}) })
      onclose()
      return
    }
    const result = await backlogStore.update(editingId, baseVersion, { prompt: body, target: target ? $state.snapshot(target) : null })
    if (result.ok) {
      onclose()
      return
    }
    conflict = { current: result.conflict.current }
    // Thrown so the composer keeps the text while the user decides.
    throw new Error(result.conflict.current ? 'Changed somewhere else since you opened it.' : 'It was started or removed meanwhile.')
  }

  function takeTheirs(): void {
    const current = conflict?.current
    if (!current) return
    conflict = null
    baseVersion = current.version
    initial = current.prompt
    initialModel = targetKey(current.target)
    text = current.prompt
    target = current.target ?? null
  }

  function keepMine(): void {
    const current = conflict?.current
    if (!current) return
    conflict = null
    baseVersion = current.version
  }

  function saveAsNew(): void {
    conflict = null
    editingId = null
    newId = newBacklogItemId()
  }

  async function remove(): Promise<void> {
    confirmingDelete = false
    if (!editingId) return
    await backlogStore.remove(editingId).catch(() => {})
    onclose()
  }

  /** Back and every other way out ask first when there is unsaved text. */
  export function holdForDraft(): boolean {
    if (!atRisk()) return false
    confirmingDiscard = true
    return true
  }

  export function atRisk(): boolean {
    return draftAtRisk(text, composer?.dictating() ?? false, initial) || modelKey !== initialModel
  }

  function requestClose(): void {
    if (!holdForDraft()) onclose()
  }
</script>

<div
  inert={confirmingDiscard || confirmingDelete}
  role="dialog"
  aria-modal="true"
  aria-label={editingId ? 'Edit backlog item' : 'New backlog item'}
  tabindex="-1"
  class="fixed inset-0 z-40 flex flex-col justify-end"
  data-testid="backlog-sheet"
>
  <button type="button" aria-label="Dismiss" onclick={requestClose} class="flex-1 bg-black/60"></button>

  <div class="flex-none rounded-t-2xl border-t border-zinc-800 bg-zinc-950 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
    <div class="mb-2 flex items-center gap-2">
      <h2 class="min-w-0 flex-1 text-[15px] font-semibold text-zinc-100">{editingId ? 'Backlog item' : 'Add to backlog'}</h2>
      {#if editingId}
        <button type="button" onclick={() => (confirmingDelete = true)} class="min-h-9 px-2 text-sm text-red-400" data-testid="backlog-delete">Delete</button>
      {/if}
      <button type="button" onclick={requestClose} class="-mr-1 min-h-9 px-2 text-sm text-zinc-400">Cancel</button>
    </div>

    {#if opened?.createdBy === 'agent'}
      <p class="mb-2 text-[11px] text-zinc-500">Prepared by {opened.createdBySession ?? 'an agent'}. It is sent as written when you start it.</p>
    {/if}

    {#if conflict}
      <div class="mb-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-[11px] text-amber-300" data-testid="backlog-conflict">
        {#if conflict.current}
          {#if conflict.current.starting}
            It is being started right now.
          {:else}
            Changed somewhere else since you opened it.
            <div class="mt-1.5 flex gap-2">
              <button type="button" onclick={keepMine} class="min-h-9 flex-1 rounded-lg bg-amber-700 font-semibold text-white">Keep mine</button>
              <button type="button" onclick={takeTheirs} class="min-h-9 flex-1 rounded-lg border border-amber-800">Take theirs</button>
            </div>
          {/if}
        {:else}
          It was started or removed meanwhile.
          <button type="button" onclick={saveAsNew} class="mt-1.5 min-h-9 w-full rounded-lg bg-amber-700 font-semibold text-white">Save as a new item</button>
        {/if}
      </div>
    {/if}

    <label class="mb-2 flex items-center gap-2 text-[12px] text-zinc-400">
      Model
      <select
        value={modelKey}
        onchange={(e) => pickModel(e.currentTarget.value)}
        onfocus={refreshModels}
        class="min-h-9 min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-[13px] text-zinc-200"
        data-testid="backlog-model"
      >
        <option value="">Default</option>
        {#if target && !models.some((m) => targetKey(m.target) === modelKey)}<option value={modelKey}>{targetLabel(target, models)}</option>{/if}
        {#each models as m (m.key)}<option value={targetKey(m.target)}>{m.label}</option>{/each}
      </select>
    </label>

    <VoiceComposer bind:this={composer} bind:text onsend={save} sendLabel="Save" placeholder="What should the session do?" />
    {#if tooLong}
      <p class="mt-1 text-[11px] text-red-300">{text.length.toLocaleString()} / {SESSION_BRIEF_MAX.toLocaleString()} characters</p>
    {/if}
  </div>
</div>

{#if confirmingDiscard}
  <DiscardConfirm
    title="Discard your changes?"
    body="They aren't saved anywhere yet."
    testid="backlog-discard"
    onkeep={() => (confirmingDiscard = false)}
    ondiscard={() => {
      confirmingDiscard = false
      composer?.discardRecording()
      onclose()
    }}
  />
{/if}
{#if confirmingDelete}
  <DiscardConfirm
    title="Delete this item?"
    body="It leaves the backlog on every device."
    testid="backlog-delete-confirm"
    onkeep={() => (confirmingDelete = false)}
    ondiscard={() => void remove()}
  />
{/if}
