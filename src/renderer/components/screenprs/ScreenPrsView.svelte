<script lang="ts">
  import { onMount } from 'svelte'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import type { ScreenPrCard, ScreenPrBucket, PrCiStatus } from '../../../shared/screenprs'
  import { BUCKET_ORDER } from '../../../shared/screenprs'
  import PrDetail from './PrDetail.svelte'
  import MagnifierIcon from './MagnifierIcon.svelte'

  let status = $derived(screenPrsStore.status())
  let byBucket = $derived(screenPrsStore.byBucket())
  let pending = $derived(screenPrsStore.pending())
  let total = $derived(screenPrsStore.total())
  let selectedKey = $derived(screenPrsStore.selectedKey())
  let selectedCard = $derived(screenPrsStore.selectedCard())
  let selectedContext = $derived(screenPrsStore.selectedContext())

  let done = $derived([...Object.values(byBucket)].reduce((n, arr) => n + arr.length, 0))
  let hasAny = $derived(done > 0 || pending.length > 0)
  // Show the actively-triaging PR first, then scheduled, then still-gathering.
  const PHASE_ORDER = { running: 0, scheduled: 1, gathering: 2 }
  let pendingSorted = $derived([...pending].sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]))

  const BUCKETS: Record<ScreenPrBucket, { label: string; sub: string; stripe: string; head: string }> = {
    attention: { label: 'Needs your attention', sub: 'critical or high-impact', stripe: 'bg-red-500', head: 'text-red-400' },
    quick: { label: 'Quick pass', sub: 'small, green, uncontroversial', stripe: 'bg-amber-500', head: 'text-amber-400' },
    waiting: { label: 'Waiting on author', sub: 'CI red — don’t review yet', stripe: 'bg-blue-500', head: 'text-blue-300' },
    fyi: { label: 'Already approved — FYI', sub: 'covered by others', stripe: 'bg-zinc-600', head: 'text-zinc-400' },
  }

  // Org/cutoff seeded once from the store's current filter (not reactive — these
  // are editable inputs).
  let owner = $state(screenPrsStore.filters().owner ?? '')
  let cutoff = $state('30')

  // Read-only preview of which model triage/deep review will run on. Refetched on
  // mount and whenever screening starts, so a Settings change is reflected.
  let triageModel = $state('…')
  async function refreshTriageModel(): Promise<void> {
    try {
      const [cfg, claude] = await Promise.all([
        window.api.invoke('models:config-get'),
        window.api.invoke('models:claude'),
      ])
      const m = cfg.defaults.screenPrs
      if (!m) triageModel = 'Haiku 4.5 · default'
      else if (m.provider === 'ollama') triageModel = `${m.model} · local`
      else triageModel = claude.find((c) => c.model === m.model)?.displayName ?? m.model
    } catch {
      triageModel = 'Haiku 4.5 · default'
    }
  }
  onMount(refreshTriageModel)

  function isoCutoff(days: string): string {
    const d = new Date()
    d.setDate(d.getDate() - Number(days))
    return d.toISOString().slice(0, 10)
  }
  function screen(force = false): void {
    void refreshTriageModel()
    void screenPrsStore.start({ owner: owner.trim() || undefined, updatedSince: isoCutoff(cutoff), force })
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
        <span class="text-[11px] text-zinc-500">
          {total === undefined ? 'finding PRs…' : `screening ${done}/${total}`}
        </span>
        <button class="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800" onclick={() => screenPrsStore.cancel()}>Stop</button>
      {:else}
        <button
          class="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
          title={done > 0 ? 'Re-screen (⌥-click to ignore cache and re-run all)' : 'Screen your review queue'}
          onclick={(e) => screen(e.altKey)}
        >
          <MagnifierIcon class="h-3.5 w-3.5" />
          {done > 0 ? 'Re-screen' : 'Screen'}
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
      <span class="ml-auto text-[10.5px] text-zinc-600">triage · <span class="text-zinc-500">{triageModel}</span></span>
    </div>
  </div>

  <!-- Split: queue | detail -->
  <div class="flex min-h-0 flex-1">
    <div class="w-[380px] flex-none overflow-y-auto border-r border-zinc-800 px-3 py-4" class:flex-1={!selectedKey}>
      {#if !hasAny}
        <div class="flex flex-col items-center gap-3 py-16 text-zinc-600">
          {#if status === 'error'}
            <div class="text-sm text-red-400">Screening failed</div>
            <div class="max-w-xs text-center text-[11px]">{screenPrsStore.error()}</div>
          {:else if status === 'done'}
            <MagnifierIcon class="h-7 w-7 opacity-50" />
            <div class="text-xs">No open PRs awaiting your review.</div>
          {:else if status === 'running'}
            <span class="h-4 w-4 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>
            <div class="text-xs">Finding PRs…</div>
          {:else}
            <MagnifierIcon class="h-7 w-7 opacity-50" />
            <div class="text-xs">Screen your review queue to begin.</div>
          {/if}
        </div>
      {:else}
        <!-- Screening… — in-progress PRs; the model works one at a time (local) -->
        {#if pending.length > 0}
          {@const running = pending.filter((p) => p.phase === 'running').length}
          <div class="mb-5">
            <div class="mb-2 flex items-center gap-2">
              <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>
              <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Screening…</span>
              <span class="rounded-full border border-zinc-800 bg-zinc-900 px-1.5 text-[10px] tabular-nums text-zinc-500">{pending.length}</span>
              <span class="text-[10px] text-zinc-600">{running} triaging · {pending.length - running} scheduled</span>
            </div>
            <div class="flex flex-col gap-2">
              {#each pendingSorted as p (p.ref.url)}
                {@const isRun = p.phase === 'running'}
                <button
                  class="flex w-full flex-col gap-1.5 rounded-lg border bg-zinc-900/50 p-3 text-left transition-colors
                    {isRun ? 'border-solid border-blue-500/50' : 'border-dashed'}
                    {selectedKey === p.ref.url ? 'border-blue-500' : isRun ? '' : 'border-zinc-800 hover:border-zinc-700'}
                    {p.context ? '' : 'cursor-default'}"
                  disabled={!p.context}
                  title={p.context ? 'Open — diff is ready, triage still running' : 'Gathering context…'}
                  onclick={() => screenPrsStore.select(p.ref.url)}
                >
                  <div class="flex items-baseline gap-2">
                    <span class="flex-none font-mono text-[11px] text-zinc-500"><b class="font-semibold text-zinc-400">{p.ref.repo}</b>#{p.ref.number}</span>
                    <span class="flex-1 text-[12.5px] leading-snug {isRun ? 'text-zinc-100' : 'text-zinc-300'}">{p.ref.title}</span>
                  </div>
                  <div class="flex items-center gap-2 text-[10.5px]">
                    {#if p.context}
                      <span class="tabular-nums text-zinc-400"><span class="text-emerald-400">+{p.context.additions}</span> <span class="text-red-400">−{p.context.deletions}</span> <span class="text-zinc-600">·</span> {p.context.changedFiles}f</span>
                    {/if}
                    {#if p.phase === 'running'}
                      <span class="flex items-center gap-1.5 text-blue-300">
                        <span class="h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-500/30 border-t-blue-400"></span>
                        Triaging now · {triageModel}
                      </span>
                    {:else if p.phase === 'scheduled'}
                      <span class="text-zinc-600">⏳ scheduled</span>
                    {:else}
                      <span class="text-zinc-600">gathering context…</span>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          </div>
        {/if}

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
      {/if}
    </div>

    {#if selectedKey && selectedContext}
      <div class="min-w-0 flex-1">
        <PrDetail context={selectedContext} card={selectedCard} />
      </div>
    {/if}
  </div>
</div>
