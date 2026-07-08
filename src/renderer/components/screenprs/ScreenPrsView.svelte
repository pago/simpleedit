<script lang="ts">
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import type { ScreenPrCard, ScreenPrBucket, PrCiStatus } from '../../../shared/screenprs'
  import { BUCKET_ORDER } from '../../../shared/screenprs'
  import PrDetail from './PrDetail.svelte'

  let status = $derived(screenPrsStore.status())
  let byBucket = $derived(screenPrsStore.byBucket())
  let pending = $derived(screenPrsStore.pending())
  let total = $derived(screenPrsStore.total())
  let selectedKey = $derived(screenPrsStore.selectedKey())
  let selectedCard = $derived(screenPrsStore.selectedCard())
  let selectedContext = $derived(screenPrsStore.selectedContext())
  let filters = $derived(screenPrsStore.filters())

  let done = $derived([...Object.values(byBucket)].reduce((n, arr) => n + arr.length, 0))

  const BUCKETS: Record<ScreenPrBucket, { label: string; sub: string; stripe: string; head: string }> = {
    attention: { label: 'Needs your attention', sub: 'critical or high-impact', stripe: 'bg-red-500', head: 'text-red-400' },
    quick: { label: 'Quick pass', sub: 'small, green, uncontroversial', stripe: 'bg-amber-500', head: 'text-amber-400' },
    waiting: { label: 'Waiting on author', sub: 'CI red — don’t review yet', stripe: 'bg-blue-500', head: 'text-blue-300' },
    fyi: { label: 'Already approved — FYI', sub: 'covered by others', stripe: 'bg-zinc-600', head: 'text-zinc-400' },
  }

  let owner = $state(filters.owner ?? '')
  let cutoff = $state('30')

  function isoCutoff(days: string): string {
    // Deterministic-enough client cutoff; the main process re-derives if needed.
    const d = new Date()
    d.setDate(d.getDate() - Number(days))
    return d.toISOString().slice(0, 10)
  }

  function screen(): void {
    void screenPrsStore.start({ owner: owner.trim() || undefined, updatedSince: isoCutoff(cutoff) })
  }

  const ciClass: Record<PrCiStatus, string> = {
    green: 'text-emerald-400',
    pending: 'text-amber-400',
    failing: 'text-red-400',
  }
  function ciLabel(c: ScreenPrCard): string {
    if (c.ci === 'green') return 'CI green'
    if (c.ci === 'pending') return 'CI pending'
    return c.ciFailing.length ? `CI: ${c.ciFailing.join(', ')}` : 'CI failing'
  }
</script>

<div class="flex h-full flex-col bg-zinc-950">
  <!-- Header + filters -->
  <div class="flex-none border-b border-zinc-800 px-5 py-3">
    <div class="flex items-center gap-3">
      <h1 class="text-[15px] font-semibold text-zinc-100">
        Screen PRs <span class="ml-1.5 text-[13px] font-normal text-zinc-500">review-requested · @me</span>
      </h1>
      <div class="flex-1"></div>
      {#if status === 'running'}
        <span class="text-[11px] text-zinc-500">screening {done}{total ? `/${total}` : ''}…</span>
        <button class="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800" onclick={() => screenPrsStore.cancel()}>Stop</button>
      {:else}
        <button class="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700" onclick={screen}>
          {done > 0 ? '↻ Re-screen' : '🔎 Screen'}
        </button>
      {/if}
    </div>
    <div class="mt-2.5 flex items-center gap-2 text-[11px]">
      <label class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1">
        <span class="uppercase tracking-wider text-zinc-500">Org</span>
        <input class="w-24 bg-transparent text-zinc-200 outline-none placeholder:text-zinc-600" placeholder="all mine" bind:value={owner} />
      </label>
      <label class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1">
        <span class="uppercase tracking-wider text-zinc-500">Active since</span>
        <select class="bg-transparent text-zinc-200 outline-none" bind:value={cutoff}>
          <option value="30">30 days</option>
          <option value="7">7 days</option>
          <option value="90">90 days</option>
        </select>
      </label>
      <span class="text-[10px] italic text-zinc-600">triage model configured in Settings</span>
    </div>
  </div>

  <!-- Split: queue | detail -->
  <div class="flex min-h-0 flex-1">
    <div class="w-[380px] flex-none overflow-y-auto border-r border-zinc-800 px-3 py-4" class:flex-1={!selectedKey}>
      {#if done === 0 && pending.length === 0}
        <div class="flex flex-col items-center gap-2 py-16 text-zinc-600">
          {#if status === 'error'}
            <div class="text-sm text-red-400">Screening failed</div>
            <div class="max-w-xs text-center text-[11px]">{screenPrsStore.error()}</div>
          {:else if status === 'done'}
            <div class="text-2xl opacity-70">✓</div>
            <div class="text-xs">No open PRs awaiting your review.</div>
          {:else}
            <div class="text-2xl opacity-70">🔎</div>
            <div class="text-xs">Screen your review queue to begin.</div>
          {/if}
        </div>
      {:else}
        {#each BUCKET_ORDER as b (b)}
          {@const cards = byBucket[b]}
          {#if cards.length > 0}
            <div class="mb-5">
              <div class="mb-2 flex items-center gap-2">
                <span class="h-3.5 w-[3px] rounded-sm {BUCKETS[b].stripe}"></span>
                <span class="text-[11px] font-semibold uppercase tracking-wider {BUCKETS[b].head}">{BUCKETS[b].label}</span>
                <span class="rounded-full border border-zinc-800 bg-zinc-900 px-1.5 text-[10px] tabular-nums text-zinc-500">{cards.length}</span>
                <span class="text-[10px] italic text-zinc-600">{BUCKETS[b].sub}</span>
              </div>
              <div class="flex flex-col gap-2">
                {#each cards as c (c.url)}
                  {@const issues = c.findings.filter((f) => f.label === 'issue').length}
                  {@const suggestions = c.findings.filter((f) => f.label === 'suggestion').length}
                  <button
                    class="flex w-full flex-col gap-2 rounded-lg border bg-zinc-900 p-3 text-left transition-colors hover:bg-zinc-800/60
                      {selectedKey === c.url ? 'border-blue-500' : 'border-zinc-800 hover:border-zinc-700'}"
                    onclick={() => screenPrsStore.select(c.url)}
                  >
                    <div class="flex items-baseline gap-2">
                      <span class="flex-none font-mono text-[11px] text-zinc-500"><b class="font-semibold text-zinc-300">{c.repo}</b>#{c.number}</span>
                      <span class="flex-1 text-[12.5px] font-medium leading-snug text-zinc-100">{c.title}</span>
                    </div>
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]">
                      <span class="tabular-nums text-zinc-400"><b class="text-emerald-400">+{c.additions}</b> <b class="text-red-400">−{c.deletions}</b> <span class="text-zinc-600">·</span> {c.changedFiles}f</span>
                      <span class={ciClass[c.ci]}>{ciLabel(c)}</span>
                      {#if c.reviewers.length}
                        <span class="text-zinc-500">{c.reviewers.map((r) => `${r.login}:${r.state}`).join(', ')}</span>
                      {/if}
                    </div>
                    {#if c.impact === 'high' || issues || suggestions}
                      <div class="flex flex-wrap gap-1.5">
                        {#if c.impact === 'high'}<span class="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">▲ high impact</span>{/if}
                        {#if issues}<span class="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-300">{issues} issue{issues > 1 ? 's' : ''}</span>{/if}
                        {#if suggestions}<span class="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-300">{suggestions} suggestion{suggestions > 1 ? 's' : ''}</span>{/if}
                      </div>
                    {/if}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        {/each}

        {#if pending.length > 0}
          <div class="flex items-center gap-2 rounded-lg border border-dashed border-zinc-800 px-3 py-2 text-[11px] text-zinc-600">
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>
            screening {pending.length} more…
          </div>
        {/if}
      {/if}
    </div>

    {#if selectedKey && selectedContext}
      <div class="min-w-0 flex-1">
        <PrDetail context={selectedContext} card={selectedCard} />
      </div>
    {/if}
  </div>
</div>
