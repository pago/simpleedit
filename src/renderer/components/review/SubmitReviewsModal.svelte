<script lang="ts">
  /**
   * One review per layer, each with its own verdict and exactly the comments
   * the user drafted on it. The fold preview runs the same pure builder main
   * posts with (`ConfirmReviewModal` does too), so it can't drift. Posting is
   * main's (`review:submit`); this only shows what each layer came back with.
   */
  import type { ReviewLayerInfo, ReviewLayerSubmitOutcome, ReviewSubmitRequest, ReviewVerdict } from '../../../shared/review-room-ipc'
  import type { PrReviewComment } from '../../../shared/screenprs'
  import { anchorCounts, anchorsForHead, buildReviewPayload, commentableLines } from '../../../shared/screenprs'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { reviewRoom } from '../../stores/reviewRoom.svelte'
  import { defaultVerdict } from '../../lib/review-room'

  interface Props {
    reviewId: string
    /** Bottom → top. */
    layers: ReviewLayerInfo[]
    onclose: () => void
  }

  let { reviewId, layers, onclose }: Props = $props()

  const VERDICTS: { key: ReviewVerdict; label: string; on: string }[] = [
    { key: 'approve', label: 'Approve', on: 'bg-emerald-500/15 text-emerald-300' },
    { key: 'comment', label: 'Comment', on: 'bg-blue-500/15 text-blue-300' },
    { key: 'request_changes', label: 'Request changes', on: 'bg-red-500/15 text-red-300' },
  ]
  const SEVERITY_CLASS = { blocking: 'bg-red-500/15 text-red-300', consider: 'bg-amber-500/15 text-amber-300', nit: 'bg-zinc-700 text-zinc-300' } as const

  function initial<T>(make: (l: ReviewLayerInfo) => T): Record<string, T> {
    return Object.fromEntries(layers.map((l) => [l.url, make(l)]))
  }
  let verdicts = $state(initial((l) => defaultVerdict(screenPrsStore.draftFor(l.url).comments)))
  /** A merged or closed layer can't take a review, so it starts left out. */
  let included = $state(initial((l) => l.state === 'OPEN'))
  let outcomes = $state<Record<string, ReviewLayerSubmitOutcome>>({})
  let adopt = $state<Record<string, string>>({})
  let submitting = $state(false)
  let error = $state<string | null>(null)
  let complete = $state(false)

  interface LayerPreview {
    comments: PrReviewComment[]
    replies: number
    folded: number
    moved: number
    unverified: number
    unchecked: boolean
  }

  function preview(l: ReviewLayerInfo): LayerPreview {
    const draft = screenPrsStore.draftFor(l.url)
    const lineDraft = { ...draft, comments: draft.comments.filter((c) => !c.inReplyTo) }
    const diff = reviewRoom.layerDiff(reviewId, l.url)
    const head = diff?.headSha ?? l.headSha
    const base = diff?.base ?? l.base
    const isolatedBase = base?.kind === 'polluted' && base.isolated
    // Only GitHub's own diff says which lines GitHub takes; an isolated one doesn't.
    const commentable = diff && !isolatedBase ? commentableLines(diff.diff) : undefined
    const payload = buildReviewPayload(anchorsForHead(lineDraft, head), { isolatedBase, commentable })
    const counts = anchorCounts(lineDraft, head)
    return {
      comments: draft.comments,
      replies: draft.comments.length - lineDraft.comments.length,
      folded: lineDraft.comments.length - payload.comments.length,
      moved: counts.moved,
      unverified: counts.unverified,
      unchecked: !commentable && payload.comments.length > 0,
    }
  }

  let previews = $derived(new Map(layers.map((l) => [l.url, preview(l)])))
  /** Still to send: a pending review found on GitHub waits for its own answer (Use it / Cancel). */
  let pending = $derived(
    layers.filter((l) => {
      const kind = outcomes[l.url]?.kind
      return included[l.url] && kind !== 'posted' && kind !== 'skipped' && kind !== 'foreign-pending'
    }),
  )

  async function submit(urls: string[]): Promise<void> {
    if (!urls.length || submitting) return
    submitting = true
    error = null
    const request: ReviewSubmitRequest = {
      reviewId,
      layers: urls.map((prUrl) => ({ prUrl, verdict: verdicts[prUrl], ...(adopt[prUrl] ? { adoptPendingReviewId: adopt[prUrl] } : {}) })),
    }
    try {
      const result = await window.api.invoke('review:submit', request)
      for (const o of result.layers) outcomes[o.prUrl] = o
      complete = result.complete
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    submitting = false
  }

  function usePending(url: string, pendingReviewId: string): void {
    adopt[url] = pendingReviewId
    void submit([url])
  }

  function leaveOut(url: string): void {
    included[url] = false
    delete outcomes[url]
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!submitting) onclose()
    }
  }

  function where(c: PrReviewComment): string {
    if (c.inReplyTo) return 'reply'
    if (!c.file) return 'PR comment'
    return c.line ? `${c.file}:${c.line}` : c.file
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onclick={() => !submitting && onclose()}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="flex max-h-[85vh] w-[640px] max-w-full flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="Submit reviews"
    tabindex="-1"
  >
    <div class="flex-none px-4 pt-4">
      <h2 class="text-sm font-semibold text-zinc-100">Submit reviews</h2>
      <p class="mt-1 text-[11px] text-zinc-500">One review per layer, with exactly the comments you drafted. Conversations with the companion are never posted. This posts to GitHub as you.</p>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {#each layers as l (l.url)}
        {@const p = previews.get(l.url)}
        {@const outcome = outcomes[l.url]}
        {@const v = verdicts[l.url]}
        <div class="border-t border-zinc-800 py-3 first:border-t-0" data-testid="submit-layer">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <label class="flex min-w-0 items-center gap-2">
              <input type="checkbox" checked={included[l.url]} disabled={submitting || outcome?.kind === 'posted'} onchange={(e) => (included[l.url] = e.currentTarget.checked)} aria-label="Post a review on #{l.number}" />
              <b class="truncate text-[12.5px] text-zinc-100">#{l.number} {l.title}</b>
            </label>
            <div class="inline-flex overflow-hidden rounded border border-zinc-700" role="radiogroup" aria-label="Verdict for #{l.number}">
              {#each VERDICTS as opt (opt.key)}
                <label class="flex cursor-pointer items-center gap-1 border-l border-zinc-700 px-2 py-0.5 text-[11.5px] first:border-l-0 {v === opt.key ? opt.on : 'text-zinc-400'}">
                  <input
                    type="radio"
                    class="m-0"
                    name="verdict-{l.number}"
                    value={opt.key}
                    checked={v === opt.key}
                    disabled={!included[l.url] || submitting || outcome?.kind === 'posted'}
                    onchange={() => (verdicts[l.url] = opt.key)}
                  />{opt.label}
                </label>
              {/each}
            </div>
          </div>

          {#if included[l.url] && p}
            {#if p.comments.length}
              <ul class="mt-2 flex flex-col gap-1">
                {#each p.comments as c (c.id)}
                  <li class="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[12px]" data-testid="submit-draft">
                    <span class="font-mono text-[10.5px] text-zinc-500">{where(c)}</span>
                    {#if c.severity}<span class="ml-1 rounded-full px-1.5 text-[10px] font-semibold {SEVERITY_CLASS[c.severity]}">{c.severity}</span>{/if}
                    <div class="whitespace-pre-wrap text-zinc-200">{c.text || '(empty)'}</div>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="mt-2 text-[11.5px] text-zinc-500">No comments.{v === 'approve' ? ' Approves without a comment.' : ''}</p>
            {/if}
            <div class="mt-1.5 flex flex-col gap-1 text-[11px]">
              {#if p.comments.some((c) => c.severity === 'blocking') && v !== 'request_changes'}
                <p class="text-red-300" data-testid="blocking-mismatch">This layer has a blocking comment but isn’t set to Request changes.</p>
              {/if}
              {#if p.folded > 0}
                <p class="text-amber-300/90" data-testid="submit-folded">{p.folded} folded into the review body (no line in GitHub’s diff).</p>
              {/if}
              {#if p.moved > 0}
                <p class="text-amber-300/90">{p.moved} written against an earlier commit: they go into the body, since the line no longer points at the code you read.</p>
              {/if}
              {#if p.unverified > 0}
                <p class="text-amber-300/90">{p.unverified} can’t be checked against this branch’s current commit.</p>
              {/if}
              {#if p.unchecked}
                <p class="text-zinc-500">Lines are checked against GitHub’s diff when this posts; any it can’t place go into the body.</p>
              {/if}
            </div>
          {:else if !included[l.url]}
            <p class="mt-2 text-[11.5px] text-zinc-500">Not posted.</p>
          {/if}

          {#if outcome}
            <div class="mt-2 text-[11.5px]" data-testid="submit-outcome">
              {#if outcome.kind === 'posted'}
                <span class="text-emerald-300">Posted{outcome.folded ? ` · ${outcome.folded} folded into the body` : ''}.</span>
                {#if outcome.reviewUrl}
                  <button type="button" class="ml-1 text-blue-400 hover:underline" onclick={() => void window.api.invoke('app:open-external', outcome.reviewUrl ?? l.url)}>↗ view on GitHub</button>
                {/if}
              {:else if outcome.kind === 'skipped'}
                <span class="text-zinc-500">Skipped.</span>
              {:else if outcome.kind === 'foreign-pending'}
                <div class="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-100">
                  A pending review you started on GitHub exists ({outcome.commentCount} comment{outcome.commentCount === 1 ? '' : 's'}).
                  <span class="mt-1 flex gap-1.5">
                    <button type="button" class="rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-500" disabled={submitting} onclick={() => usePending(l.url, outcome.pendingReviewId)}>Use it</button>
                    <button type="button" class="rounded border border-zinc-600 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800" disabled={submitting} onclick={() => leaveOut(l.url)}>Cancel</button>
                  </span>
                </div>
              {:else}
                <span class="text-red-300">{outcome.kind === 'unknown' ? 'GitHub didn’t answer in time; it may have the review.' : 'Couldn’t post'}: {outcome.error}</span>
                <button type="button" class="ml-1.5 rounded border border-zinc-700 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800" disabled={submitting} onclick={() => submit([l.url])}>Retry</button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    {#if error}
      <div class="mx-4 mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300" role="alert">Couldn’t submit: {error}</div>
    {/if}
    <div class="flex flex-none justify-end gap-2 border-t border-zinc-800 px-4 py-3">
      <button type="button" class="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50" onclick={onclose} disabled={submitting}>
        {complete ? 'Close' : 'Cancel'}
      </button>
      {#if !complete}
        <button
          type="button"
          class="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={submitting || pending.length === 0}
          onclick={() => submit(pending.map((l) => l.url))}
        >{submitting ? 'Posting…' : `Submit ${pending.length} review${pending.length === 1 ? '' : 's'}`}</button>
      {/if}
    </div>
  </div>
</div>
