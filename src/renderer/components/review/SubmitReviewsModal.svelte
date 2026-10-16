<script lang="ts">
  /**
   * One review per layer, each with its own verdict, its draft's summary and
   * the comments drafted in this review's threads: exactly what main posts
   * (other comments in a layer's draft stay where they are). The fold preview runs the same pure builder main
   * posts with (`ConfirmReviewModal` does too), so it can't drift. Posting is
   * main's (`review:submit`); this only shows what each layer came back with.
   */
  import { onMount, untrack } from 'svelte'
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
    /** The session that requested the review is alive, so the review can go back to it. */
    requesterLive?: boolean
    onclose: () => void
  }

  let { reviewId, layers, requesterLive = false, onclose }: Props = $props()

  // ── Where it goes (§7): back to the requesting session by default, GitHub optional ──
  const requested = untrack(() => !!reviewRoom.review(reviewId)?.requesterSessionId)
  let toSession = $state(untrack(() => requested && requesterLive))
  let toGithub = $state(untrack(() => !(requested && requesterLive)))
  $effect(() => {
    // The requester ended while the dialog was open: it can't receive the review any more.
    if (!requesterLive && toSession) {
      untrack(() => {
        toSession = false
        toGithub = true
      })
    }
  })
  let copied = $state(false)

  const VERDICTS: { key: ReviewVerdict; label: string; on: string }[] = [
    { key: 'approve', label: 'Approve', on: 'bg-emerald-500/15 text-emerald-300' },
    { key: 'comment', label: 'Comment', on: 'bg-blue-500/15 text-blue-300' },
    { key: 'request_changes', label: 'Request changes', on: 'bg-red-500/15 text-red-300' },
  ]
  const SEVERITY_CLASS = { blocking: 'bg-red-500/15 text-red-300', consider: 'bg-amber-500/15 text-amber-300', nit: 'bg-zinc-700 text-zinc-300' } as const

  function initial<T>(make: (l: ReviewLayerInfo) => T): Record<string, T> {
    return Object.fromEntries(layers.map((l) => [l.url, make(l)]))
  }

  let threadIds = $derived(new Set(reviewRoom.threadsFor(reviewId).map((t) => t.id)))
  /** A layer's comments that main posts: those of this review's threads. */
  function postedComments(url: string, ids: ReadonlySet<string> = threadIds): PrReviewComment[] {
    return screenPrsStore.draftFor(url).comments.filter((c) => c.threadId !== undefined && ids.has(c.threadId))
  }

  let verdicts = $state(initial((l) => defaultVerdict(postedComments(l.url, new Set(reviewRoom.threadsFor(reviewId).map((t) => t.id))))))
  /** A merged or closed layer can't take a review, so it starts left out. */
  let included = $state(initial((l) => l.state === 'OPEN'))
  let outcomes = $state<Record<string, ReviewLayerSubmitOutcome>>({})
  let adopt = $state<Record<string, string>>({})
  let submitting = $state(false)
  let error = $state<string | null>(null)
  let complete = $state(false)
  /** Layers refused as moved, then reloaded by the room at their new head: the head they can post at now. */
  let reloaded = $state<Record<string, string>>({})

  interface LayerPreview {
    comments: PrReviewComment[]
    replies: number
    folded: number
    moved: number
    unverified: number
    unchecked: boolean
  }

  function preview(l: ReviewLayerInfo): LayerPreview {
    const draft = { ...screenPrsStore.draftFor(l.url), comments: postedComments(l.url) }
    const lineDraft = { ...draft, comments: draft.comments.filter((c) => !c.inReplyTo) }
    const diff = reviewRoom.layerDiff(reviewId, l.url)
    const head = readHead(l) ?? l.headSha
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
  /**
   * The head the user is reading, which main checks the layer against and
   * pins the review to. Null unless the diff on screen is at the layer's
   * current head: a diff that never loaded, or one still being reloaded after
   * a push, was not read at the head that would be posted.
   */
  function readHead(l: ReviewLayerInfo): string | null {
    const diff = reviewRoom.layerDiff(reviewId, l.url)
    return diff && diff.headSha === l.headSha ? diff.headSha : null
  }

  // A layer refused as moved can go again once the room has its diff at the
  // new head: the user opts back in, with the verdict its drafts now suggest.
  $effect(() => {
    for (const l of layers) {
      const outcome = outcomes[l.url]
      const head = readHead(l)
      if (outcome?.kind !== 'head-moved' || !head || head === outcome.readHead) continue
      untrack(() => {
        delete outcomes[l.url]
        reloaded[l.url] = head
        included[l.url] = false
        verdicts[l.url] = defaultVerdict(postedComments(l.url))
      })
    }
  })

  /**
   * Still to send: a pending review found on GitHub waits for its own answer
   * (Use it / Cancel), and a layer that moved waits for a reload.
   */
  let pending = $derived(
    layers.filter((l) => {
      const kind = outcomes[l.url]?.kind
      return included[l.url] && readHead(l) !== null && kind !== 'posted' && kind !== 'sent' && kind !== 'skipped' && kind !== 'foreign-pending' && kind !== 'head-moved'
    }),
  )

  async function submit(urls: string[]): Promise<void> {
    if (!urls.length || submitting) return
    submitting = true
    error = null
    // Main posts the summary it holds, so one still being typed goes first.
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
    if (!request.layers.length) {
      submitting = false
      return
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

  // ── Focus: taken on open, kept inside, given back on close ──
  let dialog = $state<HTMLDivElement>()

  onMount(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  })

  function focusables(): HTMLElement[] {
    if (!dialog) return []
    return [...dialog.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0,
    )
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!submitting) onclose()
    } else if (e.key === 'Tab') {
      const all = focusables()
      if (!all.length) return
      const first = all[0]
      const last = all[all.length - 1]
      const at = document.activeElement
      if (e.shiftKey && (at === first || at === dialog)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  /** The review as markdown, for a requester that is gone or a review kept off GitHub. */
  async function copyMarkdown(): Promise<void> {
    const VERDICT_TEXT: Record<ReviewVerdict, string> = { approve: 'Approve', comment: 'Comment', request_changes: 'Request changes' }
    const text = layers
      .filter((l) => included[l.url])
      .map((l) => {
        const summary = screenPrsStore.draftFor(l.url).summary.trim()
        const comments = postedComments(l.url).map((c) => `- \`${where(c)}\`${c.severity ? ` **${c.severity}:**` : ''} ${c.text.trim()}`)
        return [`## #${l.number} ${l.title} — ${VERDICT_TEXT[verdicts[l.url]]}`, ...(summary ? ['', summary] : []), ...(comments.length ? ['', ...comments] : [])].join('\n')
      })
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      copied = true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
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
    bind:this={dialog}
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
      <p class="mt-1 text-[11px] text-zinc-500">One review per layer: its review body and the comments you drafted in this review’s threads. Conversations with the companion are never sent.{requested ? '' : ' This posts to GitHub as you.'}</p>
      {#if requested}
        <div class="mt-2 flex flex-col gap-1 rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[12px] text-zinc-200" data-testid="submit-destination">
          <label class="flex items-center gap-2 {requesterLive ? '' : 'opacity-60'}">
            <input type="checkbox" bind:checked={toSession} disabled={submitting || !requesterLive} data-testid="send-to-session" />
            Send to the requesting session
            {#if !requesterLive}<span class="text-[11px] text-amber-300/90">· it has ended</span>{/if}
          </label>
          <label class="flex items-center gap-2">
            <input type="checkbox" bind:checked={toGithub} disabled={submitting} data-testid="post-to-github" />
            Also post to GitHub as you
          </label>
          {#if !requesterLive}
            <button type="button" class="self-start text-[11px] text-blue-400 hover:underline" onclick={copyMarkdown}>{copied ? 'Copied' : 'Copy review as markdown'}</button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {#each layers as l (l.url)}
        {@const p = previews.get(l.url)}
        {@const outcome = outcomes[l.url]}
        {@const v = verdicts[l.url]}
        {@const unread = readHead(l) === null}
        <div class="border-t border-zinc-800 py-3 first:border-t-0" data-testid="submit-layer">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <label class="flex min-w-0 items-center gap-2">
              <input type="checkbox" checked={included[l.url] && !unread} disabled={submitting || unread || outcome?.kind === 'posted'} onchange={(e) => (included[l.url] = e.currentTarget.checked)} aria-label="Post a review on #{l.number}" />
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
                    disabled={!included[l.url] || unread || submitting || outcome?.kind === 'posted'}
                    onchange={() => (verdicts[l.url] = opt.key)}
                  />{opt.label}
                </label>
              {/each}
            </div>
          </div>

          {#if unread}
            <p class="mt-2 text-[11.5px] text-amber-300/90" data-testid="submit-unread">Not postable: this layer’s diff didn’t load at its current head — reload it in the room and read it before posting.</p>
          {:else if reloaded[l.url] && !included[l.url]}
            <p class="mt-2 text-[11.5px] text-blue-300" data-testid="submit-reloaded">Reloaded at {reloaded[l.url].slice(0, 7)}. Read what changed, then tick it to post at that head.</p>
          {/if}
          {#if included[l.url] && p && !unread}
            <label class="mt-2 block">
              <span class="text-[10px] uppercase tracking-wider text-zinc-500">Review body for #{l.number} · posted above the comments</span>
              <textarea
                class="mt-0.5 w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500 disabled:opacity-60"
                rows="2"
                placeholder="Optional"
                aria-label="Review body for #{l.number}"
                value={screenPrsStore.draftFor(l.url).summary}
                disabled={submitting || outcome?.kind === 'posted'}
                oninput={(e) => screenPrsStore.setSummary(l.url, e.currentTarget.value)}
              ></textarea>
            </label>
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
              {:else if outcome.kind === 'sent'}
                <span class="text-emerald-300">Sent to the requesting session (not posted to GitHub).</span>
              {:else if outcome.kind === 'foreign-pending'}
                <div class="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-100">
                  A pending review you started on GitHub exists ({outcome.commentCount} comment{outcome.commentCount === 1 ? '' : 's'}).
                  <span class="mt-1 flex gap-1.5">
                    <button type="button" class="rounded bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-500" disabled={submitting} onclick={() => usePending(l.url, outcome.pendingReviewId)}>Use it</button>
                    <button type="button" class="rounded border border-zinc-600 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800" disabled={submitting} onclick={() => leaveOut(l.url)}>Cancel</button>
                  </span>
                </div>
              {:else if outcome.kind === 'head-moved'}
                <span class="text-amber-300" data-testid="submit-head-moved">
                  Not posted: #{l.number} moved to {outcome.headSha.slice(0, 7)} since you read {outcome.readHead.slice(0, 7)}. Reload the layer and read what changed first.
                </span>
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
          disabled={submitting || pending.length === 0 || (!toSession && !toGithub)}
          onclick={() => submit(pending.map((l) => l.url))}
        >{submitting ? (toGithub ? 'Posting…' : 'Sending…') : `Submit ${pending.length} review${pending.length === 1 ? '' : 's'}`}</button>
      {/if}
    </div>
  </div>
</div>
