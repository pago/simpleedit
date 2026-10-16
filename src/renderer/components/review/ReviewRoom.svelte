<script lang="ts">
  /**
   * The Review Room: one review of a stack. The stack map on top, the review
   * as one document (whole-stack threads, then each layer bottom → top), the
   * outline on the right (a drawer when the room is narrow), and at the
   * bottom the post bar, the companion bar and its terminal, in that order.
   */
  import { tick } from 'svelte'
  import type { ReviewThreadAnchor } from '../../../shared/review-room'
  import type { PrReviewComment } from '../../../shared/screenprs'
  import { reviewRoom } from '../../stores/reviewRoom.svelte'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { scrollBehavior } from '../../lib/diffReveal'
  import { readingOrderOf, readingProgress, type LayerFigures } from '../../lib/review-room'
  import StackMap from './StackMap.svelte'
  import LayerSection from './LayerSection.svelte'
  import ReviewOutline from './ReviewOutline.svelte'
  import ReviewThreadCard, { expandThread } from './ReviewThreadCard.svelte'
  import ThreadComposer from './ThreadComposer.svelte'
  import CompanionDock from './CompanionDock.svelte'
  import SubmitReviewsModal from './SubmitReviewsModal.svelte'

  let { reviewId }: { reviewId: string } = $props()

  let review = $derived(reviewRoom.review(reviewId))
  let layers = $derived(reviewRoom.layers(reviewId))
  let top = $derived(layers.at(-1))
  let threads = $derived(reviewRoom.threadsFor(reviewId))
  let stackThreads = $derived(threads.filter((t) => t.anchor.kind === 'stack'))
  let readonly = $derived(review?.status !== 'open')

  /**
   * Each of this review's threads' draft: the draft store's `threadId` is the
   * only link. These are exactly what main posts per layer (with its summary);
   * other comments in a layer's draft are left alone.
   */
  let drafts = $derived.by(() => {
    const ids = new Set(threads.map((t) => t.id))
    const out = new Map<string, { url: string; comment: PrReviewComment }>()
    for (const l of layers) {
      for (const c of screenPrsStore.draftFor(l.url).comments) if (c.threadId && ids.has(c.threadId)) out.set(c.threadId, { url: l.url, comment: c })
    }
    return out
  })

  let reading = $derived(
    new Map(
      layers.map((l) => {
        const o = screenPrsStore.overviewFor(l.url)
        const steps = o?.status === 'done' ? readingOrderOf(o.text) : []
        return [l.url, readingProgress(l.number, steps, review?.readSteps ?? [])]
      }),
    ),
  )

  let figures = $derived(
    new Map<string, LayerFigures>(
      layers.map((l) => {
        const steps = reading.get(l.url) ?? []
        const since = reviewRoom.since(reviewId, l.url)
        return [
          l.url,
          {
            open: threads.filter((t) => t.status === 'open' && t.anchor.kind !== 'stack' && t.anchor.pr === l.number).length,
            toPost: [...drafts.values()].filter((d) => d.url === l.url).length,
            ...(steps.length ? { read: steps.filter((s) => s.read).length / steps.length } : {}),
            ...(since?.kind === 'ahead' ? { newCommits: since.aheadBy } : {}),
          },
        ]
      }),
    ),
  )
  let openCount = $derived(threads.filter((t) => t.status === 'open').length)
  let companionSessionId = $derived(review?.companion?.sessionId)

  let drawerOpen = $state(false)
  let submitting = $state(false)
  let composingStack = $state(false)

  function jump(targetId: string): void {
    drawerOpen = false
    document.getElementById(targetId)?.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
  }

  async function focusThread(threadId: string): Promise<void> {
    drawerOpen = false
    expandThread(threadId)
    await tick()
    document.getElementById(`thread-${threadId}`)?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  }

  async function startStack(text: string, mode: 'ask' | 'draft'): Promise<void> {
    const anchor: ReviewThreadAnchor = { kind: 'stack' }
    if (mode === 'ask') await reviewRoom.addThread(reviewId, anchor, text)
    else if (top) await reviewRoom.addDraftThread(reviewId, anchor, top.url, text)
    composingStack = false
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && drawerOpen && !e.defaultPrevented) {
      e.preventDefault()
      drawerOpen = false
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if !review}
  <div class="flex h-full items-center justify-center gap-2 text-xs text-zinc-500">
    <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>Opening the review…
  </div>
{:else}
  <div class="@container flex h-full flex-col" data-testid="review-room">
    <div class="flex flex-none items-start gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
      <div class="min-w-0 flex-1">
        <StackMap {layers} {figures} stackThreads={stackThreads.length} onjump={jump} />
      </div>
      <button
        type="button"
        class="flex-none self-center rounded border border-zinc-700 px-2 py-1 text-[11.5px] text-zinc-300 hover:bg-zinc-800 @[900px]:hidden"
        aria-expanded={drawerOpen}
        aria-controls="review-outline"
        onclick={() => (drawerOpen = !drawerOpen)}
      >Outline</button>
    </div>

    <div class="relative flex min-h-0 flex-1">
      <div class="min-w-0 flex-1 overflow-y-auto px-5 pb-10 pt-4">
        {#if review.status !== 'open'}
          <div class="mb-3 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-[12px] text-zinc-300">
            This review was {review.status}. Its threads and drafts stay readable here.
          </div>
        {/if}
        {#if layers.length > 1 || stackThreads.length}
          <section id="review-stack" class="scroll-mt-4 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3" data-testid="stack-section">
            <div class="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Stack · {layers.length} PRs, review bottom → top</div>
            <h1 class="mt-0.5 text-[16px] font-semibold text-zinc-100">{layers.map((l) => `#${l.number}`).join(' → ')}</h1>
            {#if stackThreads.length}
              <div class="mt-3 flex flex-col gap-2">
                {#each stackThreads as t (t.id)}
                  <ReviewThreadCard {reviewId} thread={t} draft={drafts.get(t.id)} draftUrl={top?.url ?? ''} {layers} {companionSessionId} {readonly} />
                {/each}
              </div>
            {/if}
            {#if !readonly}
            <div class="mt-3">
              {#if composingStack}
                <ThreadComposer draftKey="stack:{reviewId}" label="On the whole stack · a comment posts on the layer you pick, the top one by default" onask={(text) => startStack(text, 'ask')} ondraft={(text) => startStack(text, 'draft')} oncancel={() => (composingStack = false)} />
              {:else}
                <button type="button" class="rounded bg-violet-500/15 px-2.5 py-1 text-[11.5px] font-semibold text-violet-300 hover:bg-violet-500/25" onclick={() => (composingStack = true)}>
                  Ask about the stack
                </button>
              {/if}
            </div>
            {/if}
          </section>
        {/if}
        {#each layers as layer (layer.url)}
          <LayerSection
            {reviewId}
            {review}
            {layer}
            {layers}
            threads={threads.filter((t) => t.anchor.kind !== 'stack' && t.anchor.pr === layer.number)}
            {drafts}
            {companionSessionId}
            {readonly}
          />
        {/each}
      </div>

      <aside
        id="review-outline"
        aria-label="Review outline"
        class="flex-none overflow-y-auto border-l border-zinc-800 bg-zinc-900
          {drawerOpen ? 'absolute inset-y-0 right-0 z-30 block w-[min(88%,20rem)] shadow-2xl' : 'hidden'}
          @[900px]:static @[900px]:block @[900px]:w-72 @[900px]:shadow-none"
      >
        <ReviewOutline {layers} {threads} {drafts} {reading} onthread={(id) => void focusThread(id)} onjump={jump} />
      </aside>
    </div>

    <div class="flex flex-none flex-wrap items-center gap-3 border-t border-zinc-800 bg-zinc-900 px-4 py-1.5" data-testid="post-bar">
      <div class="flex flex-wrap gap-3 text-[12px] tabular-nums text-zinc-400">
        {#each layers as l (l.url)}
          <span>#{l.number}: <b class="text-zinc-200">{figures.get(l.url)?.toPost ?? 0}</b> to post</span>
        {/each}
      </div>
      <span class="flex-1"></span>
      <span class="text-[11.5px] text-zinc-500">{openCount} open thread{openCount === 1 ? '' : 's'}</span>
      <button type="button" class="rounded bg-blue-600 px-3 py-1 text-[12px] text-white hover:bg-blue-500 disabled:opacity-50" disabled={review.status !== 'open'} onclick={() => (submitting = true)}>
        Submit reviews…
      </button>
    </div>

    <CompanionDock {reviewId} {review} />
  </div>

  {#if submitting}
    <SubmitReviewsModal {reviewId} {layers} onclose={() => (submitting = false)} />
  {/if}
{/if}
