<script lang="ts">
  /**
   * One layer of the stack on the phone: the desktop's `LayerSection` as part
   * of one scrolling page. Its header (what / why / impact once the overview
   * ran, else the author's briefing; the Overview and Deep review buttons; the
   * base warning; "since you last looked"), its PR-level threads, then its
   * diff as the reading order or in path order, with line threads under the
   * row they end on (`placeThreads`/`anchorEndsAt`, the desktop's mapping).
   *
   * The diff is this layer's review diff, fetched when the layer shows
   * (`review:layer-diff`), never pushed. Main cuts one too big for the socket;
   * then the layer can't be posted from here, since it wasn't read in full.
   *
   * A tap on a line opens the composer under it; a second tap on the same file
   * and side extends the range, as shift-click does at the desk.
   */
  import type { Review, ReviewThread, ReviewThreadAnchor } from '../shared/review-room'
  import type { ReviewLayerDiff, ReviewLayerInfo } from '../shared/review-room-ipc'
  import type { PrContext } from '../shared/screenprs'
  import { DEEP_LENS_LABEL, DEEP_LENS_ORDER, baseWarning } from '../shared/screenprs'
  import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../shared/parseDiff'
  import { parseOverview } from '../shared/pr-overview'
  import { DIFF_TRUNCATED_MARKER } from '../shared/ipc-types'
  import { tick } from 'svelte'
  import { screenPrsStore } from '../renderer/stores/screenprs.svelte'
  import { reviewRoom } from '../renderer/stores/reviewRoom.svelte'
  import { renderMarkdown } from '../renderer/lib/markdown'
  import {
    anchorEndsAt,
    anchorText,
    buildTour,
    byPath,
    lineOn,
    placeThreads,
    sideOf,
    tourSteps,
    unreadReason,
    type Section,
    type Side,
    type ThreadDraft,
  } from '../renderer/lib/review-room'
  import MobileDiff from './MobileDiff.svelte'
  import RoomThreadCard from './RoomThreadCard.svelte'
  import RoomComposer from './RoomComposer.svelte'

  interface Props {
    reviewId: string
    review: Review
    layer: ReviewLayerInfo
    /** Bottom → top. */
    layers: ReviewLayerInfo[]
    /** This layer's PR-level and line threads. */
    threads: ReviewThread[]
    drafts: Map<string, ThreadDraft>
    companionSessionId?: string
    readonly?: boolean
    requesterSessionId?: string
    askBlocked?: string | null
    connected: boolean
    visible: boolean
  }

  let { reviewId, review, layer, layers, threads, drafts, companionSessionId, readonly = false, requesterSessionId, askBlocked = null, connected, visible }: Props = $props()

  // ── The diff and "since you last looked" ──
  let diff = $derived(reviewRoom.layerDiff(reviewId, layer.url))
  let diffError = $state<string | null>(null)
  let since = $derived(reviewRoom.since(reviewId, layer.url))

  let layerUrl = $derived(layer.url)
  let layerHead = $derived(layer.headSha)
  $effect(() => {
    const url = layerUrl
    void layerHead // a pushed head means a new diff
    // Asked once the socket is up; a reconnect asks again for a diff that failed.
    if (!connected) return
    if (reviewRoom.layerDiff(reviewId, url)?.headSha === layerHead) return
    diffError = null
    reviewRoom.loadLayerDiff(reviewId, url).catch((err: unknown) => {
      diffError = err instanceof Error ? err.message : String(err)
    })
    void reviewRoom.loadSince(reviewId, url)
  })

  let headSha = $derived(diff?.headSha ?? layer.headSha)
  let files = $derived<DiffFile[]>(diff ? parseUnifiedDiff(diff.diff) : [])
  let truncated = $derived(unreadReason(layer, diff) === 'truncated')

  let sinceOnly = $state<{ diff: string } | { error: string } | null>(null)
  async function showSince(): Promise<void> {
    try {
      sinceOnly = { diff: await reviewRoom.sinceDiff(reviewId, layer.url) }
    } catch (err) {
      sinceOnly = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  async function gotIt(): Promise<void> {
    sinceOnly = null
    await reviewRoom.ackHead(reviewId, layer.url).catch((err: unknown) => console.warn('[review] ack-head failed:', err))
  }

  // ── Overview, deep review and the author's briefing ──
  let overview = $derived(screenPrsStore.overviewFor(layer.url))
  let deep = $derived(screenPrsStore.deepFor(layer.url))
  let parsed = $derived(overview?.status === 'done' && overview.text ? parseOverview(overview.text) : null)
  let briefing = $derived(review.authorBriefing?.layers[layer.url])
  let stackSummary = $derived(review.authorBriefing?.stack?.summary)
  let briefingStale = $derived(!!briefing && briefing.forHead !== layer.headSha)
  let showBriefing = $state(false)
  let showEvidence = $state(false)
  let tourBy = $derived(tourSteps(overview?.status === 'done' ? overview.text : undefined, briefing))
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

  // A cut diff would brief the model on part of the layer: run those at the desk.
  let canRun = $derived(!!diff && !truncated && connected)
  let warning = $derived(baseWarning({ base: diff?.base ?? layer.base, baseRefName: layer.baseRefName, changedFiles: layer.changedFiles }))

  // ── Sections: the tour, then what it leaves out; or path order ──
  let tour = $derived(tourBy.steps.length ? buildTour(layer.number, tourBy.steps, files) : null)
  let sections = $derived<Section[]>(
    tour ? [...tour.steps.map((s) => ({ key: s.id, files: s.files })), { key: 'rest', files: tour.rest }] : [{ key: 'all', files: byPath(files) }],
  )
  let lineThreads = $derived(threads.filter((t) => t.anchor.kind === 'line'))
  let placement = $derived(placeThreads(lineThreads, layer.number, headSha, sections))
  let topThreads = $derived(threads.filter((t) => t.anchor.kind === 'pr' || !placement.has(t.id)))
  let readSet = $derived(new Set(review.readSteps))
  let readCount = $derived(tour ? tour.steps.filter((s) => readSet.has(s.id)).length : 0)
  let toPost = $derived([...drafts.values()].filter((d) => d.url === layer.url).length)

  /** Each section's diff, so a thread in a collapsed file can be revealed. */
  let sectionDiffs = $state<Record<string, MobileDiff>>({})

  /**
   * Bring a thread on screen: opens its file (a big diff starts collapsed)
   * and scrolls to its card. False when this layer doesn't show it.
   */
  export async function revealThread(threadId: string): Promise<boolean> {
    const t = threads.find((x) => x.id === threadId)
    if (!t) return false
    const section = placement.get(threadId)
    if (section && t.anchor.kind === 'line') {
      // `reveal` counts in new-file numbers; a deleted line has none, so its file header serves.
      await sectionDiffs[section]?.reveal(t.anchor.path, t.anchor.side === 'RIGHT' ? t.anchor.endLine : undefined)
    }
    await tick()
    const card = document.getElementById(`room-thread-${threadId}`)
    card?.scrollIntoView({ block: 'center' })
    return !!card
  }

  // ── New threads ──
  interface Composing {
    section: string
    path: string
    side: Side
    anchor: number
    from: number
    to: number
  }
  let composing = $state<Composing | null>(null)
  let composingPr = $state(false)

  function tap(section: string, f: DiffFile, row: DiffRow): void {
    const side = sideOf(row)
    const n = lineOn(row, side)
    if (n === undefined) return
    const c = composing
    if (c && c.section === section && c.path === f.path && c.side === side && n !== c.anchor) {
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
    return `${c.path.split('/').pop()} · ${c.side === 'LEFT' ? 'deleted ' : ''}${lines} · tap another line to extend`
  }

  function composerSnippet(c: Composing): string {
    const full = files.find((f) => f.path === c.path)
    return full ? anchorText(full, c.side, c.from, c.to).snippet : ''
  }

  const composerHere = (section: string, f: DiffFile, row: DiffRow): boolean =>
    !!composing && composing.section === section && composing.path === f.path && row.kind !== 'hunk' && sideOf(row) === composing.side && lineOn(row, composing.side) === composing.to

  const BTN = 'min-h-10 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-[13px] font-medium text-zinc-200 active:bg-zinc-700 disabled:opacity-40'
  const PROSE = 'prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed text-zinc-300 prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 prose-code:text-[12px]'
</script>

{#snippet card(t: ReviewThread)}
  <RoomThreadCard {reviewId} thread={t} draft={drafts.get(t.id)} draftUrl={layer.url} {layers} {companionSessionId} {readonly} {requesterSessionId} {askBlocked} {visible} />
{/snippet}

{#snippet diffOf(section: string, sectionFiles: DiffFile[])}
  {#snippet below(f: DiffFile, row: DiffRow)}
    {@const here = lineThreads.filter((t) => placement.get(t.id) === section && anchorEndsAt(t.anchor, layer.number, headSha, f, row))}
    {#if here.length || composerHere(section, f, row)}
      <div class="flex flex-col gap-2 border-y border-zinc-800 bg-zinc-950 px-2 py-2 font-sans">
        {#each here as t (t.id)}{@render card(t)}{/each}
        {#if composing && composerHere(section, f, row)}
          <RoomComposer
            draftKey="line:{layer.url}:{composing.path}:{composing.side}:{composing.anchor}"
            label={composerLabel(composing)}
            snippet={composerSnippet(composing)}
            {askBlocked}
            onask={(text) => startLine(text, 'ask')}
            ondraft={(text) => startLine(text, 'draft')}
            oncancel={() => (composing = null)}
          />
        {/if}
      </div>
    {/if}
  {/snippet}
  <MobileDiff bind:this={sectionDiffs[section]} files={sectionFiles} testid="room-diff" ontap={readonly ? undefined : (f, row) => tap(section, f, row)} {below} />
{/snippet}

{#snippet authorBriefing(b: NonNullable<typeof briefing>)}
  <div class="mt-2" data-testid="layer-briefing">
    <div class="text-[11px] font-semibold uppercase tracking-wider text-violet-300">By the author</div>
    {#if briefingStale}<p class="text-[11px] text-amber-300/80">Written for an earlier head; it may not describe what is there now.</p>{/if}
    {#if stackSummary}<div class="mt-1 {PROSE}"><b class="text-zinc-500">Stack</b> {@html renderMarkdown(stackSummary)}</div>{/if}
    {#if b.what}<div class="mt-1 {PROSE}"><b class="text-zinc-500">What</b> {@html renderMarkdown(b.what)}</div>{/if}
    {#if b.why}<div class="mt-1 {PROSE}"><b class="text-zinc-500">Why</b> {@html renderMarkdown(b.why)}</div>{/if}
    {#if b.impact}<div class="mt-1 {PROSE}"><b class="text-zinc-500">Impact</b> {@html renderMarkdown(b.impact)}</div>{/if}
  </div>
{/snippet}

<section class="mt-6 scroll-mt-16" id="room-layer-{layer.number}" data-testid="room-layer">
  {#if since?.kind === 'ahead'}
    <div class="mb-3 flex flex-col gap-2 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-2.5 text-[13px] text-blue-100" data-testid="since-banner">
      <b>{since.aheadBy} new commit{since.aheadBy === 1 ? '' : 's'} since you last looked</b>
      <div class="flex flex-wrap gap-2">
        {#if sinceOnly}
          <button type="button" class={BTN} onclick={() => (sinceOnly = null)}>Show the whole layer</button>
        {:else}
          <button type="button" class="min-h-10 rounded-lg bg-blue-600 px-3 text-[13px] text-white" disabled={!connected} onclick={showSince}>Only the new changes</button>
        {/if}
        <button type="button" class="min-h-10 px-3 text-[13px] text-blue-200" onclick={gotIt}>Got it</button>
      </div>
    </div>
  {:else if since?.kind === 'behind' || since?.kind === 'rewritten'}
    <div class="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[13px] text-amber-100" data-testid="since-banner">
      <b class="flex-1">{since.kind === 'behind' ? 'The branch was reset to an older commit since you last looked.' : 'History was rewritten since you last looked.'}</b>
      <button type="button" class="min-h-10 px-3 text-[13px]" onclick={gotIt}>Got it</button>
    </div>
  {/if}

  <div class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-3">
    <div class="truncate text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Layer · {layer.headRefName} → {layer.baseRefName}</div>
    <h2 class="mt-0.5 text-[15px] font-semibold leading-snug text-zinc-100">#{layer.number} {layer.title}</h2>
    <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-zinc-500">
      <span>by {layer.author}</span>
      {#if layer.isDraft}<span>draft</span>{/if}
      {#if layer.state !== 'OPEN'}<span class="text-amber-300/80">{layer.state.toLowerCase()}</span>{/if}
      <span class="tabular-nums"><b class="text-emerald-400">+{layer.additions}</b> <b class="text-red-400">−{layer.deletions}</b> · {layer.changedFiles} files</span>
      {#if tour}<span class="tabular-nums" data-testid="layer-read">{readCount}/{tour.steps.length} read</span>{/if}
      <span class="tabular-nums">{toPost} to post</span>
      <a class="text-blue-400" href={layer.url} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
    </div>

    {#if parsed && parsed.wellFormed}
      {#if overview?.headSha && overview.headSha !== headSha}
        <p class="mt-2 text-[11px] text-amber-300/80">Written for an earlier head; line citations may have moved.</p>
      {/if}
      <div class="mt-2 flex flex-col gap-1.5" data-testid="layer-overview">
        <div class={PROSE}><b class="text-zinc-500">What</b> {@html renderMarkdown(parsed.sections.what ?? '')}</div>
        <div class={PROSE}><b class="text-zinc-500">Why</b> {@html renderMarkdown(parsed.sections.why ?? '')}</div>
        <div class={PROSE}><b class="text-zinc-500">Impact</b> {@html renderMarkdown(parsed.sections.impact ?? '')}</div>
      </div>
    {:else if parsed}
      <div class="mt-2 {PROSE}" data-testid="layer-overview-raw">
        <p class="text-[11px] italic text-zinc-600">Unstructured output — shown as the model wrote it.</p>
        {@html renderMarkdown(parsed.raw)}
      </div>
    {/if}

    {#if briefing}
      {#if !parsed}
        {@render authorBriefing(briefing)}
      {:else}
        <button type="button" class="mt-2 min-h-9 text-[13px] text-violet-300" aria-expanded={showBriefing} onclick={() => (showBriefing = !showBriefing)}>
          {showBriefing ? '▾' : '▸'} Author's briefing
        </button>
        {#if showBriefing}{@render authorBriefing(briefing)}{/if}
      {/if}
      <div class="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2" data-testid="author-evidence">
        <button type="button" class="flex min-h-8 w-full items-center gap-2 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500" aria-expanded={showEvidence} onclick={() => (showEvidence = !showEvidence)}>
          {showEvidence ? '▾' : '▸'} Author ran ({briefing.evidence.length})
          <span class="font-normal normal-case tracking-normal text-zinc-600">· not verified by SimpleEdit</span>
        </button>
        {#if !briefing.evidence.length}
          <p class="mt-1 text-[12px] text-amber-300/80">No evidence attached: claims of passing tests or builds are unbacked.</p>
        {:else if showEvidence}
          <ul class="mt-1 flex flex-col gap-1.5">
            {#each briefing.evidence as e, i (i)}
              <li class="text-[12px]">
                <code class="break-all text-zinc-200">{e.command}</code>
                {#if e.exitCode !== undefined}<span class="ml-1.5 rounded px-1 text-[10.5px] {e.exitCode === 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}">exit {e.exitCode}</span>{/if}
                {#if e.outputExcerpt}<pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400">{e.outputExcerpt}</pre>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    <div class="mt-3 flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class={BTN} onclick={() => diff && void screenPrsStore.startOverview(prContext(diff))} disabled={overview?.status === 'running' || !canRun} data-testid="run-overview">
          {#if overview?.status === 'running'}☰ Writing…{:else if overview?.status === 'done'}☰ Overview again{:else}☰ Overview{/if}
        </button>
        {#if overview?.status === 'running'}
          <button type="button" class={BTN} onclick={() => screenPrsStore.cancelOverview(layer.url)}>Stop</button>
        {:else if overview?.status === 'error'}
          <span class="text-[12px] text-red-400">Overview failed: {overview.error}</span>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class={BTN} onclick={() => diff && void screenPrsStore.startDeep(prContext(diff))} disabled={deep?.status === 'running' || !canRun} data-testid="run-deep">
          {#if deep?.status === 'running'}⚡ Running…{:else if deep?.status === 'done'}⚡ Deep review again{:else}⚡ Deep review{/if}
        </button>
        {#if deep?.status === 'running'}
          <button type="button" class={BTN} onclick={() => screenPrsStore.cancelDeep(layer.url)}>Stop</button>
        {/if}
        {#each activeLenses as l (l)}
          {@const st = deep?.lenses[l]}
          <span class="rounded px-1.5 py-0.5 text-[11px] {st === 'done' ? 'bg-emerald-500/12 text-emerald-300' : st === 'error' ? 'bg-red-500/12 text-red-300' : 'bg-zinc-800 text-zinc-400'}">
            {st === 'done' ? '✓' : st === 'error' ? '✕' : '…'} {DEEP_LENS_LABEL[l]}
          </span>
        {/each}
        {#if deep?.status === 'error'}<span class="text-[12px] text-red-400">Deep review failed: {deep.error}</span>{/if}
      </div>
      {#if truncated}<p class="text-[12px] text-zinc-500">Overview and deep review run at the desk for a layer this big.</p>{/if}
    </div>

    {#if warning}
      <div class="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200" data-testid="base-warning">{warning}</div>
    {/if}

    {#if topThreads.length}
      <div class="mt-3 flex flex-col gap-2">
        {#each topThreads as t (t.id)}{@render card(t)}{/each}
      </div>
    {/if}
    {#if !readonly}
      <div class="mt-3">
        {#if composingPr}
          <RoomComposer draftKey="pr:{layer.url}" label="On #{layer.number} as a whole" {askBlocked} onask={(text) => startPr(text, 'ask')} ondraft={(text) => startPr(text, 'draft')} oncancel={() => (composingPr = false)} />
        {:else}
          <button type="button" class="min-h-10 rounded-lg bg-violet-500/15 px-3 text-[13px] font-semibold text-violet-300" onclick={() => (composingPr = true)}>
            Start a thread on this PR
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="-mx-3 mt-2">
    {#if diffError}
      <div class="mx-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300" data-testid="diff-error">Couldn’t load this layer’s diff: {diffError}</div>
    {:else if !diff}
      <div class="mx-3 flex items-center gap-2 py-2 text-[12px] text-zinc-500" data-testid="diff-loading">
        <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>{connected ? 'Loading the diff…' : 'Waiting for the connection to load the diff…'}
      </div>
    {:else}
      {#if truncated}
        <p class="mx-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200" data-testid="diff-truncated">
          This layer’s diff is too big for the phone; only its start is shown. Read and post it at the desk.
        </p>
      {/if}
      {#if sinceOnly}
        {#if 'error' in sinceOnly}
          <div class="mx-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">Couldn’t load the new changes: {sinceOnly.error}</div>
        {:else}
          <p class="mx-3 text-[12px] text-zinc-500">Only the commits since you last looked. Threads stay on the whole layer.</p>
          {#if sinceOnly.diff.trimEnd().endsWith(DIFF_TRUNCATED_MARKER)}
            <p class="mx-3 mt-1 text-[12px] text-amber-300/90">Cut for the phone: read the rest at the desk before you tap Got it.</p>
          {/if}
          <MobileDiff diff={sinceOnly.diff} testid="room-since-diff" />
        {/if}
      {:else if tour}
        {#if tourBy.by === 'author'}<p class="mx-3 text-[12px] text-violet-300/80" data-testid="author-tour">The author’s reading order. Run the overview for an independent one.</p>{/if}
        <ol class="flex flex-col gap-4" data-testid="tour">
          {#each tour.steps as step (step.id)}
            {@const read = readSet.has(step.id)}
            <li class="scroll-mt-16" id="room-step-{step.id}" data-testid="tour-step">
              <div class="mx-3 flex items-center gap-2.5">
                <button
                  type="button"
                  class="flex h-8 w-8 flex-none items-center justify-center rounded-lg border text-[13px] {read ? 'border-blue-500 bg-blue-600 text-white' : 'border-zinc-600 bg-zinc-900 text-transparent'}"
                  aria-pressed={read}
                  disabled={readonly}
                  aria-label={read ? `Mark “${step.title}” as unread` : `Mark “${step.title}” as read`}
                  onclick={() => void reviewRoom.markStep(reviewId, step.id, !read)}
                >✓</button>
                <h3 class="text-[14px] font-semibold text-zinc-100">{step.title}</h3>
              </div>
              {#if step.summary}<div class="mx-3 mt-1 {PROSE} text-zinc-400">{@html renderMarkdown(step.summary)}</div>{/if}
              {#if step.files.length}
                {@render diffOf(step.id, step.files)}
              {:else}
                <p class="mx-3 mt-1 text-[12px] italic text-zinc-600">Cites nothing in this layer’s diff.</p>
              {/if}
            </li>
          {/each}
        </ol>
        {#if tour.rest.length}
          <h3 class="mx-3 mt-5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500" data-testid="not-in-tour">{tourBy.by === 'author' ? 'Not in the author’s tour' : 'Not in the tour'}</h3>
          {@render diffOf('rest', tour.rest)}
        {/if}
      {:else}
        <p class="mx-3 text-[12px] text-zinc-500">Files in path order. Run the overview to get a reading order.</p>
        {@render diffOf('all', byPath(files))}
      {/if}
    {/if}
  </div>
</section>
