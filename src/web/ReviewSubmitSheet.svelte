<script lang="ts">
  /**
   * Submit on the phone: one review per layer, each with its own verdict, its
   * review body and the comments drafted in this review's threads, exactly
   * what main posts (`review:submit`). The desktop's `SubmitReviewsModal` as a
   * bottom sheet, on the same helpers, so the preview can't drift from what
   * posts.
   *
   * A layer is postable only once its whole diff was on screen at its current
   * head (`readHeadOf`): main pins the review to that head. A diff cut to fit
   * the socket was not read in full, so that layer is posted at the desk.
   *
   * The answer comes back over this socket. If it went and never came back,
   * the review may still be posting on the Mac: Submit latches until the user
   * says they checked (`reviewSubmits`), and the room shows what main has
   * recorded meanwhile.
   */
  import { untrack } from 'svelte'
  import type { ReviewLayerInfo, ReviewLayerSubmitOutcome, ReviewSubmitRequest, ReviewVerdict } from '../shared/review-room-ipc'
  import { screenPrsStore } from '../renderer/stores/screenprs.svelte'
  import { reviewRoom } from '../renderer/stores/reviewRoom.svelte'
  import { commentWhere, defaultVerdict, draftsMarkdown, layerPreview, postedComments, readHeadOf, unreadReason } from '../renderer/lib/review-room'
  import { NotSentError } from './api-shim'
  import { copyText } from './lib/copy-text'
  import { reviewSubmits } from './lib/review-phone.svelte'

  interface Props {
    reviewId: string
    /** Bottom → top. */
    layers: ReviewLayerInfo[]
    requesterLive: boolean
    connected: boolean
    onclose: () => void
  }

  let { reviewId, layers, requesterLive, connected, onclose }: Props = $props()

  const requested = untrack(() => !!reviewRoom.review(reviewId)?.requesterSessionId)
  let toSession = $state(untrack(() => requested && requesterLive))
  let toGithub = $state(untrack(() => !(requested && requesterLive)))
  $effect(() => {
    if (!requesterLive && toSession) {
      untrack(() => {
        toSession = false
        toGithub = true
      })
    }
  })

  const VERDICTS: { key: ReviewVerdict; label: string; on: string }[] = [
    { key: 'approve', label: 'Approve', on: 'border-emerald-500 bg-emerald-500/15 text-emerald-200' },
    { key: 'comment', label: 'Comment', on: 'border-blue-500 bg-blue-500/15 text-blue-200' },
    { key: 'request_changes', label: 'Changes', on: 'border-red-500 bg-red-500/15 text-red-200' },
  ]
  const SEVERITY_CLASS = { blocking: 'bg-red-500/15 text-red-300', consider: 'bg-amber-500/15 text-amber-300', nit: 'bg-zinc-700 text-zinc-300' } as const

  let threadIds = $derived(new Set(reviewRoom.threadsFor(reviewId).map((t) => t.id)))
  const posted = (url: string, ids: ReadonlySet<string> = threadIds) => postedComments(screenPrsStore.draftFor(url), ids)

  function initial<T>(make: (l: ReviewLayerInfo) => T): Record<string, T> {
    return Object.fromEntries(layers.map((l) => [l.url, make(l)]))
  }
  const startIds = untrack(() => new Set(reviewRoom.threadsFor(reviewId).map((t) => t.id)))
  let verdicts = $state(untrack(() => initial((l) => defaultVerdict(posted(l.url, startIds)))))
  let included = $state(untrack(() => initial((l) => l.state === 'OPEN')))
  let outcomes = $state<Record<string, ReviewLayerSubmitOutcome>>({})
  let adopt = $state<Record<string, string>>({})
  let reloaded = $state<Record<string, string>>({})
  let error = $state<string | null>(null)
  let complete = $state(false)
  let copied = $state(false)

  let submitting = $derived(reviewSubmits.inFlight(reviewId))
  let latched = $derived(reviewSubmits.latched(reviewId))
  let review = $derived(reviewRoom.review(reviewId))
  /** What main has recorded of the newest attempt: the only word on a submit whose answer was lost. */
  let recorded = $derived(review?.submissions.at(-1))

  const readHead = (l: ReviewLayerInfo): string | null => readHeadOf(l, reviewRoom.layerDiff(reviewId, l.url))
  let previews = $derived(new Map(layers.map((l) => [l.url, layerPreview(l, screenPrsStore.draftFor(l.url), posted(l.url), reviewRoom.layerDiff(reviewId, l.url))])))

  // A layer refused as moved can go again once the room has its diff at the new head.
  $effect(() => {
    for (const l of layers) {
      const outcome = outcomes[l.url]
      const head = readHead(l)
      if (outcome?.kind !== 'head-moved' || !head || head === outcome.readHead) continue
      untrack(() => {
        delete outcomes[l.url]
        reloaded[l.url] = head
        included[l.url] = false
        verdicts[l.url] = defaultVerdict(posted(l.url))
      })
    }
  })

  let pending = $derived(
    layers.filter((l) => {
      const kind = outcomes[l.url]?.kind
      return included[l.url] && readHead(l) !== null && kind !== 'posted' && kind !== 'sent' && kind !== 'skipped' && kind !== 'foreign-pending' && kind !== 'head-moved'
    }),
  )

  /** Back waits while the answer is owed. */
  export function holdForDraft(): boolean {
    return submitting
  }

  async function submit(urls: string[]): Promise<void> {
    if (!urls.length || submitting || latched) return
    if (!connected) {
      error = 'Not connected to the Mac: nothing was sent.'
      return
    }
    error = null
    await Promise.all(urls.map((url) => screenPrsStore.flushSummary(url)))
    const request: ReviewSubmitRequest = {
      reviewId,
      layers: layers.flatMap((l) => {
        const head = readHead(l)
        if (!urls.includes(l.url) || !head) return []
        return [{ prUrl: l.url, verdict: verdicts[l.url], readHead: head, ...(adopt[l.url] ? { adoptPendingReviewId: adopt[l.url] } : {}) }]
      }),
      destination: { session: toSession, github: toGithub },
    }
    if (!request.layers.length) return
    reviewSubmits.begin(reviewId)
    try {
      const result = await window.api.invoke('review:submit', request)
      for (const o of result.layers) outcomes[o.prUrl] = o
      complete = result.complete
      reviewSubmits.unlatch(reviewId)
    } catch (err) {
      if (err instanceof NotSentError) {
        error = 'The connection went before the submit was sent: nothing was posted.'
      } else {
        // It went and the answer never came: main may still be posting.
        error =
          'The answer to this submit never arrived, so it may still be posting on the Mac. ' +
          'Check the PRs on GitHub (or what the Mac recorded, below) before submitting again.'
        reviewSubmits.latch(reviewId)
      }
    } finally {
      reviewSubmits.end(reviewId)
    }
  }

  async function copyMarkdown(): Promise<void> {
    const text = draftsMarkdown(
      layers
        .filter((l) => included[l.url])
        .map((l) => ({ number: l.number, title: l.title, verdict: verdicts[l.url], summary: screenPrsStore.draftFor(l.url).summary, comments: posted(l.url) })),
    )
    try {
      await copyText(text)
      copied = true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  const STATE_LABEL = { pending: 'in progress', posted: 'posted', failed: 'failed', unknown: 'unknown (GitHub didn’t answer)' } as const
</script>

<div role="dialog" aria-modal="true" aria-label="Submit reviews" tabindex="-1" class="fixed inset-0 z-40 flex flex-col justify-end" data-testid="submit-sheet">
  <button type="button" aria-label="Dismiss" onclick={() => !submitting && onclose()} class="flex-1 bg-black/60"></button>
  <div class="flex max-h-[90vh] flex-none flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-950 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
    <div class="mb-1 flex flex-none items-center gap-2 px-3">
      <h2 class="min-w-0 flex-1 text-[15px] font-semibold text-zinc-100">Submit reviews</h2>
      <button type="button" onclick={onclose} disabled={submitting} class="-mr-1 min-h-9 px-2 text-sm text-zinc-400 disabled:opacity-40">{complete ? 'Close' : 'Cancel'}</button>
    </div>
    <p class="flex-none px-3 text-[12px] text-zinc-500">One review per layer: its body and the comments you drafted in this review’s threads. Conversations with the companion are never sent.</p>

    {#if requested}
      <div class="mx-3 mt-2 flex flex-none flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13px] text-zinc-200" data-testid="submit-destination">
        <label class="flex min-h-9 items-center gap-2 {requesterLive ? '' : 'opacity-60'}">
          <input type="checkbox" class="h-5 w-5" bind:checked={toSession} disabled={submitting || !requesterLive} data-testid="send-to-session" />
          Send to the requesting session
          {#if !requesterLive}<span class="text-[12px] text-amber-300/90">· it has ended</span>{/if}
        </label>
        <label class="flex min-h-9 items-center gap-2">
          <input type="checkbox" class="h-5 w-5" bind:checked={toGithub} disabled={submitting} data-testid="post-to-github" />
          Also post to GitHub as you
        </label>
        {#if !requesterLive}
          <button type="button" class="min-h-9 self-start text-[13px] text-blue-400" onclick={copyMarkdown}>{copied ? 'Copied' : 'Copy review as markdown'}</button>
        {/if}
      </div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {#if latched}
        <div class="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-100" data-testid="submit-latched">
          <p>A submit of this review never got its answer. It may still be posting.</p>
          {#if recorded}
            <ul class="mt-1 text-[12px]" data-testid="submit-recorded">
              {#each recorded.layers as rl (rl.prUrl)}
                <li>#{layers.find((l) => l.url === rl.prUrl)?.number ?? '?'}: {STATE_LABEL[rl.state]}</li>
              {/each}
            </ul>
          {/if}
          <button type="button" class="mt-2 min-h-10 w-full rounded-lg border border-amber-400/50 text-[13px] font-semibold" data-testid="submit-acknowledge" onclick={() => reviewSubmits.unlatch(reviewId)}>
            I checked — let me submit again
          </button>
        </div>
      {/if}

      {#each layers as l (l.url)}
        {@const p = previews.get(l.url)}
        {@const outcome = outcomes[l.url]}
        {@const v = verdicts[l.url]}
        {@const why = unreadReason(l, reviewRoom.layerDiff(reviewId, l.url))}
        {@const locked = submitting || outcome?.kind === 'posted'}
        <div class="border-t border-zinc-800 py-3 first:border-t-0" data-testid="submit-layer">
          <label class="flex min-h-10 items-center gap-2">
            <input type="checkbox" class="h-5 w-5 flex-none" checked={included[l.url] && !why} disabled={locked || !!why} onchange={(e) => (included[l.url] = e.currentTarget.checked)} aria-label="Post a review on #{l.number}" />
            <b class="min-w-0 flex-1 truncate text-[14px] text-zinc-100">#{l.number} {l.title}</b>
          </label>

          {#if why === 'truncated'}
            <p class="mt-1 text-[12px] text-amber-300/90" data-testid="submit-unread">Too big to read on the phone: post this layer at the desk.</p>
          {:else if why}
            <p class="mt-1 text-[12px] text-amber-300/90" data-testid="submit-unread">Not postable yet: this layer’s diff isn’t loaded at its current head. Read it in the room first.</p>
          {:else if reloaded[l.url] && !included[l.url]}
            <p class="mt-1 text-[12px] text-blue-300" data-testid="submit-reloaded">Reloaded at {reloaded[l.url].slice(0, 7)}. Read what changed, then tick it to post at that head.</p>
          {/if}

          {#if included[l.url] && p && !why}
            <div class="mt-2 grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Verdict for #{l.number}">
              {#each VERDICTS as opt (opt.key)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={v === opt.key}
                  disabled={locked}
                  class="min-h-10 rounded-lg border text-[13px] {v === opt.key ? opt.on : 'border-zinc-700 text-zinc-400'}"
                  data-testid="verdict-{opt.key}"
                  onclick={() => (verdicts[l.url] = opt.key)}
                >{opt.label}</button>
              {/each}
            </div>
            <label class="mt-2 block">
              <span class="text-[11px] uppercase tracking-wider text-zinc-500">Review body for #{l.number}</span>
              <textarea
                class="mt-0.5 min-h-16 w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500 disabled:opacity-60"
                placeholder="Optional"
                aria-label="Review body for #{l.number}"
                value={screenPrsStore.draftFor(l.url).summary}
                disabled={locked}
                oninput={(e) => screenPrsStore.setSummary(l.url, e.currentTarget.value)}
              ></textarea>
            </label>
            {#if p.comments.length}
              <ul class="mt-2 flex flex-col gap-1.5">
                {#each p.comments as c (c.id)}
                  <li class="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[13px]" data-testid="submit-draft">
                    <span class="break-all font-mono text-[11px] text-zinc-500">{commentWhere(c)}</span>
                    {#if c.severity}<span class="ml-1 rounded-full px-1.5 text-[11px] font-semibold {SEVERITY_CLASS[c.severity]}">{c.severity}</span>{/if}
                    <div class="whitespace-pre-wrap text-zinc-200">{c.text || '(empty)'}</div>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="mt-2 text-[12px] text-zinc-500">No comments.{v === 'approve' ? ' Approves without a comment.' : ''}</p>
            {/if}
            <div class="mt-1.5 flex flex-col gap-1 text-[12px]">
              {#if p.comments.some((c) => c.severity === 'blocking') && v !== 'request_changes'}
                <p class="text-red-300" data-testid="blocking-mismatch">This layer has a blocking comment but isn’t set to Request changes.</p>
              {/if}
              {#if p.folded > 0}<p class="text-amber-300/90" data-testid="submit-folded">{p.folded} folded into the review body (no line in GitHub’s diff).</p>{/if}
              {#if p.moved > 0}<p class="text-amber-300/90">{p.moved} written against an earlier commit go into the body.</p>{/if}
              {#if p.unverified > 0}<p class="text-amber-300/90">{p.unverified} can’t be checked against this branch’s current commit.</p>{/if}
              {#if p.unchecked}<p class="text-zinc-500">Lines are checked against GitHub’s diff when this posts; any it can’t place go into the body.</p>{/if}
            </div>
          {:else if !included[l.url] && !why}
            <p class="mt-1 text-[12px] text-zinc-500">Not posted.</p>
          {/if}

          {#if outcome}
            <div class="mt-2 text-[13px]" data-testid="submit-outcome">
              {#if outcome.kind === 'posted'}
                <span class="text-emerald-300">Posted{outcome.folded ? ` · ${outcome.folded} folded into the body` : ''}.</span>
                {#if outcome.reviewUrl}<a class="ml-1 text-blue-400" href={outcome.reviewUrl} target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>{/if}
              {:else if outcome.kind === 'skipped'}
                <span class="text-zinc-500">Skipped.</span>
              {:else if outcome.kind === 'sent'}
                <span class="text-emerald-300">Sent to the requesting session (not posted to GitHub).</span>
              {:else if outcome.kind === 'foreign-pending'}
                <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-amber-100">
                  A pending review you started on GitHub exists ({outcome.commentCount} comment{outcome.commentCount === 1 ? '' : 's'}).
                  <div class="mt-1.5 flex gap-2">
                    <button type="button" class="min-h-9 rounded-lg bg-amber-600 px-3 text-white" disabled={submitting || latched} onclick={() => { adopt[l.url] = outcome.pendingReviewId; void submit([l.url]) }}>Use it</button>
                    <button type="button" class="min-h-9 rounded-lg border border-zinc-600 px-3" disabled={submitting} onclick={() => { included[l.url] = false; delete outcomes[l.url] }}>Leave it out</button>
                  </div>
                </div>
              {:else if outcome.kind === 'head-moved'}
                <span class="text-amber-300" data-testid="submit-head-moved">Not posted: #{l.number} moved to {outcome.headSha.slice(0, 7)} since you read {outcome.readHead.slice(0, 7)}. Read what changed first.</span>
              {:else}
                <span class="text-red-300">{outcome.kind === 'unknown' ? 'GitHub didn’t answer in time; it may have the review.' : 'Couldn’t post'}: {outcome.error}</span>
                <button type="button" class="ml-1.5 min-h-9 rounded-lg border border-zinc-700 px-3 text-zinc-200" disabled={submitting || latched} onclick={() => submit([l.url])}>Retry</button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <div class="flex-none border-t border-zinc-800 px-3 pt-2">
      {#if error}<p class="mb-2 text-[12px] leading-relaxed text-red-300" role="alert" data-testid="submit-error">{error}</p>{/if}
      {#if !connected}<p class="mb-2 text-[12px] text-amber-400">Not connected. Submit works once the dot goes green.</p>{/if}
      {#if !complete}
        <button
          type="button"
          class="min-h-11 w-full rounded-lg bg-blue-600 text-sm font-semibold text-white active:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500"
          disabled={submitting || latched || !connected || pending.length === 0 || (!toSession && !toGithub)}
          data-testid="submit-reviews"
          onclick={() => submit(pending.map((l) => l.url))}
        >{submitting ? (toGithub ? 'Posting…' : 'Sending…') : `Submit ${pending.length} review${pending.length === 1 ? '' : 's'}`}</button>
      {/if}
    </div>
  </div>
</div>
