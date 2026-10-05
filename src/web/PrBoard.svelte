<script lang="ts" module>
  // Plain, not reactive: it only grows from inside the derived below, which
  // re-runs on the entries it reads.
  const seenOwners = new Set<string>()
</script>

<script lang="ts">
  /**
   * The board: every PR waiting on you, in the order the buckets put them.
   *
   * Buckets ORDER; they do not gate. Every PR here opens the same way and is
   * fully reviewable — an `attention` PR simply carries more to read than a
   * `quick` one. Ordering and stacking are the shared pure rules
   * (`bucketOf`/`compareInBucket`/`groupStacks`), so the phone and the desk
   * cannot disagree about what is urgent.
   *
   * A top-level screen: no segmented control. The screen control is a row
   * inside the list rather than a second header action.
   */
  import { screenPrsStore } from '../renderer/stores/screenprs.svelte'
  import { BUCKET_ORDER, groupStacks } from '../shared/screenprs'
  import type { ScreenPrBucket, ScreenPrCard, PrRef } from '../shared/screenprs'
  import PrCard from './PrCard.svelte'
  import { CUTOFF_DAYS, isCutoffDays, type ScreenPrsFilterPrefs } from '../shared/screenprs-filter'

  interface Props {
    onopen: (pr: PrRef) => void
  }

  let { onopen }: Props = $props()

  const BUCKETS: Record<ScreenPrBucket, { label: string; sub: string; head: string }> = {
    attention: { label: 'Needs your attention', sub: 'critical or high-impact', head: 'text-red-400' },
    quick: { label: 'Quick pass', sub: 'small, green, uncontroversial', head: 'text-amber-400' },
    waiting: { label: 'Waiting on author', sub: 'CI red — reviewable, not urgent', head: 'text-blue-300' },
    fyi: { label: 'Already approved — FYI', sub: 'covered by others', head: 'text-zinc-400' },
  }

  // The filter is the one saved in main and shared with the desk: setting the
  // org here sets it there, and the other way round.
  let saved = $derived(screenPrsStore.filter())
  let owner = $state(screenPrsStore.filter().owner)
  /** Typed in since it last matched the saved org; only then does leaving it save. */
  let ownerEdited = $state(false)
  let filterError = $state<string | null>(null)
  $effect(() => {
    const next = saved.owner
    if (!ownerEdited) owner = next
  })
  /**
   * Every org any screen on this page has shown, offered so the org is a pick
   * rather than typed. Accumulated, because a screen scoped to one org shows
   * only that one, and the picker exists to switch away from it.
   */
  let knownOwners = $derived.by(() => {
    for (const e of screenPrsStore.entries()) if (e.ref.owner) seenOwners.add(e.ref.owner)
    if (saved.owner) seenOwners.add(saved.owner)
    return [...seenOwners].sort((a, b) => a.localeCompare(b))
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

  let status = $derived(screenPrsStore.status())
  let byBucket = $derived(screenPrsStore.byBucket())
  let pending = $derived(screenPrsStore.pending())
  let error = $derived(screenPrsStore.error())
  let done = $derived(BUCKET_ORDER.reduce((n, b) => n + byBucket[b].length, 0))

  async function screen(): Promise<void> {
    commitOwner()
    await screenPrsStore.start()
  }

  function open(card: ScreenPrCard): void {
    onopen(card)
  }
</script>

<div class="flex h-full flex-col overflow-y-auto px-3 py-3" data-testid="pr-board">
  <div class="mb-4 flex items-center gap-2">
    <button
      type="button"
      onclick={() => void screen()}
      disabled={status === 'running'}
      data-testid="screen-prs"
      class="min-h-10 flex-1 rounded-lg bg-blue-600 px-3 text-sm font-semibold text-white active:bg-blue-500
             disabled:bg-zinc-800 disabled:text-zinc-500"
    >{status === 'running' ? 'Screening…' : status === 'idle' ? 'Screen PRs' : 'Re-screen'}</button>
    {#if status === 'running'}
      <button
        type="button"
        onclick={() => void screenPrsStore.cancel()}
        data-testid="cancel-screen"
        class="min-h-10 flex-none rounded-lg border border-zinc-700 px-3 text-sm text-zinc-300"
      >Stop</button>
    {:else}
      <select
        value={String(saved.cutoffDays)}
        onchange={(e) => setCutoff(e.currentTarget.value)}
        aria-label="Look back"
        data-testid="filter-cutoff"
        class="min-h-10 flex-none rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-base text-zinc-300"
      >
        {#each CUTOFF_DAYS as d (d)}<option value={String(d)}>{d}d</option>{/each}
      </select>
    {/if}
  </div>

  <label class="mb-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3">
    <span class="flex-none text-[11px] uppercase tracking-wider text-zinc-500">Org</span>
    <!-- 16px: iOS zooms the page on focusing anything smaller. -->
    <input
      bind:value={owner}
      oninput={() => (ownerEdited = true)}
      onblur={commitOwner}
      onkeydown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      list="pr-board-owners"
      placeholder="all orgs"
      autocapitalize="none"
      autocomplete="off"
      spellcheck="false"
      enterkeyhint="done"
      aria-label="Org"
      data-testid="filter-owner"
      class="min-h-10 min-w-0 flex-1 bg-transparent text-base text-zinc-200 outline-none placeholder:text-zinc-600"
    />
    {#if owner}
      <button
        type="button"
        onclick={() => {
          owner = ''
          ownerEdited = false
          void saveFilter({ ...saved, owner: '' })
        }}
        aria-label="All orgs"
        data-testid="filter-owner-clear"
        class="min-h-9 flex-none px-1 text-zinc-500"
      >✕</button>
    {/if}
    <datalist id="pr-board-owners">
      {#each knownOwners as o (o)}<option value={o}></option>{/each}
    </datalist>
  </label>
  {#if filterError}
    <p class="-mt-2 mb-3 px-1 text-xs text-red-300" data-testid="filter-error">{filterError}</p>
  {/if}

  {#if error}
    <p class="mb-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
  {/if}

  {#if pending.length > 0}
    <section class="mb-5" data-testid="pending-section">
      <h2 class="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
        Screening… <span class="tabular-nums">({pending.length})</span>
      </h2>
      <ul class="space-y-1.5">
        {#each pending as entry (entry.ref.url)}
          <li class="flex items-center gap-2 rounded-lg border border-zinc-800/70 bg-zinc-900/60 px-3 py-2.5">
            <span class="h-3 w-3 flex-none animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] text-zinc-300">{entry.ref.title}</span>
              <span class="block truncate font-mono text-[10px] text-zinc-600">{entry.ref.repo}#{entry.ref.number}</span>
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#each BUCKET_ORDER as bucket (bucket)}
    {@const cards = byBucket[bucket]}
    {#if cards.length > 0}
      <section class="mb-5" data-testid="bucket" data-bucket={bucket}>
        <h2 class="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-wider {BUCKETS[bucket].head}">
          {BUCKETS[bucket].label} <span class="tabular-nums text-zinc-600">({cards.length})</span>
        </h2>
        <p class="mb-1.5 px-1 text-[11px] text-zinc-600">{BUCKETS[bucket].sub}</p>
        <ul class="space-y-1.5">
          {#each groupStacks(cards) as group (group.cards[0].url)}
            {#each group.cards as card, i (card.url)}
              <li><PrCard {card} depth={group.stackId ? i : 0} onopen={open} /></li>
            {/each}
          {/each}
        </ul>
      </section>
    {/if}
  {/each}

  {#if status !== 'running' && done === 0 && pending.length === 0}
    <p class="px-1 py-6 text-sm leading-relaxed text-zinc-500">
      {status === 'idle'
        ? 'Nothing screened yet. Tap Screen PRs to pull everything waiting on your review.'
        : 'No pull requests are waiting on your review.'}
    </p>
  {/if}
</div>
