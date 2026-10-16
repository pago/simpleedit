<script lang="ts">
  /**
   * The Review Room on the phone: one review of a stack as one scrolling page.
   * Banners (closed, handed back, requested, rounds), the whole-stack threads,
   * then each layer bottom → top (`ReviewLayer`), and a bar at the bottom with
   * the companion's status, what is to post, the outline and Submit. The
   * outline and the submit sheet are overlays on the PRs stack, so Back closes
   * them.
   *
   * **No terminal.** The companion is a session in a desktop window. A
   * question goes to main, which starts the companion in the window this
   * phone's socket joined when none runs, and types it in when the companion
   * can take it. "Needs you" (a permission prompt in its terminal) can only be
   * answered on the Mac, so the bar says so.
   */
  import { tick, untrack } from 'svelte'
  import type { ReviewThreadAnchor } from '../shared/review-room'
  import { reviewRoom } from '../renderer/stores/reviewRoom.svelte'
  import { screenPrsStore } from '../renderer/stores/screenprs.svelte'
  import { readingProgress, reportMarkdown, reviewDrafts, tourSteps } from '../renderer/lib/review-room'
  import { nav } from './lib/nav.svelte'
  import { companionLine, companionState, reviewSubmits } from './lib/review-phone.svelte'
  import { copyText } from './lib/copy-text'
  import ReviewLayer from './ReviewLayer.svelte'
  import RoomThreadCard, { expandRoomThread } from './RoomThreadCard.svelte'
  import RoomComposer from './RoomComposer.svelte'
  import ReviewOutlineSheet from './ReviewOutlineSheet.svelte'
  import ReviewSubmitSheet from './ReviewSubmitSheet.svelte'

  interface Props {
    /** The PR the room was opened on; main resolves its stack. */
    url: string
    connected: boolean
    /** This screen is the one on top of the PRs tab. */
    visible: boolean
    /**
     * Why the window this phone is joined to can't host a companion (it has
     * no project open), or null. A companion already running elsewhere
     * answers anyway.
     */
    hostBlocked: string | null
  }

  let { url, connected, visible, hostBlocked }: Props = $props()

  // ── Opening ──
  let openState = $derived(reviewRoom.openState(url))
  $effect(() => {
    if (!connected) return
    const prior = untrack(() => reviewRoom.openState(url))
    if (!prior || prior.status === 'error') void reviewRoom.open(url)
  })
  let reviewId = $derived(openState?.status === 'ready' ? openState.reviewId : null)
  let review = $derived(reviewId ? reviewRoom.review(reviewId) : undefined)
  let layers = $derived(reviewId ? reviewRoom.layers(reviewId) : [])
  let top = $derived(layers.at(-1))
  let threads = $derived(reviewId ? reviewRoom.threadsFor(reviewId) : [])
  let stackThreads = $derived(threads.filter((t) => t.anchor.kind === 'stack'))
  let readonly = $derived(review?.status !== 'open')
  let drafts = $derived(
    reviewDrafts(
      threads,
      layers.map((l) => l.url),
      (u) => screenPrsStore.draftFor(u),
    ),
  )
  let reading = $derived(
    new Map(
      layers.map((l) => {
        const o = screenPrsStore.overviewFor(l.url)
        const { steps } = tourSteps(o?.status === 'done' ? o.text : undefined, review?.authorBriefing?.layers[l.url])
        return [l.url, readingProgress(l.number, steps, review?.readSteps ?? [])]
      }),
    ),
  )
  let toPost = $derived(drafts.size)
  let openCount = $derived(threads.filter((t) => t.status === 'open').length)

  // ── The requesting session ──
  let requesterId = $derived(review?.requesterSessionId)
  let requester = $derived(reviewId ? reviewRoom.requester(reviewId) : undefined)
  let requesterLive = $derived(!!requester?.live)
  $effect(() => {
    if (!requesterId || !reviewId || !visible || !connected) return
    const id = reviewId
    void reviewRoom.loadRequester(id)
    const timer = setInterval(() => void reviewRoom.loadRequester(id), 15_000)
    return () => clearInterval(timer)
  })

  // ── The companion ──
  let companionSessionId = $derived(review?.companion?.sessionId)
  $effect(() => {
    void companionSessionId // a new claim, or none
    if (reviewId && connected && visible) void companionState.load(reviewId)
  })
  let companionInfo = $derived(reviewId ? companionState.info(reviewId) : undefined)
  let companionLive = $derived(!!companionInfo?.live && companionInfo.sessionId === companionSessionId)
  let line = $derived(review ? companionLine(review, companionInfo, companionSessionId ? companionState.status(companionSessionId) : undefined) : null)
  /** Why Ask can't go now: offline, or no companion runs and this phone's window can't start one. */
  let askBlocked = $derived(!connected ? 'Not connected to the Mac.' : companionLive ? null : hostBlocked)
  let starting = $state(false)
  let startError = $state<string | null>(null)
  async function startCompanion(): Promise<void> {
    if (!reviewId || starting) return
    starting = true
    startError = null
    try {
      await window.api.invoke('review:companion-start', reviewId)
      await companionState.load(reviewId)
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err)
    }
    starting = false
  }

  // ── Hand-back ──
  let handBack = $derived(review?.handBack)
  let retryingHandBack = $state(false)
  let copiedReport = $state(false)
  async function copyReport(): Promise<void> {
    const report = [...(review?.submissions ?? [])].reverse().find((s) => s.report)?.report
    if (!report) return
    await copyText(reportMarkdown(report))
    copiedReport = true
  }
  async function retryHandBack(): Promise<void> {
    if (!handBack) return
    retryingHandBack = true
    try {
      await window.api.invoke('agent-threads:retry', handBack.sessionId, handBack.id)
    } finally {
      retryingHandBack = false
    }
  }

  // ── Whole-stack threads ──
  let composingStack = $state(false)
  async function startStack(text: string, mode: 'ask' | 'draft'): Promise<void> {
    if (!reviewId) return
    const anchor: ReviewThreadAnchor = { kind: 'stack' }
    if (mode === 'ask') await reviewRoom.addThread(reviewId, anchor, text)
    else if (top) await reviewRoom.addDraftThread(reviewId, anchor, top.url, text)
    composingStack = false
  }

  // ── Overlays ──
  let outlineId = $state<number | null>(null)
  let submitId = $state<number | null>(null)
  let submitSheet = $state<ReviewSubmitSheet>()
  let layerRefs = $state<Record<string, ReviewLayer>>({})

  function openOutline(): void {
    outlineId = nav.push({ kind: 'review-outline', url }).id
  }
  function openSubmit(): void {
    submitId = nav.push({ kind: 'review-submit', url }, () => submitSheet?.holdForDraft() ?? false).id
  }
  function closeOverlay(id: number | null): void {
    if (id !== null && nav.has(id)) nav.close(id)
  }

  async function focusThread(threadId: string): Promise<void> {
    closeOverlay(outlineId)
    expandRoomThread(threadId)
    await tick()
    for (const l of layers) if (await layerRefs[l.url]?.revealThread(threadId)) return
    document.getElementById(`room-thread-${threadId}`)?.scrollIntoView({ block: 'center' })
  }
  async function focusStep(stepId: string): Promise<void> {
    closeOverlay(outlineId)
    await tick()
    document.getElementById(`room-step-${stepId}`)?.scrollIntoView({ block: 'start' })
  }

  const TONE = { muted: 'text-zinc-500', ok: 'text-emerald-300', busy: 'text-blue-300', 'needs-you': 'text-amber-300', error: 'text-red-300' } as const
</script>

{#if !openState || openState.status === 'loading' || (openState.status === 'ready' && !review)}
  <div class="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500" data-testid="room-loading">
    <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>{connected ? 'Opening the review…' : 'Waiting for the connection…'}
  </div>
{:else if openState.status === 'error'}
  <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="room-error">
    <p class="text-sm text-red-300">Couldn’t open the review: {openState.error}</p>
    <button type="button" class="min-h-10 rounded-lg border border-zinc-700 px-4 text-sm text-zinc-200" disabled={!connected} onclick={() => void reviewRoom.open(url)}>Try again</button>
  </div>
{:else if review && reviewId}
  <div class="flex min-h-0 flex-1 flex-col" data-testid="review-screen">
    <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3">
      <div class="mb-3 flex flex-wrap gap-1.5 text-[12px]" data-testid="stack-map">
        {#each layers as l, i (l.url)}
          <a href="#room-layer-{l.number}" class="rounded-full border border-zinc-700 px-2.5 py-1 text-zinc-300" onclick={(e) => { e.preventDefault(); document.getElementById(`room-layer-${l.number}`)?.scrollIntoView({ block: 'start' }) }}>
            {i > 0 ? '→ ' : ''}#{l.number}
          </a>
        {/each}
      </div>

      {#if review.status !== 'open'}
        <div class="mb-3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[13px] text-zinc-300">This review was {review.status}. Its threads and drafts stay readable here.</div>
      {/if}
      {#if handBack}
        {@const failed = handBack.delivery === 'failed' || handBack.delivery === 'unanswered'}
        <div class="mb-3 flex flex-col gap-2 rounded-lg border px-3 py-2 text-[13px] {failed ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-zinc-700 bg-zinc-900 text-zinc-300'}" data-testid="hand-back">
          {#if handBack.delivery === 'delivered' || handBack.delivery === 'answered' || handBack.delivery === 'answered-implicitly'}
            Sent back to the requesting session.
          {:else if failed}
            <span>Not received by the requesting session{handBack.failedReason ? `: ${handBack.failedReason}` : ''}.</span>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="min-h-9 rounded-lg border border-red-400/40 px-3 disabled:opacity-50" disabled={!requesterLive || retryingHandBack || !connected} onclick={retryHandBack}>Retry</button>
              <button type="button" class="min-h-9 rounded-lg border border-red-400/40 px-3" onclick={() => void copyReport()}>{copiedReport ? 'Copied' : 'Copy review as markdown'}</button>
            </div>
          {:else}
            Waiting to hand the review back to the requesting session…
          {/if}
        </div>
      {/if}
      {#if review.requesterSessionId && review.status === 'open'}
        <div class="mb-3 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-[13px] text-violet-100" data-testid="requested-banner">
          <b>Requested by an agent session.</b>
          {requesterLive ? 'Submit sends your review back to it; threads can Ask author.' : 'That session has ended: the review can still be posted to GitHub.'}
        </div>
      {/if}
      {#if review.round >= 3}
        <div class="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-100" data-testid="convergence-warning">
          Round {review.round} on this stack: consider whether the approach needs rethinking.
        </div>
      {:else if review.round === 2}
        <div class="mb-3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[13px] text-zinc-300" data-testid="round-banner">
          Round 2 on this stack. Threads from round 1 carried over.
        </div>
      {/if}

      {#if layers.length > 1 || stackThreads.length}
        <section class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-3" data-testid="stack-section">
          <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Stack · {layers.length} PRs, review bottom → top</div>
          {#if stackThreads.length}
            <div class="mt-2 flex flex-col gap-2">
              {#each stackThreads as t (t.id)}
                <RoomThreadCard {reviewId} thread={t} draft={drafts.get(t.id)} draftUrl={top?.url ?? ''} {layers} {companionSessionId} {readonly} requesterSessionId={requesterLive ? requesterId : undefined} {askBlocked} {visible} />
              {/each}
            </div>
          {/if}
          {#if !readonly}
            <div class="mt-3">
              {#if composingStack}
                <RoomComposer draftKey="stack:{reviewId}" label="On the whole stack · a comment posts on the top layer unless you pick another" {askBlocked} onask={(text) => startStack(text, 'ask')} ondraft={(text) => startStack(text, 'draft')} oncancel={() => (composingStack = false)} />
              {:else}
                <button type="button" class="min-h-10 rounded-lg bg-violet-500/15 px-3 text-[13px] font-semibold text-violet-300" onclick={() => (composingStack = true)}>Ask about the stack</button>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      {#each layers as layer (layer.url)}
        <ReviewLayer
          bind:this={layerRefs[layer.url]}
          {reviewId}
          {review}
          {layer}
          {layers}
          threads={threads.filter((t) => t.anchor.kind !== 'stack' && t.anchor.pr === layer.number)}
          {drafts}
          {companionSessionId}
          {readonly}
          requesterSessionId={requesterLive ? requesterId : undefined}
          {askBlocked}
          {connected}
          {visible}
        />
      {/each}
    </div>

    <div class="flex-none border-t border-zinc-800 bg-zinc-900 px-3 pt-2 pb-2" data-testid="room-bar">
      {#if line}
        <div class="mb-2 flex items-center gap-2 text-[12px]" data-testid="companion-line">
          <span class="min-w-0 flex-1 {TONE[line.tone]}">{line.text}</span>
          {#if line.canStart && !readonly}
            <button type="button" class="min-h-9 flex-none rounded-lg border border-zinc-700 px-3 text-[12px] text-zinc-200 disabled:opacity-40" disabled={starting || !!askBlocked} data-testid="start-companion" onclick={startCompanion}>
              {starting ? 'Starting…' : 'Start new'}
            </button>
          {/if}
        </div>
        {#if startError}<p class="mb-2 text-[12px] text-red-300" role="alert">{startError}</p>{/if}
      {/if}
      <div class="flex items-center gap-2">
        <button type="button" class="min-h-10 flex-none rounded-lg border border-zinc-700 px-3 text-[13px] text-zinc-200" data-testid="open-outline" onclick={openOutline}>Outline · {openCount} open</button>
        <span class="min-w-0 flex-1 truncate text-right text-[12px] tabular-nums text-zinc-500">{toPost} to post</span>
        <button
          type="button"
          class="min-h-10 flex-none rounded-lg bg-blue-600 px-4 text-[13px] font-semibold text-white active:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500"
          disabled={review.status !== 'open'}
          data-testid="open-submit"
          onclick={openSubmit}
        >{reviewSubmits.inFlight(reviewId) ? 'Posting…' : 'Submit…'}</button>
      </div>
    </div>
  </div>

  {#if nav.has(outlineId)}
    <ReviewOutlineSheet {layers} {threads} {drafts} {reading} onthread={(id) => void focusThread(id)} onstep={(id) => void focusStep(id)} onclose={() => closeOverlay(outlineId)} />
  {/if}
  {#if nav.has(submitId)}
    <ReviewSubmitSheet bind:this={submitSheet} {reviewId} {layers} {requesterLive} {connected} onclose={() => closeOverlay(submitId)} />
  {/if}
{/if}
