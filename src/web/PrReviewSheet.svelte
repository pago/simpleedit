<script lang="ts">
  /**
   * Verdict, summary, submit — the only path from this phone to GitHub.
   *
   * The invariant it exists to hold: **nothing reaches `screenprs:submit-review`
   * without the user having seen the verdict and the comment count and confirmed
   * that exact action.** Four things enforce it, none of them a comment:
   *
   *  - The verdict must be TAPPED. `emptyReviewDraft()` starts at `approve`,
   *    which at a desk is a sensible default and on a phone would make approval
   *    the result of not deciding. Submit stays dead until `verdictChoice`.
   *  - Submit opens a confirm; only the confirm invokes. Never a swipe, and the
   *    microphone can reach neither (`ComposeSheet` only ever adds draft text).
   *  - A closed socket refuses the post outright, checked here and not only on
   *    the button, so a tap that raced the socket going down cannot slip past.
   *  - An unanswered submit LATCHES (`unknownOutcome`). Reviews have no
   *    idempotency key, so a second tap after an outcome nobody knows is how
   *    one review becomes two.
   *
   * ── Draft lifetime ───────────────────────────────────────────────────────
   * The draft is owned by main and persisted there, keyed by PR url; the store
   * holds a mirror of it. Leaving a PR, reloading the page or reconnecting keeps
   * what you dictated — on a phone the difference between a usable review and
   * a lost one — and the desktop edits the same draft, so a review started here
   * can be finished at the desk. Drafts untouched for 30 days are pruned.
   *
   * A draft that outlives a push is handled rather than prevented: each comment
   * carries the head it was written on, and the `draft` shown here has already
   * been through `anchorsForHead`, so a line anchor survives only where it was
   * verified against the head on screen. Main posts the raw draft through the
   * same function, pinned to that head, and reports what it folded.
   * Everything else — moved, or simply not checkable — folds into the body,
   * and the two reasons are reported apart because they mean different things
   * to the person deciding whether to post.
   */
  import { screenPrsStore } from '../renderer/stores/screenprs.svelte'
  import { commentableLines, describeFolds, type AnchorState, type PrRef, type PrReviewCommentSource, type PrReviewDraft, type PrReviewVerdict } from '../shared/screenprs'
  import { unknownOutcome, verdictChoice, type SubmitOutcome } from './lib/prs.svelte'
  import { NotSentError } from './api-shim'
  import ComposeSheet from './ComposeSheet.svelte'
  import ConfirmSubmitModal from './ConfirmSubmitModal.svelte'
  import { nav } from './lib/nav.svelte'

  interface Props {
    pr: Pick<PrRef, 'owner' | 'repo' | 'number' | 'url'>
    /**
     * The draft as it would be POSTED — already re-anchored for the current
     * head. Passed in rather than read from the store so that what is shown,
     * what is counted in the confirm, and what is sent are the same object.
     */
    draft: PrReviewDraft
    /** The draft before `anchorsForHead` — what is sent while `headSha` is known. */
    rawDraft: PrReviewDraft
    /** The head whose diff is on screen; '' until it is known. */
    headSha: string
    /** The diff on screen is the isolated stacked compare, not GitHub's. */
    isolatedBase: boolean
    /** The diff on screen, '' until loaded. */
    diff: string
    /**
     * How many comments are in each anchor state, counted on the draft BEFORE
     * folding. Passed in rather than derived here so the sheet, the confirm and
     * the payload are three views of one computation.
     */
    anchors: Record<AnchorState, number>
    /** Whether the socket is open right now — read at the point of use. */
    connected: boolean
  }

  let { pr, draft, rawDraft, headSha, isolatedBase, diff, anchors, connected }: Props = $props()

  let url = $derived(pr.url)
  let submitted = $derived(screenPrsStore.submittedFor(url))
  let submitting = $derived(screenPrsStore.isSubmitting(url))
  let draftError = $derived(screenPrsStore.draftError(url))
  let chosen = $derived(verdictChoice.made(url))
  let latched = $derived(unknownOutcome.pending(url))
  let notice = $derived(screenPrsStore.draftNoticeFor(url))
  // Otherwise the diff on screen is GitHub's own, the one main checks anchors against.
  let commentable = $derived(!isolatedBase && diff ? commentableLines(diff) : undefined)

  let open = $state(false)
  // Both overlays are layers on the navigation stack, so Back dismisses them —
  // except the confirm while a post is in flight, which nothing can cancel.
  let confirmId = $state<number | null>(null)
  let summaryId = $state<number | null>(null)
  let summarySheet = $state<ComposeSheet | undefined>()
  let confirming = $derived(nav.has(confirmId))
  let summaryOpen = $derived(nav.has(summaryId))
  let outcome = $state<SubmitOutcome | null>(null)

  const VERDICTS: PrReviewVerdict[] = ['approve', 'comment', 'request_changes']
  const VERDICT_LABEL: Record<PrReviewVerdict, string> = {
    approve: 'Approve',
    comment: 'Comment',
    request_changes: 'Request changes',
  }
  const VERDICT_ON: Record<PrReviewVerdict, string> = {
    approve: 'bg-emerald-500/20 text-emerald-300',
    comment: 'bg-zinc-700 text-zinc-100',
    request_changes: 'bg-red-500/20 text-red-300',
  }
  const SOURCE_CLASS: Record<PrReviewCommentSource, string> = {
    triage: 'bg-orange-500/15 text-orange-300',
    deep: 'bg-blue-500/15 text-blue-300',
    overview: 'bg-teal-500/15 text-teal-300',
    agent: 'bg-violet-500/18 text-violet-300',
    you: 'bg-zinc-700 text-zinc-200',
  }

  let blocked = $derived(!chosen ? 'Choose a verdict first.' : draftError)

  /**
   * Clear the last attempt's message — unless it is the one holding the latch
   * down, in which case removing it leaves a dead Post button and no
   * explanation of why it is dead.
   */
  function clearOutcome(): void {
    if (!latched) outcome = null
  }

  function chooseVerdict(v: PrReviewVerdict): void {
    screenPrsStore.setVerdict(url, v)
    verdictChoice.make(url)
    clearOutcome()
  }

  async function post(): Promise<void> {
    // The button is disabled while a post is in flight; this is the backstop,
    // held to the same doctrine as the connection check below.
    if (submitting) return
    // Re-checked here, not just on the disabled button: a tap can be in flight
    // when the socket goes, and the shim's own refusal is the backstop, not the
    // thing the user should have to read.
    if (!connected) {
      outcome = { kind: 'not-sent', message: 'Not connected to the Mac — nothing was sent.' }
      return
    }
    if (latched) return
    outcome = null
    try {
      // Without a head nothing can be pinned, so only the already-folded draft may go.
      const res = headSha
        ? await screenPrsStore.submitReview(pr, rawDraft, { headSha, isolatedBase, clearDraft: true })
        : await screenPrsStore.submitReview(pr, draft, { clearDraft: true })
      if (res.ok) {
        nav.close(confirmId)
        // Posted and done with: a follow-up starts from no verdict.
        verdictChoice.reset(url)
        unknownOutcome.clear(url)
      } else if (res.delivered === 'unknown') {
        // Main answered, but only to say it killed the call in flight. GitHub
        // may have taken it, so this latches exactly like a dropped socket.
        outcome = {
          kind: 'unknown',
          message:
            `The Mac gave up waiting on GitHub, so it isn’t known whether the review posted. ` +
            `Check ${pr.repo}#${pr.number} — posting again would post twice if it did.`,
        }
        unknownOutcome.raise(url)
      } else {
        // GitHub answered. Whatever it said, nothing was posted.
        outcome = { kind: 'refused', message: `GitHub refused it: ${res.error}` }
      }
    } catch (err) {
      if (err instanceof NotSentError) {
        // The shim can prove this frame never left the device.
        outcome = { kind: 'not-sent', message: 'The connection went before the call was sent — nothing was posted.' }
        return
      }
      // It went and never came back. Nobody knows whether GitHub took it, so
      // this latches rather than re-arming: reviews have no idempotency key.
      outcome = {
        kind: 'unknown',
        message:
          `The connection dropped after the review was sent, so it isn’t known whether it posted. ` +
          `Check ${pr.repo}#${pr.number} on GitHub — posting again would post twice if it did.`,
      }
      unknownOutcome.raise(url)
    }
  }

  function addToSummary(text: string): void {
    const current = draft.summary.trim()
    screenPrsStore.setSummary(url, current ? `${current}\n\n${text}` : text)
  }
</script>

<div class="flex-none border-t border-zinc-800 bg-zinc-900" data-testid="review-sheet">
  {#if submitted}
    <div class="px-3 py-3 text-[12px] text-emerald-300" data-testid="review-submitted">
      <p class="font-medium">✓ Review posted — {VERDICT_LABEL[submitted.verdict]}</p>
      {#if submitted.folded.count > 0}
        <p class="mt-1 text-[11px] text-amber-300/80" data-testid="submitted-folds">
          {submitted.folded.count === 1 ? 'A comment' : `${submitted.folded.count} comments`} went into the summary
          instead of on a line: {describeFolds(submitted.folded)}.
        </p>
      {/if}
      <button
        type="button"
        onclick={() => screenPrsStore.resetSubmitted(url)}
        class="mt-2 min-h-9 rounded-lg border border-zinc-700 px-3 text-[12px] text-zinc-300"
      >Compose another</button>
    </div>
  {:else}
    <button
      type="button"
      onclick={() => (open = !open)}
      data-testid="review-toggle"
      class="flex w-full items-center gap-2 px-3 py-3 text-left text-[12px] text-zinc-200"
    >
      <span class="text-[10px] text-zinc-500">{open ? '▾' : '▴'}</span>
      <span class="font-semibold">Review to post</span>
      {#if draft.comments.length}
        <span
          class="rounded-full bg-blue-600 px-1.5 text-[10px] font-bold tabular-nums text-white"
          data-testid="draft-count">{draft.comments.length}</span
        >
      {/if}
      <span class="flex-1"></span>
      <span class="text-[11px] text-zinc-500">{chosen ? VERDICT_LABEL[draft.verdict] : 'no verdict'}</span>
    </button>

    {#if notice}
      <div
        class="mx-3 mb-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200"
        data-testid="draft-notice"
      >
        <span class="flex-1">{notice}</span>
        <button
          type="button"
          onclick={() => screenPrsStore.dismissDraftNotice(url)}
          aria-label="Dismiss"
          class="flex-none px-1.5 text-amber-300/80"
        >×</button>
      </div>
    {/if}
    {#if open}
      <div class="flex max-h-[52vh] flex-col gap-2.5 overflow-y-auto px-3 pb-3">
        {#if outcome}
          <p
            class="rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed
              {outcome.kind === 'unknown'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                : 'border-red-500/30 bg-red-500/10 text-red-300'}"
            data-testid="sheet-outcome"
          >{outcome.message}</p>
        {/if}
        {#if anchors.moved > 0}
          <p
            class="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200"
            data-testid="moved-notice"
          >
            The branch moved since {anchors.moved === 1 ? 'a comment was' : `${anchors.moved} comments were`}
            written. {anchors.moved === 1 ? 'Its' : 'Their'} line number would now point at different code, so
            {anchors.moved === 1 ? 'it goes' : 'they go'} in the summary instead of on a line.
          </p>
        {/if}
        {#if anchors.unverified > 0}
          <p
            class="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200"
            data-testid="unverified-notice"
          >
            {anchors.unverified === 1 ? 'A comment' : `${anchors.unverified} comments`} can’t be checked against
            the commit currently on this branch, so {anchors.unverified === 1 ? 'it goes' : 'they go'} in the
            summary rather than risk landing on a line nobody read.
          </p>
        {/if}

        {#if draft.comments.length === 0}
          <p class="text-[11px] italic text-zinc-600">
            No comments yet — tap a line in Files, or lift a finding from Conversation.
          </p>
        {:else}
          <ul class="flex flex-col gap-1.5">
            {#each draft.comments as c (c.id)}
              <li class="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-2">
                <span
                  class="mt-0.5 flex-none rounded px-1.5 py-0.5 text-[8.5px] font-bold uppercase {SOURCE_CLASS[c.source]}"
                  >{c.source}</span
                >
                <span class="min-w-0 flex-1">
                  {#if c.file}
                    <span class="block truncate font-mono text-[10px] text-zinc-500"
                      >{c.file}{c.line ? `:${c.line}` : ' (in summary)'}{c.line && c.side === 'LEFT' ? ' · deleted line' : ''}</span
                    >
                  {/if}
                  <span class="text-[11.5px] text-zinc-200">{c.text}</span>
                </span>
                <button
                  type="button"
                  onclick={() => screenPrsStore.removeComment(url, c.id)}
                  aria-label="Remove comment"
                  class="flex-none px-1.5 text-zinc-600"
                >×</button>
              </li>
            {/each}
          </ul>
        {/if}

        <div>
          <div class="mb-1 flex items-center gap-2">
            <span class="text-[10px] uppercase tracking-wider text-zinc-600">Summary</span>
            <button
              type="button"
              onclick={() => {
                summaryId = nav.push({ kind: 'compose', url }, () => summarySheet?.holdForDraft() ?? false).id
              }}
              data-testid="dictate-summary"
              class="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300"
            >🎤 Dictate</button>
          </div>
          <textarea
            rows="2"
            placeholder="Overall summary (optional)…"
            value={draft.summary}
            oninput={(e) => screenPrsStore.setSummary(url, e.currentTarget.value)}
            data-testid="summary-field"
            class="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-[12px]
                   text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          ></textarea>
        </div>

        <div class="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1" role="group" aria-label="Verdict">
          {#each VERDICTS as v (v)}
            <button
              type="button"
              onclick={() => chooseVerdict(v)}
              aria-pressed={chosen && draft.verdict === v}
              data-testid="verdict-{v}"
              class="min-h-10 flex-1 rounded-md px-1 text-[11px] leading-tight
                {chosen && draft.verdict === v ? VERDICT_ON[v] : 'text-zinc-400'}"
            >{VERDICT_LABEL[v]}</button>
          {/each}
        </div>

        <button
          type="button"
          onclick={() => {
            clearOutcome()
            confirmId = nav.push({ kind: 'confirm-submit', url }, () => submitting).id
          }}
          disabled={blocked != null}
          title={blocked ?? undefined}
          data-testid="review-submit"
          class="min-h-11 rounded-lg bg-blue-600 px-3 text-sm font-semibold text-white active:bg-blue-500
                 disabled:bg-zinc-800 disabled:text-zinc-500"
        >{blocked ?? 'Submit review…'}</button>
      </div>
    {/if}
  {/if}
</div>

{#if summaryOpen}
  <ComposeSheet
    bind:this={summarySheet}
    title="Review summary"
    sendLabel="Add to summary"
    placeholder="What’s the overall call?"
    onadd={addToSummary}
    onclose={() => nav.close(summaryId)}
  />
{/if}

{#if confirming}
  <ConfirmSubmitModal
    repo={pr.repo}
    number={pr.number}
    {draft}
    {isolatedBase}
    {commentable}
    {submitting}
    {connected}
    {anchors}
    {outcome}
    {latched}
    onacknowledge={() => unknownOutcome.clear(url)}
    onconfirm={() => void post()}
    oncancel={() => nav.close(confirmId)}
  />
{/if}
