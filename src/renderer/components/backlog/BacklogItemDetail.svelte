<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import PromptField from './PromptField.svelte'
  import { backlogStore } from '../../stores/backlog.svelte'
  import { targetKey, targetLabel, type AllowlistedModel } from '../../lib/agentModels'
  import { SESSION_BRIEF_MAX, cleanSessionLabel, labelFromBrief } from '../../../shared/brief'
  import { newBacklogItemId, type BacklogItem, type BacklogItemPatch } from '../../../shared/backlog'
  import type { InteractiveTarget } from '../../../shared/ipc-types'

  /** How long typing pauses before it is saved. */
  const SAVE_DELAY_MS = 600

  interface Props {
    /** The item's id; for a new item, the one it will be added under. */
    id: string
    /** Main's copy. Absent for a new item not added yet, or one that has left the backlog. */
    item: BacklogItem | undefined
    /** The Settings → Models allowlist, in order. */
    models: readonly AllowlistedModel[]
    /** Edits main doesn't have yet. The view keeps a gone item on screen while this holds. */
    unsaved?: boolean
    /** Put the cursor in the prompt: the user just asked for a new item. */
    focus?: boolean
    /** The model picker got focus: a chance to pick up a changed allowlist. */
    onmodelsfocus?: () => void
    /** A new item was added. */
    oncreated: (id: string) => void
    /** The text was saved as a different item (Save as new). */
    onreplaced: (id: string) => void
  }

  let { id, item, models, unsaved = $bindable(false), focus = false, onmodelsfocus, oncreated, onreplaced }: Props = $props()

  interface Fields {
    prompt: string
    /** As main stores it (`cleanSessionLabel`). */
    label: string
    /** `targetKey` of the model. */
    target: string
  }

  function fieldsOf(from: BacklogItem | undefined | null): Fields {
    return { prompt: from?.prompt ?? '', label: from?.label ?? '', target: targetKey(from?.target) }
  }

  function sameFields(a: Fields, b: Fields): boolean {
    return a.prompt === b.prompt && a.label === b.label && a.target === b.target
  }

  const opened = untrack(() => item)
  // Unsaved text from an earlier editor of this item, or from before a reload.
  const restored = untrack(() => backlogStore.draft(id))
  /** Main has this item: it existed when opened, or our add landed. */
  let created = $state(restored?.created ?? !!opened)
  /** The version our edits build on; a save against an older one is refused. */
  let baseVersion = $state(restored?.baseVersion ?? opened?.version ?? 0)
  /** What main has, as far as this editor knows. */
  let saved = $state<Fields>(restored?.saved ?? fieldsOf(opened))
  let prompt = $state(restored?.prompt ?? opened?.prompt ?? '')
  let label = $state(restored?.label ?? opened?.label ?? '')
  let target = $state(restored?.target ?? targetKey(opened?.target))
  /**
   * Text of a new item that was never added, brought back from a draft. It
   * isn't added just because it was opened again: only once the user types,
   * or picks Add it.
   */
  let held = $state(!!restored && !restored.created && !opened)
  /** Bumped to remount the prompt editor with replaced text. */
  let promptKey = $state(0)

  let saving = $state(false)
  let savedOnce = $state(false)
  let error = $state<string | null>(null)
  /**
   * Main refused a save: the item changed elsewhere (`current`), is being
   * started (`current.starting`, resolved when it settles), or is gone (`null`).
   */
  let conflict = $state<{ current: BacklogItem | null } | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  const current = $derived<Fields>({ prompt, label: cleanSessionLabel(label), target })
  const dirty = $derived(!sameFields(current, saved))
  const gone = $derived(created && !item)
  const empty = $derived(!prompt.trim() && !current.label)
  const tooLong = $derived(prompt.length > SESSION_BRIEF_MAX)
  const placeholder = $derived(labelFromBrief(prompt) || 'Session name, from the prompt when blank')
  const startingElsewhere = $derived(!!conflict?.current?.starting)

  $effect(() => {
    unsaved = dirty || conflict !== null
  })

  // The store's draft is the one copy of unsaved text, so it follows every keystroke.
  $effect(() => {
    void [prompt, label, target, saved, baseVersion, created]
    untrack(keepDraft)
  })

  function keepDraft(): void {
    if (dirty) backlogStore.putDraft(id, { prompt, label, target, saved: $state.snapshot(saved), baseVersion, created })
    else backlogStore.dropDraft(id)
  }

  // Someone else (the phone, an agent) changed the item. Adopt it only while
  // nothing here is unsaved; otherwise the next save meets it as a conflict.
  $effect(() => {
    const next = item
    if (!next || next.version <= baseVersion || dirty || saving || conflict) return
    adopt(next)
  })

  // A save refused because the item was being started waits for the start to
  // settle: gone means it became a session (Save as new / Discard); back means
  // the start failed, and the save goes ahead unless someone else edited it.
  $effect(() => {
    const waitingOn = conflict?.current
    if (!waitingOn?.starting) return
    const now = item
    untrack(() => {
      if (!now) conflict = { current: null }
      else if (now.starting) return
      else if (now.version === waitingOn.version) {
        conflict = null
        settle(now)
        void save()
      } else conflict = { current: now }
    })
  })

  function adopt(from: BacklogItem): void {
    const fields = fieldsOf(from)
    if (fields.prompt !== prompt) promptKey++
    settle(from)
    prompt = fields.prompt
    label = fields.label
    target = fields.target
  }

  /** Main has `from`: what is saved is what it says, not what we sent. */
  function settle(from: BacklogItem): void {
    baseVersion = from.version
    saved = fieldsOf(from)
    created = true
    // Directly, not via the effect: this may be an editor that has already closed.
    backlogStore.settleDraft(id, saved, from.version)
  }

  /** Catch up with a save another editor of this item landed (the store's draft knows). */
  function catchUp(): void {
    const draft = backlogStore.draft(id)
    if (draft && draft.baseVersion > baseVersion) {
      baseVersion = draft.baseVersion
      saved = draft.saved
      created ||= draft.created
    }
  }

  function edited(): void {
    held = false
    error = null
    clearTimeout(timer)
    if (!conflict) timer = setTimeout(() => void save(), SAVE_DELAY_MS)
  }

  function targetOf(key: string): InteractiveTarget | null {
    return key ? (JSON.parse(key) as InteractiveTarget) : null
  }

  /**
   * Save what is unsaved now. True when main has everything; false when it
   * couldn't take it (the reason is on screen).
   */
  function save(): Promise<boolean> {
    clearTimeout(timer)
    timer = undefined
    return backlogStore.queueSave(id, saveNow)
  }

  async function saveNow(): Promise<boolean> {
    if (held) return true
    catchUp()
    if (conflict) return false
    // Main already has exactly this, e.g. from a save made before a reload.
    if (item && sameFields(fieldsOf(item), current)) {
      settle(item)
      return true
    }
    if (!dirty) return true
    if (gone) {
      conflict = { current: null }
      return false
    }
    if (empty) {
      // A new item becomes one only once it has a title or a prompt.
      if (!created) return true
      error = 'A backlog item needs a title or a prompt.'
      return false
    }
    if (tooLong) {
      error = `That prompt is ${prompt.length.toLocaleString()} characters; the limit is ${SESSION_BRIEF_MAX.toLocaleString()}.`
      return false
    }
    return send({ ...current })
  }

  async function send(next: Fields): Promise<boolean> {
    saving = true
    error = null
    try {
      if (!created) {
        const picked = targetOf(next.target)
        // The id was minted up front, so a retry after a lost answer can't add it twice.
        const { result } = await backlogStore.add({
          id,
          prompt: next.prompt,
          ...(next.label ? { label: next.label } : {}),
          ...(picked ? { target: picked } : {}),
        })
        created = true
        const mine = result.snapshot.items.find((i) => i.id === id)
        if (!mine) {
          // Tombstoned: an earlier try landed and the item was started or removed since.
          conflict = { current: null }
          return false
        }
        settle(mine)
        savedOnce = true
        oncreated(id)
        // A retry whose first try had landed is dropped, and main kept that
        // try's text; what was typed in between still needs saving.
        if (sameFields(saved, next)) return true
      }
      // Only what changed, so a field edited elsewhere meanwhile isn't rewritten.
      const patch: BacklogItemPatch = {}
      if (next.prompt !== saved.prompt) patch.prompt = next.prompt
      if (next.label !== saved.label) patch.label = next.label || null
      if (next.target !== saved.target) patch.target = targetOf(next.target)
      if (!Object.keys(patch).length) return true
      const result = await backlogStore.update(id, baseVersion, patch)
      if (!result.ok) {
        conflict = { current: result.conflict.current }
        return false
      }
      const mine = result.snapshot.items.find((i) => i.id === id)
      if (mine) settle(mine)
      savedOnce = true
      return true
    } catch (err) {
      // Main never got it (or refused it): the text stays here for another try.
      error = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      saving = false
    }
  }

  function keepMine(): void {
    const theirs = conflict?.current
    if (!theirs) return
    conflict = null
    settle(theirs)
    void save()
  }

  function takeTheirs(): void {
    const theirs = conflict?.current
    if (!theirs) return
    conflict = null
    adopt(theirs)
  }

  async function saveAsNew(): Promise<void> {
    const fresh = newBacklogItemId()
    const picked = targetOf(target)
    error = null
    try {
      await backlogStore.add({ id: fresh, prompt, ...(current.label ? { label: current.label } : {}), ...(picked ? { target: picked } : {}) })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      return
    }
    discard()
    backlogStore.dropDraft(id)
    onreplaced(fresh)
  }

  /** Save now: before the view switches item or starts this one. */
  export function flush(): Promise<boolean> {
    return save()
  }

  /** Drop what is unsaved, e.g. because the item is being deleted. */
  export function discard(): void {
    clearTimeout(timer)
    held = false
    conflict = null
    error = null
    if (prompt !== saved.prompt) promptKey++
    prompt = saved.prompt
    label = saved.label
    target = saved.target
  }

  // A reload or a closed window gives no time for the debounce: send now (the
  // IPC message leaves synchronously when no save is ahead of it). The draft
  // is stored either way, so nothing typed depends on that send.
  function onUnload(): void {
    keepDraft()
    if (dirty && !conflict) void save()
  }

  let unguard: (() => void) | undefined
  onMount(() => {
    unguard = backlogStore.guardSelection(save)
    window.addEventListener('beforeunload', onUnload)
    if (restored && dirty && !held) edited()
  })

  // Leaving the view still saves; the draft keeps the text if that fails.
  onDestroy(() => {
    unguard?.()
    window.removeEventListener('beforeunload', onUnload)
    keepDraft()
    if (dirty && !conflict) void save()
  })

  const status = $derived(
    held
      ? ''
      : item?.starting
      ? 'Starting…'
      : !created && empty
        ? ''
        : saving || (dirty && !error && !conflict)
        ? 'Saving…'
        : savedOnce && !error && !conflict
          ? 'Saved'
          : '',
  )
</script>

<div class="flex h-full min-w-0 flex-col" data-testid="backlog-detail">
  <div class="flex flex-none items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
    <input
      bind:value={label}
      oninput={edited}
      maxlength="120"
      {placeholder}
      aria-label="Session name"
      class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-sm font-medium text-zinc-100 outline-none placeholder:text-zinc-500 hover:border-zinc-800 focus:border-zinc-700"
    />
    <select
      bind:value={target}
      onchange={edited}
      onfocus={() => onmodelsfocus?.()}
      aria-label="Model"
      class="max-w-[220px] rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
    >
      <option value="">Default</option>
      {#if target && !models.some((m) => targetKey(m.target) === target)}
        <option value={target}>{targetLabel(targetOf(target), models)}</option>
      {/if}
      {#each models as m (m.key)}<option value={targetKey(m.target)}>{m.label}</option>{/each}
    </select>
    <span class="w-16 flex-none text-right text-[11px] text-zinc-500" role="status">{status}</span>
  </div>

  {#if item?.createdBy === 'agent'}
    <p class="flex-none px-4 pt-2 text-xs text-zinc-500">Prepared by {item.createdBySession ? `“${item.createdBySession}”` : 'an agent'}. Read it before you start it.</p>
  {/if}

  {#if held}
    <div class="mx-4 mt-2 flex-none rounded border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200" role="alert">
      This new item was never added to the backlog.
      <div class="mt-2 flex gap-2">
        <button
          class="rounded bg-amber-700 px-2 py-0.5 text-white hover:bg-amber-600"
          onclick={() => {
            held = false
            void save()
          }}>Add it</button
        >
        <button class="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900" onclick={discard}>Discard</button>
      </div>
    </div>
  {/if}

  {#if conflict || gone}
    <div class="mx-4 mt-2 flex-none rounded border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200" role="alert">
      {#if startingElsewhere}
        This item is being started right now. Your text stays here until that settles.
      {:else if conflict?.current}
        This item changed somewhere else while you were editing it.
        <div class="mt-2 flex gap-2">
          <button class="rounded bg-amber-700 px-2 py-0.5 text-white hover:bg-amber-600" onclick={keepMine}>Keep mine</button>
          <button class="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900" onclick={takeTheirs}>Take theirs</button>
        </div>
      {:else}
        This item was started or removed while you were editing it.
        <div class="mt-2 flex gap-2">
          <button class="rounded bg-amber-700 px-2 py-0.5 text-white hover:bg-amber-600" onclick={() => void saveAsNew()}>Save as new item</button>
          <button class="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900" onclick={discard}>Discard</button>
        </div>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="mx-4 mt-2 flex flex-none items-center gap-2 text-xs text-red-400" role="alert">
      Not saved: {error}
      <button class="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800" onclick={() => void save()}>Retry</button>
    </p>
  {/if}

  <div class="flex flex-none items-baseline justify-between px-4 pt-2 pb-1 text-[11px] text-zinc-500">
    <span>The new session's opening message, sent as written. Drop files to insert their paths. ⌘↵ saves now.</span>
    <span class="tabular-nums {tooLong ? 'text-red-400' : 'text-zinc-600'}">{prompt.length.toLocaleString()} / {SESSION_BRIEF_MAX.toLocaleString()}</span>
  </div>
  <div class="mx-4 mb-4 min-h-0 flex-1 overflow-hidden rounded border border-zinc-800 bg-zinc-950">
    {#key promptKey}
      <PromptField
        value={prompt}
        onchange={(v) => {
          prompt = v
          edited()
        }}
        onsubmit={() => void save()}
        label="Backlog prompt"
        autofocus={focus && promptKey === 0}
      />
    {/key}
  </div>
</div>
