<script lang="ts">
  import { onMount } from 'svelte'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { triageModel } from '../../stores/triageModel.svelte'
  import { sidebarRail } from '../../stores/sidebarRail.svelte'
  import { reviewRoom } from '../../stores/reviewRoom.svelte'
  import type { ScreenPrCard, ScreenPrBucket, PrReviewDraft, PrReviewVerdict } from '../../../shared/screenprs'
  import { CI_TONE, ciLabel } from '../../../shared/screenprs'
  import { BUCKET_ORDER, groupStacks, emptyReviewDraft } from '../../../shared/screenprs'
  import MagnifierIcon from './MagnifierIcon.svelte'
  import ConfirmReviewModal from './ConfirmReviewModal.svelte'

  interface Props {
    class?: string
  }

  let { class: className = '' }: Props = $props()

  let status = $derived(screenPrsStore.status())
  let byBucket = $derived(screenPrsStore.byBucket())
  let pending = $derived(screenPrsStore.pending())
  let selectedKey = $derived(screenPrsStore.selectedKey())
  // Reviews an agent asked for: listed here, never opened for the user (they may not be in the screened queue).
  let requested = $derived(reviewRoom.requested())

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

  onMount(() => void triageModel.refresh())

  // ── quick-approve ✓: one-click Approve straight from a card, still guarded by
  // the same confirm modal the composer uses (this writes to GitHub too).
  let quickTarget = $state<ScreenPrCard | null>(null)
  let quickDraft = $state<PrReviewDraft>(emptyReviewDraft())
  let quickError = $state<string | null>(null)
  let quickSubmitting = $derived(quickTarget != null && screenPrsStore.isSubmitting(quickTarget.url))

  function pick(url: string): void {
    screenPrsStore.select(url)
    sidebarRail.chose('screenprs')
  }

  function quickApprove(c: ScreenPrCard): void {
    quickError = null
    quickDraft = { ...emptyReviewDraft(), verdict: 'approve' }
    quickTarget = c
  }
  async function confirmQuick(): Promise<void> {
    if (!quickTarget) return
    quickError = null
    try {
      // Pinned to the card's head: an approval must not land on a push the reviewer never screened.
      // A separate empty review, so whatever is drafted for this PR stays.
      const res = await screenPrsStore.submitReview(quickTarget, quickDraft, { headSha: quickTarget.headSha })
      if (res.ok) quickTarget = null
      else quickError = res.error // keep the modal open so the failure is visible
    } catch (e) {
      quickError = e instanceof Error ? e.message : String(e)
    }
  }

  const VERDICT_PILL: Record<PrReviewVerdict, { label: string; cls: string }> = {
    approve: { label: 'approved', cls: 'bg-emerald-500/15 text-emerald-300' },
    comment: { label: 'commented', cls: 'bg-blue-500/15 text-blue-300' },
    request_changes: { label: 'changes requested', cls: 'bg-red-500/15 text-red-300' },
  }
</script>

<!-- One queue card. `order` is set when the card sits inside a stack (its 1-based
     position), so the reviewer sees the review order. Quick-approve ✓ is a sibling
     (not nested in the card button — that'd be invalid HTML) revealed on hover. -->
{#snippet prCard(c: ScreenPrCard, order: { n: number; of: number } | null)}
  {@const issues = c.findings.filter((f) => f.label === 'issue').length}
  {@const suggestions = c.findings.filter((f) => f.label === 'suggestion').length}
  {@const sub = screenPrsStore.submittedFor(c.url)}
  <div class="group relative">
    <button
      class="flex w-full flex-col gap-2 rounded-lg border bg-zinc-900 p-3 text-left transition-colors hover:bg-zinc-800/60
        {selectedKey === c.url ? 'border-blue-500' : sub ? 'border-emerald-500/25' : 'border-zinc-800 hover:border-zinc-700'}"
      onclick={() => pick(c.url)}
    >
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pr-6">
        {#if order}<span class="flex-none rounded bg-violet-500/15 px-1 text-[9px] font-bold tabular-nums text-violet-300">{order.n}/{order.of}</span>{/if}
        <span class="flex-none font-mono text-[11px] text-zinc-500"><b class="font-semibold text-zinc-300">{c.repo}</b>#{c.number}</span>
        <span class="min-w-[min(8rem,100%)] flex-1 text-[12.5px] font-medium leading-snug [overflow-wrap:anywhere] {sub ? 'text-zinc-400' : 'text-zinc-100'}">{c.title}</span>
      </div>
      <div class="hidden flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] @[13rem]:flex">
        <span class="tabular-nums text-zinc-400"><b class="text-emerald-400">+{c.additions}</b> <b class="text-red-400">−{c.deletions}</b> <span class="text-zinc-600">·</span> {c.changedFiles}f</span>
        <span class="hidden {CI_TONE[c.ci]} @2xs:inline">{ciLabel(c)}</span>
        {#if c.reviewers.length}
          <span class="hidden text-zinc-500 @2xs:inline">{c.reviewers.map((r) => `${r.login}:${r.state}`).join(', ')}</span>
        {/if}
      </div>
      {#if sub}
        <div class="hidden flex-wrap gap-1.5 @3xs:flex">
          <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold {VERDICT_PILL[sub.verdict].cls}">✓ you: {VERDICT_PILL[sub.verdict].label}</span>
        </div>
      {:else if c.impact === 'high' || issues || suggestions}
        <div class="hidden flex-wrap gap-1.5 {c.impact === 'high' ? '@3xs:flex' : '@xs:flex'}">
          {#if c.impact === 'high'}<span class="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">▲ high impact</span>{/if}
          {#if issues}<span class="hidden rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-300 @xs:inline">{issues} issue{issues > 1 ? 's' : ''}</span>{/if}
          {#if suggestions}<span class="hidden rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-300 @xs:inline">{suggestions} suggestion{suggestions > 1 ? 's' : ''}</span>{/if}
        </div>
      {/if}
    </button>
    {#if !sub}
      <button
        class="absolute right-2 top-2 flex h-[22px] w-[22px] items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 text-[12px] text-zinc-400 opacity-0 transition-opacity hover:border-emerald-500 hover:bg-emerald-500/18 hover:text-emerald-300 group-hover:opacity-100"
        title="Quick approve — post an Approve review to GitHub"
        onclick={() => quickApprove(c)}
      >✓</button>
    {/if}
  </div>
{/snippet}

<div class="@container overflow-y-auto px-3 py-4 {className}" data-testid="screenprs-queue">
  {#if requested.length > 0}
    <div class="mb-5" data-testid="screenprs-requested">
      <div class="mb-2 flex items-center gap-2">
        <span class="h-3.5 w-[3px] flex-none rounded-sm bg-violet-500"></span>
        <span class="min-w-0 truncate whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-violet-300">Requested</span>
        <span class="flex-none rounded-full border border-zinc-800 bg-zinc-900 px-1.5 text-[10px] tabular-nums text-zinc-500">{requested.length}</span>
        <span class="hidden min-w-0 truncate text-[10px] italic text-zinc-600 @2xs:inline">an agent asked for your review</span>
      </div>
      <div class="flex flex-col gap-2">
        {#each requested as r (r.id)}
          {@const top = r.layers[r.layers.length - 1]}
          {#if top}
            {@const repo = new URL(top.url).pathname.split('/')[2] ?? ''}
            <button
              class="flex w-full flex-col gap-1.5 rounded-lg border bg-zinc-900 p-3 text-left transition-colors hover:bg-zinc-800/60
                {selectedKey === top.url ? 'border-blue-500' : 'border-violet-500/30 hover:border-violet-500/60'}"
              onclick={() => pick(top.url)}
            >
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span class="flex-none font-mono text-[11px] text-zinc-500"><b class="font-semibold text-zinc-300">{repo}</b>#{top.number}</span>
                <span class="min-w-[min(8rem,100%)] flex-1 text-[12.5px] font-medium leading-snug text-zinc-100 [overflow-wrap:anywhere]">{top.title ?? 'Pull request'}</span>
              </div>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-zinc-500">
                {#if r.layers.length > 1}<span class="text-violet-300">⛓ stack of {r.layers.length}</span>{/if}
                {#if r.round > 1}<span class="{r.round >= 3 ? 'text-amber-300' : ''}">round {r.round}</span>{/if}
                {#if r.authorBriefing}<span>briefing</span>{/if}
              </div>
            </button>
          {/if}
        {/each}
      </div>
    </div>
  {/if}
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
          <span class="h-3 w-3 flex-none animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>
          <span class="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Screening…</span>
          <span class="flex-none rounded-full border border-zinc-800 bg-zinc-900 px-1.5 text-[10px] tabular-nums text-zinc-500">{pending.length}</span>
          <span class="min-w-0 truncate text-[10px] text-zinc-600">{running} triaging · {pending.length - running} scheduled</span>
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
              onclick={() => pick(p.ref.url)}
            >
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span class="flex-none font-mono text-[11px] text-zinc-500"><b class="font-semibold text-zinc-400">{p.ref.repo}</b>#{p.ref.number}</span>
                <span class="min-w-[min(8rem,100%)] flex-1 text-[12.5px] leading-snug [overflow-wrap:anywhere] {isRun ? 'text-zinc-100' : 'text-zinc-300'}">{p.ref.title}</span>
              </div>
              <div class="flex items-center gap-2 text-[10.5px]">
                {#if p.context}
                  <span class="hidden tabular-nums text-zinc-400 @[13rem]:inline"><span class="text-emerald-400">+{p.context.additions}</span> <span class="text-red-400">−{p.context.deletions}</span> <span class="text-zinc-600">·</span> {p.context.changedFiles}f</span>
                {/if}
                {#if p.phase === 'running'}
                  <span class="flex items-center gap-1.5 text-blue-300">
                    <span class="h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-500/30 border-t-blue-400"></span>
                    Triaging now · {triageModel.label}
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
            <span class="h-3.5 w-[3px] flex-none rounded-sm {BUCKETS[b].stripe}"></span>
            <span class="min-w-0 truncate whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider {BUCKETS[b].head}">{BUCKETS[b].label}</span>
            <span class="flex-none rounded-full border border-zinc-800 bg-zinc-900 px-1.5 text-[10px] tabular-nums text-zinc-500">{cards.length}</span>
            <span class="hidden min-w-0 truncate text-[10px] italic text-zinc-600 @2xs:inline">{BUCKETS[b].sub}</span>
          </div>
          <div class="flex flex-col gap-2">
            {#each groupStacks(cards) as g (g.cards[0].url)}
              {#if g.stackId}
                <div class="rounded-r-md border-l-2 border-violet-500/70 pl-2">
                  <div class="mb-1 truncate whitespace-nowrap text-[10px] uppercase tracking-wider text-violet-300">⛓ stack · review top → bottom</div>
                  <div class="flex flex-col gap-1.5">
                    {#each g.cards as c, i (c.url)}
                      {@render prCard(c, { n: i + 1, of: g.cards.length })}
                    {/each}
                  </div>
                </div>
              {:else}
                {@render prCard(g.cards[0], null)}
              {/if}
            {/each}
          </div>
        </div>
      {/if}
    {/each}
  {/if}
</div>

{#if quickTarget}
  <ConfirmReviewModal
    repo={quickTarget.repo}
    number={quickTarget.number}
    draft={quickDraft}
    submitting={quickSubmitting}
    error={quickError}
    onconfirm={confirmQuick}
    oncancel={() => (quickTarget = null)}
  />
{/if}
