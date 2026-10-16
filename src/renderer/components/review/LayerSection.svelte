<script lang="ts">
  /**
   * One layer of the stack: its header (what / why / impact once the overview
   * ran, the Overview and Deep review tools, the base warning, "since you last
   * looked"), its PR-level threads, then its diff, as the overview's reading
   * order with the cited hunks inline, or every file in path order. Line
   * threads sit under the row they end on, at the head on screen.
   */
  import type { Review, ReviewThread, ReviewThreadAnchor } from '../../../shared/review-room'
  import type { ReviewLayerDiff, ReviewLayerInfo } from '../../../shared/review-room-ipc'
  import type { PrContext, PrReviewComment } from '../../../shared/screenprs'
  import { DEEP_LENS_LABEL, DEEP_LENS_ORDER, baseWarning } from '../../../shared/screenprs'
  import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../../../shared/parseDiff'
  import { parseOverview } from '../../../shared/pr-overview'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { reviewRoom } from '../../stores/reviewRoom.svelte'
  import { renderMarkdown } from '../../lib/markdown'
  import {
    anchorEndsAt,
    anchorText,
    buildTour,
    byPath,
    lineOn,
    placeThreads,
    sideOf,
    type Section,
    type Side,
  } from '../../lib/review-room'
  import UnifiedDiffView from '../diff/UnifiedDiffView.svelte'
  import ReviewThreadCard from './ReviewThreadCard.svelte'
  import ThreadComposer from './ThreadComposer.svelte'

  interface Props {
    reviewId: string
    review: Review
    layer: ReviewLayerInfo
    /** Bottom → top. */
    layers: ReviewLayerInfo[]
    /** This layer's PR-level and line threads. */
    threads: ReviewThread[]
    drafts: Map<string, { url: string; comment: PrReviewComment }>
    companionSessionId?: string
    /** The review is closed: everything shows, nothing changes. */
    readonly?: boolean
  }

  let { reviewId, review, layer, layers, threads, drafts, companionSessionId, readonly = false }: Props = $props()

  // ── The diff and "since you last looked" ──
  let diff = $derived(reviewRoom.layerDiff(reviewId, layer.url))
  let diffError = $state<string | null>(null)
  let since = $derived(reviewRoom.since(reviewId, layer.url))

  // Values, not the layer object: a review change rebuilds the object with the same head.
  let layerUrl = $derived(layer.url)
  let layerHead = $derived(layer.headSha)
  $effect(() => {
    const url = layerUrl
    void layerHead // a pushed head means a new diff
    diffError = null
    reviewRoom.loadLayerDiff(reviewId, url).catch((err: unknown) => {
      diffError = err instanceof Error ? err.message : String(err)
    })
    void reviewRoom.loadSince(reviewId, url)
  })

  let headSha = $derived(diff?.headSha ?? layer.headSha)
  let files = $derived<DiffFile[]>(diff ? parseUnifiedDiff(diff.diff) : [])

  /** "Show only the new changes": the compare diff, read-only. */
  let sinceOnly = $state<{ files: DiffFile[] } | { error: string } | null>(null)
  async function showSince(): Promise<void> {
    try {
      sinceOnly = { files: parseUnifiedDiff(await reviewRoom.sinceDiff(reviewId, layer.url)) }
    } catch (err) {
      sinceOnly = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  async function gotIt(): Promise<void> {
    sinceOnly = null
    await reviewRoom.ackHead(reviewId, layer.url).catch((err: unknown) => console.warn('[review] ack-head failed:', err))
  }

  // ── Overview and deep review (the existing runs, keyed by PR url) ──
  let overview = $derived(screenPrsStore.overviewFor(layer.url))
  let deep = $derived(screenPrsStore.deepFor(layer.url))
  let parsed = $derived(overview?.status === 'done' && overview.text ? parseOverview(overview.text) : null)
  let readingOrder = $derived(parsed?.sections.readingOrder ?? [])
  let activeLenses = $derived(DEEP_LENS_ORDER.filter((l) => deep?.lenses[l]))

  function prContext(d: ReviewLayerDiff): PrContext {
    return {
      owner: layer.owner,
      repo: layer.repo,
      number: layer.number,
      url: layer.url,
      title: layer.title,
      author: layer.author,
      updatedAt: '',
      headSha: d.headSha,
      additions: layer.additions,
      deletions: layer.deletions,
      changedFiles: layer.changedFiles,
      baseRefName: layer.baseRefName,
      headRefName: layer.headRefName,
      ci: layer.ci,
      ciFailing: [],
      reviewers: [],
      approvedByOther: false,
      body: layer.body,
      diff: d.diff,
      ...(d.base ?? layer.base ? { base: d.base ?? layer.base } : {}),
    }
  }

  function runOverview(): void {
    if (diff) void screenPrsStore.startOverview(prContext(diff))
  }
  function runDeep(): void {
    if (diff) void screenPrsStore.startDeep(prContext(diff))
  }

  let warning = $derived(baseWarning({ base: diff?.base ?? layer.base, baseRefName: layer.baseRefName, changedFiles: layer.changedFiles }))

  // ── Sections: the tour, then what it leaves out; or path order ──
  let tour = $derived(readingOrder.length ? buildTour(layer.number, readingOrder, files) : null)
  let sections = $derived<Section[]>(
    tour
      ? [...tour.steps.map((s) => ({ key: s.id, files: s.files })), { key: 'rest', files: tour.rest }]
      : [{ key: 'all', files: byPath(files) }],
  )
  let lineThreads = $derived(threads.filter((t) => t.anchor.kind === 'line'))
  let placement = $derived(placeThreads(lineThreads, layer.number, headSha, sections))
  /** PR-level threads, and line threads no row on screen carries (outdated, or outside every shown hunk). */
  let topThreads = $derived(threads.filter((t) => t.anchor.kind === 'pr' || !placement.has(t.id)))

  let readSet = $derived(new Set(review.readSteps))

  // ── New line threads ──
  interface Composing {
    section: string
    path: string
    side: Side
    /** The line first clicked; a shift-click spans from it to the new line. */
    anchor: number
    from: number
    to: number
  }
  let composing = $state<Composing | null>(null)
  let composingPr = $state(false)

  function lineClick(section: string, f: DiffFile, row: DiffRow, ev: MouseEvent): void {
    const side = sideOf(row)
    const n = lineOn(row, side)
    if (n === undefined) return
    const c = composing
    if (ev.shiftKey && c && c.section === section && c.path === f.path && c.side === side) {
      composing = { ...c, from: Math.min(c.anchor, n), to: Math.max(c.anchor, n) }
      return
    }
    composing = { section, path: f.path, side, anchor: n, from: n, to: n }
  }

  function lineAnchor(c: Composing): ReviewThreadAnchor | null {
    const full = files.find((f) => f.path === c.path)
    if (!full) return null
    return { kind: 'line', pr: layer.number, headSha, path: c.path, side: c.side, startLine: c.from, endLine: c.to, ...anchorText(full, c.side, c.from, c.to) }
  }

  async function startLine(text: string, mode: 'ask' | 'draft'): Promise<void> {
    const c = composing
    const anchor = c && lineAnchor(c)
    if (!anchor) return
    if (mode === 'ask') await reviewRoom.addThread(reviewId, anchor, text)
    else await reviewRoom.addDraftThread(reviewId, anchor, layer.url, text)
    composing = null
  }

  async function startPr(text: string, mode: 'ask' | 'draft'): Promise<void> {
    const anchor: ReviewThreadAnchor = { kind: 'pr', pr: layer.number }
    if (mode === 'ask') await reviewRoom.addThread(reviewId, anchor, text)
    else await reviewRoom.addDraftThread(reviewId, anchor, layer.url, text)
    composingPr = false
  }

  function composerLabel(c: Composing): string {
    const lines = c.from === c.to ? `line ${c.from}` : `lines ${c.from}–${c.to}`
    return `${c.path} · ${c.side === 'LEFT' ? 'deleted ' : ''}${lines} · shift-click to extend`
  }

  function selectedFor(section: string): { path: string; side: Side; from: number; to: number } | undefined {
    const c = composing
    return c && c.section === section ? { path: c.path, side: c.side, from: c.from, to: c.to } : undefined
  }

  /** What main posts for this layer: drafts of this review's threads (`drafts` holds only those). */
  let toPost = $derived([...drafts.values()].filter((d) => d.url === layer.url).length)
  let readCount = $derived(tour ? tour.steps.filter((s) => readSet.has(s.id)).length : 0)

  const BTN = 'rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50'
  const PROSE = 'prose prose-invert prose-sm max-w-none text-[12.5px] leading-relaxed text-zinc-300 prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 prose-code:text-[11px]'
</script>

{#snippet card(t: ReviewThread)}
  <ReviewThreadCard {reviewId} thread={t} draft={drafts.get(t.id)} draftUrl={layer.url} {layers} {companionSessionId} {readonly} />
{/snippet}

{#snippet rowExtras(section: string, f: DiffFile, row: DiffRow)}
  {@const here = lineThreads.filter((t) => placement.get(t.id) === section && anchorEndsAt(t.anchor, layer.number, headSha, f, row))}
  {#if here.length || (composing && composing.section === section && composing.path === f.path && lineOn(row, composing.side) === composing.to && row.kind !== 'hunk')}
    <div class="flex flex-col gap-1.5 border-y border-zinc-800 bg-zinc-950 px-3 py-2 font-sans">
      {#each here as t (t.id)}{@render card(t)}{/each}
      {#if composing && composing.section === section && composing.path === f.path && lineOn(row, composing.side) === composing.to && row.kind !== 'hunk'}
        <ThreadComposer
          draftKey="line:{layer.url}:{composing.path}:{composing.side}:{composing.anchor}"
          label={composerLabel(composing)}
          onask={(text) => startLine(text, 'ask')}
          ondraft={(text) => startLine(text, 'draft')}
          oncancel={() => (composing = null)}
        />
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet diffOf(section: string, sectionFiles: DiffFile[])}
  {#snippet below(f: DiffFile, row: DiffRow, _i: number)}{@render rowExtras(section, f, row)}{/snippet}
  <UnifiedDiffView files={sectionFiles} onLineClick={readonly ? undefined : (f, row, _i, ev) => lineClick(section, f, row, ev)} belowRow={below} selectedRange={selectedFor(section)} />
{/snippet}

<section class="mt-8 scroll-mt-24" id="layer-{layer.number}" data-testid="layer-section">
  {#if since?.kind === 'ahead'}
    <div class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-[12px] text-blue-100" data-testid="since-banner">
      <b>{since.aheadBy} new commit{since.aheadBy === 1 ? '' : 's'} since you last looked</b>
      <span class="flex-1"></span>
      {#if sinceOnly}
        <button type="button" class={BTN} onclick={() => (sinceOnly = null)}>Show the whole layer</button>
      {:else}
        <button type="button" class="rounded-md bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500" onclick={showSince}>Show only the new changes</button>
      {/if}
      <button type="button" class="rounded px-2 py-1 text-xs text-blue-200 hover:bg-blue-500/20" onclick={gotIt}>Got it</button>
    </div>
  {:else if since?.kind === 'behind' || since?.kind === 'rewritten'}
    <div class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100" data-testid="since-banner">
      <b>{since.kind === 'behind' ? 'The branch was reset to an older commit since you last looked.' : 'History was rewritten since you last looked.'}</b>
      <span class="flex-1"></span>
      <button type="button" class="rounded px-2 py-1 text-xs text-amber-100 hover:bg-amber-500/20" onclick={gotIt}>Got it</button>
    </div>
  {/if}

  <div class="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
    <div class="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Layer · {layer.headRefName} → {layer.baseRefName}</div>
    <h2 class="mt-0.5 text-[15px] font-semibold text-zinc-100">#{layer.number} {layer.title}</h2>
    <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
      <span>by {layer.author}</span>
      {#if layer.isDraft}<span>draft</span>{/if}
      {#if layer.state !== 'OPEN'}<span class="text-amber-300/80">{layer.state.toLowerCase()}</span>{/if}
      <span class="tabular-nums"><b class="text-emerald-400">+{layer.additions}</b> <b class="text-red-400">−{layer.deletions}</b> · {layer.changedFiles} files</span>
      {#if tour}<span class="tabular-nums" data-testid="layer-read">{readCount}/{tour.steps.length} read</span>{/if}
      <span class="tabular-nums">{toPost} to post</span>
      <button type="button" class="text-blue-400 hover:underline" onclick={() => void window.api.invoke('app:open-external', layer.url)}>↗ open on GitHub</button>
    </div>

    {#if parsed && parsed.wellFormed}
      {#if overview?.headSha && overview.headSha !== headSha}
        <p class="mt-2 text-[10.5px] text-amber-300/80">Written for an earlier head; line citations may have moved.</p>
      {/if}
      <dl class="mt-2 grid max-w-[78ch] grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5" data-testid="layer-overview">
        <dt class="pt-px text-[11px] font-semibold text-zinc-500">What</dt>
        <dd class={PROSE}>{@html renderMarkdown(parsed.sections.what ?? '')}</dd>
        <dt class="pt-px text-[11px] font-semibold text-zinc-500">Why</dt>
        <dd class={PROSE}>{@html renderMarkdown(parsed.sections.why ?? '')}</dd>
        <dt class="pt-px text-[11px] font-semibold text-zinc-500">Impact</dt>
        <dd class={PROSE}>{@html renderMarkdown(parsed.sections.impact ?? '')}</dd>
      </dl>
    {:else if parsed}
      <div class="mt-2 {PROSE}" data-testid="layer-overview-raw">
        <p class="text-[10px] italic text-zinc-600">Unstructured output — shown as the model wrote it.</p>
        {@html renderMarkdown(parsed.raw)}
      </div>
    {/if}

    <div class="mt-3 flex flex-col gap-2 rounded-md border border-dashed border-zinc-700 px-3 py-2">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class={BTN} onclick={runOverview} disabled={overview?.status === 'running' || !diff} data-testid="run-overview">
          {#if overview?.status === 'running'}☰ Writing…{:else if overview?.status === 'done'}☰ Overview again{:else}☰ Overview{/if}
        </button>
        {#if overview?.status === 'running'}
          <button type="button" class="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800" onclick={() => screenPrsStore.cancelOverview(layer.url)}>Stop</button>
        {:else if overview?.status === 'error'}
          <span class="text-[11px] text-red-400">Overview failed: {overview.error}</span>
        {:else if !overview || overview.status === 'idle'}
          <span class="text-[11px] text-zinc-500">What / why / impact and a reading order for the diff.</span>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class={BTN} onclick={runDeep} disabled={deep?.status === 'running' || !diff} data-testid="run-deep">
          {#if deep?.status === 'running'}⚡ Running…{:else if deep?.status === 'done'}⚡ Deep review again{:else}⚡ Deep review{/if}
        </button>
        {#if deep?.status === 'running'}
          <button type="button" class="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800" onclick={() => screenPrsStore.cancelDeep(layer.url)}>Stop</button>
        {/if}
        {#each activeLenses as l (l)}
          {@const st = deep?.lenses[l]}
          <span class="rounded px-1.5 py-0.5 text-[9.5px] {st === 'done' ? 'bg-emerald-500/12 text-emerald-300' : st === 'error' ? 'bg-red-500/12 text-red-300' : 'bg-zinc-800 text-zinc-400'}">
            {st === 'done' ? '✓' : st === 'error' ? '✕' : '…'} {DEEP_LENS_LABEL[l]}
          </span>
        {/each}
        {#if deep?.status === 'error'}
          <span class="text-[11px] text-red-400">Deep review failed: {deep.error}</span>
        {:else if deep?.status === 'done'}
          <span class="text-[11px] text-zinc-500">Findings arrive as suggestions in their threads.</span>
        {:else if !deep || deep.status === 'idle'}
          <span class="text-[11px] text-zinc-500">The lenses on this layer's own commits. Findings arrive as suggestions.</span>
        {/if}
      </div>
    </div>

    {#if warning}
      <div class="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200" data-testid="base-warning">{warning}</div>
    {/if}

    {#if topThreads.length}
      <div class="mt-3 flex flex-col gap-2">
        {#each topThreads as t (t.id)}{@render card(t)}{/each}
      </div>
    {/if}
    {#if !readonly}
    <div class="mt-3">
      {#if composingPr}
        <ThreadComposer draftKey="pr:{layer.url}" label="On #{layer.number} as a whole" onask={(text) => startPr(text, 'ask')} ondraft={(text) => startPr(text, 'draft')} oncancel={() => (composingPr = false)} />
      {:else}
        <button type="button" class="rounded bg-violet-500/15 px-2.5 py-1 text-[11.5px] font-semibold text-violet-300 hover:bg-violet-500/25" onclick={() => (composingPr = true)}>
          Start a thread on this PR
        </button>
      {/if}
    </div>
    {/if}
  </div>

  <div class="mt-4">
    {#if diffError}
      <div class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300" data-testid="diff-error">Couldn’t load this layer’s diff: {diffError}</div>
    {:else if !diff}
      <div class="flex items-center gap-2 px-1 py-2 text-[11px] text-zinc-500">
        <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>Loading the diff…
      </div>
    {:else if sinceOnly}
      {#if 'error' in sinceOnly}
        <div class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">Couldn’t load the new changes: {sinceOnly.error}</div>
      {:else}
        <p class="mb-2 text-[11.5px] text-zinc-500">Only the commits since you last looked. Threads stay on the whole layer.</p>
        <UnifiedDiffView files={sinceOnly.files} emptyLabel="No changes." />
      {/if}
    {:else if tour}
      <ol class="ml-1.5 flex flex-col gap-5 border-l-2 border-zinc-800 pl-5" data-testid="tour">
        {#each tour.steps as step (step.id)}
          {@const read = readSet.has(step.id)}
          <li class="scroll-mt-24" id="step-{step.id}" data-testid="tour-step">
            <div class="mb-1 flex items-center gap-2.5">
              <button
                type="button"
                class="-ml-[1.95rem] flex h-5 w-5 flex-none items-center justify-center rounded border text-[11px] {read ? 'border-blue-500 bg-blue-600 text-white' : 'border-zinc-600 bg-zinc-900 text-transparent hover:border-zinc-400'}"
                aria-pressed={read}
                disabled={readonly}
                aria-label={read ? `Mark “${step.title}” as unread` : `Mark “${step.title}” as read`}
                onclick={() => void reviewRoom.markStep(reviewId, step.id, !read)}
              >✓</button>
              <h3 class="text-[13px] font-semibold text-zinc-100">{step.title}</h3>
            </div>
            {#if step.summary}<div class="mb-2 {PROSE} text-zinc-400">{@html renderMarkdown(step.summary)}</div>{/if}
            {#if step.files.length}
              {@render diffOf(step.id, step.files)}
            {:else}
              <p class="text-[11px] italic text-zinc-600">Cites nothing in this layer’s diff.</p>
            {/if}
          </li>
        {/each}
      </ol>
      {#if tour.rest.length}
        <h3 class="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wider text-zinc-500" data-testid="not-in-tour">Not in the tour</h3>
        {@render diffOf('rest', tour.rest)}
      {/if}
    {:else}
      <p class="mb-2 text-[11.5px] text-zinc-500">Files in path order. Run the overview to get a reading order.</p>
      {@render diffOf('all', byPath(files))}
    {/if}
  </div>
</section>
