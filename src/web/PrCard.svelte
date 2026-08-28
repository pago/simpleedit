<script lang="ts">
  /**
   * One PR on the board.
   *
   * Everything here is a reason to open it or not: what it is, how big, whether
   * CI is green, and what triage flagged. The bucket it sits in is the section
   * heading's job — a card repeating it would say the same thing twice.
   */
  import type { ScreenPrCard, PrCiStatus } from '../shared/screenprs'

  interface Props {
    card: ScreenPrCard
    /** Depth in a stack: base is 0, each dependent one deeper. */
    depth?: number
    onopen: (card: ScreenPrCard) => void
  }

  let { card, depth = 0, onopen }: Props = $props()

  const CI_CLASS: Record<PrCiStatus, string> = {
    green: 'text-emerald-400',
    pending: 'text-amber-400',
    failing: 'text-red-400',
  }
  const CI_LABEL: Record<PrCiStatus, string> = { green: 'CI ✓', pending: 'CI …', failing: 'CI ✕' }

  let issues = $derived(card.findings.filter((f) => f.label === 'issue').length)
</script>

<button
  type="button"
  onclick={() => onopen(card)}
  data-testid="pr-card"
  data-pr-url={card.url}
  class="flex w-full flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-3 text-left active:bg-zinc-800"
  style={depth > 0 ? `margin-left:${Math.min(depth, 3) * 0.75}rem` : undefined}
>
  <span class="flex items-start gap-2">
    {#if depth > 0}
      <span class="mt-0.5 flex-none text-[11px] text-zinc-600" aria-label="stacked on the PR above">↳</span>
    {/if}
    <span class="min-w-0 flex-1 text-sm leading-snug text-zinc-100">{card.title}</span>
  </span>

  <span class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-zinc-500">
    <span class="font-mono text-zinc-400">{card.repo}#{card.number}</span>
    <span>{card.author}</span>
    <span class="tabular-nums"
      ><b class="text-emerald-500">+{card.additions}</b>
      <b class="text-red-500">−{card.deletions}</b></span
    >
    <span class={CI_CLASS[card.ci]}>{CI_LABEL[card.ci]}</span>
    {#if card.impact === 'high'}
      <span class="rounded bg-red-500/15 px-1.5 py-0.5 font-semibold text-red-300">high impact</span>
    {/if}
    {#if issues > 0}
      <span class="rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-300" data-testid="issue-count"
        >{issues} issue{issues === 1 ? '' : 's'}</span
      >
    {/if}
    {#if card.approvedByOther}
      <span class="text-emerald-500">approved by another</span>
    {/if}
  </span>
</button>
