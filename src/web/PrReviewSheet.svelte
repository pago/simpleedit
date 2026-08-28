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
   * The draft lives in the shared store, keyed by PR url, for the life of the
   * PAGE — not of this screen. Leaving a PR and coming back keeps what you
   * dictated, which on a phone is the difference between a usable review and a
   * lost one; a reconnect keeps it too, since nothing about it lives on the Mac.
   * A reload drops it, deliberately: a draft restored days later would carry
   * line anchors into a head SHA that has moved.
   *
   * Within a session that same move is handled rather than prevented: the
   * `draft` arriving here has already been through `reanchorForHead`, so a
   * comment written against an older commit has lost its line and folds into
   * the body instead of landing on whatever now occupies that number.
   */
  import { screenPrsStore } from '../renderer/stores/screenprs.svelte'
  import { staleAnchorCount } from '../shared/screenprs'
  import type { PrRef, PrReviewCommentSource, PrReviewDraft, PrReviewVerdict } from '../shared/screenprs'
  import { unknownOutcome, verdictChoice, type SubmitOutcome } from './lib/prs.svelte'
  import { NotSentError } from './api-shim'
  import ComposeSheet from './ComposeSheet.svelte'
  import ConfirmSubmitModal from './ConfirmSubmitModal.svelte'

  interface Props {
    pr: Pick<PrRef, 'owner' | 'repo' | 'number' | 'url'>
    /**
     * The draft as it would be POSTED — already re-anchored for the current
     * head. Passed in rather than read from the store so that what is shown,
     * what is counted in the confirm, and what is sent are the same object.
     */
    draft: PrReviewDraft
    /** The head the diff on screen belongs to; '' while the PR is still screening. */
    headSha: string
    /** Whether the socket is open right now — read at the point of use. */
    connected: boolean
  }

  let { pr, draft, headSha, connected }: Props = $props()

  let url = $derived(pr.url)
  let submitted = $derived(screenPrsStore.submittedFor(url))
  let submitting = $derived(screenPrsStore.isSubmitting(url))
  let draftError = $derived(screenPrsStore.draftError(url))
  let chosen = $derived(verdictChoice.made(url))
  let latched = $derived(unknownOutcome.pending(url))
  let staleCount = $derived(staleAnchorCount(draft, headSha))

  let open = $state(false)
  let confirming = $state(false)
  let summaryOpen = $state(false)
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
      const res = await screenPrsStore.submitReview(pr, draft)
      if (res.ok) {
        confirming = false
        // Posted and done with: a follow-up starts from no verdict.
        verdictChoice.reset(url)
        unknownOutcome.clear(url)
      } else {
        // Main answered. Whatever went wrong, nothing was posted.
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
      {#if submitted.foldedComments}
        <p class="mt-1 text-[11px] text-amber-300/80">
          Some comments couldn’t anchor to the diff and were folded into the summary.
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

    {#if open}
      <div class="flex max-h-[52vh] flex-col gap-2.5 overflow-y-auto px-3 pb-3">
        {#if staleCount > 0}
          <p
            class="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200"
            data-testid="stale-notice"
          >
            The branch moved since {staleCount === 1 ? 'a comment was' : `${staleCount} comments were`} written.
            {staleCount === 1 ? 'Its' : 'Their'} line number would now point at different code, so
            {staleCount === 1 ? 'it goes' : 'they go'} in the summary instead of on a line.
          </p>
        {/if}

        {#if draft.comments.length === 0}
          <p class="text-[11px] italic text-zinc-600">
            No comments yet — tap a line in Files, or lift a finding from Conversation.
          </p>
        {:else}
          <ul class="flex flex-col gap-1.5">
            {#each draft.comments as c, i (c.source + c.file + c.line + c.text)}
              <li class="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-2">
                <span
                  class="mt-0.5 flex-none rounded px-1.5 py-0.5 text-[8.5px] font-bold uppercase {SOURCE_CLASS[c.source]}"
                  >{c.source}</span
                >
                <span class="min-w-0 flex-1">
                  {#if c.file}
                    <span class="block truncate font-mono text-[10px] text-zinc-500"
                      >{c.file}{c.line ? `:${c.line}` : ' (in summary)'}</span
                    >
                  {/if}
                  <span class="text-[11.5px] text-zinc-200">{c.text}</span>
                </span>
                <button
                  type="button"
                  onclick={() => screenPrsStore.removeComment(url, i)}
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
              onclick={() => (summaryOpen = true)}
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
          onclick={() => { clearOutcome(); confirming = true }}
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
    title="Review summary"
    sendLabel="Add to summary"
    placeholder="What’s the overall call?"
    onadd={addToSummary}
    onclose={() => (summaryOpen = false)}
  />
{/if}

{#if confirming}
  <ConfirmSubmitModal
    repo={pr.repo}
    number={pr.number}
    {draft}
    {submitting}
    {connected}
    {staleCount}
    {outcome}
    {latched}
    onacknowledge={() => unknownOutcome.clear(url)}
    onconfirm={() => void post()}
    oncancel={() => (confirming = false)}
  />
{/if}
