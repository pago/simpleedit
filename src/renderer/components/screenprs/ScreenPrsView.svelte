<script lang="ts">
  import { onMount } from 'svelte'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { triageModel } from '../../stores/triageModel.svelte'
  import PrDetail from './PrDetail.svelte'
  import ScreenPrsButton from './ScreenPrsButton.svelte'
  import { sidebarRail } from '../../stores/sidebarRail.svelte'
  import { CUTOFF_DAYS, isCutoffDays, type ScreenPrsFilterPrefs } from '../../../shared/screenprs-filter'

  let selectedKey = $derived(screenPrsStore.selectedKey())
  let selectedCard = $derived(screenPrsStore.selectedCard())
  let selectedContext = $derived(screenPrsStore.selectedContext())

  // The org field is a draft of the saved filter: it follows the saved value
  // (another window or the phone may change it) except while it is being typed in.
  let saved = $derived(screenPrsStore.filter())
  let owner = $state(screenPrsStore.filter().owner)
  /** Typed in since it last matched the saved org; only then does leaving it save. */
  let ownerEdited = $state(false)
  let filterError = $state<string | null>(null)
  $effect(() => {
    const next = saved.owner
    if (!ownerEdited) owner = next
  })

  async function saveFilter(next: ScreenPrsFilterPrefs): Promise<void> {
    filterError = null
    try {
      await screenPrsStore.setFilter(next)
    } catch (e) {
      filterError = e instanceof Error ? e.message : String(e)
      owner = screenPrsStore.filter().owner
    }
  }
  function commitOwner(): void {
    if (!ownerEdited) return
    ownerEdited = false
    if (owner.trim() !== saved.owner) void saveFilter({ ...saved, owner: owner.trim() })
  }
  function setCutoff(value: string): void {
    const days = Number(value)
    if (isCutoffDays(days)) void saveFilter({ ...saved, cutoffDays: days })
  }

  onMount(() => void triageModel.refresh())
</script>

<div class="flex h-full flex-col bg-zinc-950">
  <!-- Header + filters -->
  <div class="flex-none border-b border-zinc-800 px-5 py-3">
    <div class="flex items-center gap-3">
      <h1 class="text-[15px] font-semibold text-zinc-100">
        Screen PRs <span class="ml-1.5 text-[13px] font-normal text-zinc-500">review-requested · @me</span>
      </h1>
      <div class="flex-1"></div>
      {#if sidebarRail.collapsed()}
        <ScreenPrsButton />
      {/if}
    </div>
    <div class="mt-2.5 flex items-center gap-2 text-[11px]">
      <label class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1">
        <span class="uppercase tracking-wider text-zinc-500">Org</span>
        <input
          class="w-24 bg-transparent text-zinc-200 outline-none placeholder:text-zinc-600"
          placeholder="all mine"
          aria-label="Org"
          data-testid="filter-owner"
          bind:value={owner}
          oninput={() => (ownerEdited = true)}
          onblur={commitOwner}
          onkeydown={(e) => {
            if (e.key === 'Enter') commitOwner()
          }}
        />
      </label>
      <label class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1">
        <span class="uppercase tracking-wider text-zinc-500">Active since</span>
        <select
          class="bg-transparent text-zinc-200 outline-none"
          aria-label="Active since"
          data-testid="filter-cutoff"
          value={String(saved.cutoffDays)}
          onchange={(e) => setCutoff(e.currentTarget.value)}
        >
          {#each CUTOFF_DAYS as d (d)}<option value={String(d)}>{d} days</option>{/each}
        </select>
      </label>
      {#if filterError}<span class="text-[10.5px] text-red-400" data-testid="filter-error">{filterError}</span>{/if}
      <span class="ml-auto text-[10.5px] text-zinc-600">triage · <span class="text-zinc-500">{triageModel.label}</span></span>
    </div>
  </div>

  <div class="min-h-0 flex-1">
    {#if selectedKey && selectedContext}
      <PrDetail context={selectedContext} card={selectedCard} />
    {:else if !selectedKey}
      <div class="flex h-full items-center justify-center text-xs text-zinc-600">Pick a PR from the queue to review it.</div>
    {/if}
  </div>
</div>
