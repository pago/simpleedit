<script lang="ts">
  /**
   * The PR overview, shared by the desktop detail and the phone.
   *
   * Code renders everything factual: the header row (author, draft or ready,
   * reviews, CI, changeset) and the actions on each Look-into item. The model
   * only supplies the prose inside the four fixed sections, which
   * `parseOverview` splits out of the cached raw text on every render. Output
   * that doesn't parse is shown whole, so nothing the model wrote is lost.
   */
  import type { PrContext } from '../../../shared/screenprs'
  import {
    parseOverview,
    type OverviewLookIntoItem,
    type OverviewRef,
    type OverviewSections,
  } from '../../../shared/pr-overview'
  import type { OverviewState } from '../../stores/screenprs.svelte'
  import { renderMarkdown } from '../../lib/markdown'

  type SectionKey = keyof OverviewSections

  interface Props {
    context: Pick<PrContext, 'author' | 'reviewers' | 'ci' | 'ciFailing' | 'headSha'>
    overview: OverviewState
    /** Sections open on first render; the others start collapsed. Default: all. */
    initiallyOpen?: SectionKey[]
    onref: (ref: OverviewRef) => void
    onreview: (item: OverviewLookIntoItem) => void
    /** Absent until there are models to discuss with. */
    ondiscuss?: (item: OverviewLookIntoItem) => void
  }

  let { context, overview, initiallyOpen, onref, onreview, ondiscuss }: Props = $props()

  const SECTIONS: { key: SectionKey; label: string }[] = [
    { key: 'what', label: 'What changed' },
    { key: 'why', label: 'Why' },
    { key: 'impact', label: 'Impact' },
    { key: 'lookInto', label: 'Look into' },
  ]

  let parsed = $derived(overview.text ? parseOverview(overview.text) : null)

  /** Sections the reader flipped away from their default. */
  let flipped = $state<Set<SectionKey>>(new Set())
  const isOpen = (key: SectionKey): boolean => (initiallyOpen ? initiallyOpen.includes(key) : true) !== flipped.has(key)
  function toggle(key: SectionKey): void {
    const next = new Set(flipped)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    flipped = next
  }

  let reviews = $derived.by(() => {
    const count = (state: string): number => context.reviewers.filter((r) => r.state === state).length
    const parts = [
      count('approved') && `${count('approved')} approved`,
      count('changes_requested') && `${count('changes_requested')} changes requested`,
      count('commented') && `${count('commented')} commented`,
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : 'no reviews'
  })

  let changeset = $derived.by(() => {
    const facts = overview.facts
    if (!facts) return null
    if (facts.changeset === 'yes') return 'changeset: yes'
    if (facts.changeset === 'base') return `changeset: maybe in ${facts.changesetBase ?? 'the base'}`
    return 'changeset: none'
  })

  const CI_CLASS = { green: 'text-emerald-400', pending: 'text-amber-400', failing: 'text-red-400' } as const

  const refLabel = (r: OverviewRef): string => (r.line ? `${r.path}:${r.line}` : r.path)
  const html = (md: string): string => renderMarkdown(md)
  const PROSE = 'prose prose-invert prose-sm max-w-none text-[12px] leading-relaxed text-zinc-300 prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5 prose-code:text-[11px]'
</script>

<section class="overflow-hidden rounded-lg border border-teal-500/25 bg-zinc-900" data-testid="overview-card">
  <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-500" data-testid="overview-facts">
    <span class="rounded border border-teal-400/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-teal-300">Overview</span>
    <span>@{context.author}</span>
    {#if overview.facts}<span>{overview.facts.draft ? 'draft' : 'ready'}</span>{/if}
    <span>{reviews}</span>
    <span class={CI_CLASS[context.ci]}>
      {context.ci === 'failing' && context.ciFailing.length ? `CI failing: ${context.ciFailing.join(', ')}` : `CI ${context.ci === 'green' ? 'passing' : context.ci}`}
    </span>
    {#if changeset}<span>{changeset}</span>{/if}
  </div>

  {#if overview.status === 'error'}
    <p class="px-3 py-3 text-[11px] text-red-400" data-testid="overview-error">Overview failed: {overview.error}</p>
  {:else if overview.status === 'running'}
    <p class="flex items-center gap-2 px-3 py-3 text-[11px] text-zinc-500" data-testid="overview-running">
      <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-teal-500"></span>
      Reading the PR, its discussion and key files…
    </p>
  {:else if parsed && !parsed.wellFormed}
    <div class="px-3 py-2.5" data-testid="overview-raw">
      <p class="mb-1.5 text-[10px] italic text-zinc-600" data-testid="overview-unstructured">
        Unstructured output — shown as the model wrote it.
      </p>
      <div class={PROSE}>{@html html(parsed.raw)}</div>
    </div>
  {:else if parsed}
    {#if overview.headSha && context.headSha && overview.headSha !== context.headSha}
      <p class="border-b border-zinc-800 px-3 py-1.5 text-[10.5px] text-amber-300/80" data-testid="overview-stale">
        Written for an earlier head; line citations may have moved.
      </p>
    {/if}
    {#each SECTIONS as s (s.key)}
      {@const open = isOpen(s.key)}
      <div class="border-b border-zinc-800/60 last:border-b-0" data-testid="overview-section-{s.key}">
        <button
          type="button"
          class="flex min-h-8 w-full items-center gap-1.5 px-3 py-1.5 text-left text-[10.5px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
          aria-expanded={open}
          onclick={() => toggle(s.key)}
        >
          <span class="text-[9px] text-zinc-600">{open ? '▾' : '▸'}</span>{s.label}
        </button>
        {#if open}
          {#if s.key === 'lookInto'}
            <ol class="flex flex-col gap-2 px-3 pb-3">
              {#each parsed.sections.lookInto ?? [] as item, i (i)}
                <li class="rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-2" data-testid="look-into-item">
                  <div class="flex gap-2">
                    <span class="flex-none text-[11px] tabular-nums text-zinc-600">{i + 1}.</span>
                    <div class="min-w-0 flex-1 {PROSE}">{@html html(item.markdown)}</div>
                  </div>
                  <div class="mt-1.5 flex flex-wrap items-center gap-1.5 pl-5">
                    {#each item.refs as ref (refLabel(ref))}
                      <button
                        type="button"
                        class="min-h-7 max-w-full truncate rounded border border-zinc-700 bg-zinc-800 px-1.5 font-mono text-[10px] text-blue-300 hover:border-blue-500"
                        title="Show in the diff"
                        data-testid="overview-ref"
                        onclick={() => onref(ref)}
                      >{refLabel(ref)}</button>
                    {/each}
                    <span class="ml-auto flex gap-1.5">
                      <button
                        type="button"
                        class="min-h-7 rounded border border-zinc-700 bg-zinc-800 px-2 text-[10px] text-zinc-300 hover:border-blue-500 hover:text-blue-200"
                        title="Add to the review composer as a question"
                        data-testid="overview-add-review"
                        onclick={() => onreview(item)}
                      >＋ review</button>
                      {#if ondiscuss}
                        <button
                          type="button"
                          class="min-h-7 rounded border border-zinc-700 bg-zinc-800 px-2 text-[10px] text-zinc-300 hover:border-violet-500 hover:text-violet-200"
                          title="Discuss this with an agent"
                          data-testid="overview-discuss"
                          onclick={() => ondiscuss(item)}
                        >✦ Discuss</button>
                      {/if}
                    </span>
                  </div>
                </li>
              {/each}
            </ol>
          {:else}
            <div class="px-3 pb-3 {PROSE}">{@html html(parsed.sections[s.key] ?? '')}</div>
          {/if}
        {/if}
      </div>
    {/each}
  {/if}
</section>
