<script lang="ts">
  /**
   * Verdict, summary, submit — the only path from this phone to GitHub.
   *
   * The invariant it exists to hold: **nothing reaches `screenprs:submit-review`
   * without the user having seen the verdict and the comment count and confirmed
   * that exact action.** Three things enforce it, none of them a comment:
   *
   *  - The verdict must be TAPPED. `emptyReviewDraft()` starts at `approve`,
   *    which at a desk is a sensible default and on a phone would make approval
   *    the result of not deciding. Submit stays dead until `verdictChoice`.
   *  - Submit opens a confirm; only the confirm invokes. Never a swipe, and the
   *    microphone can reach neither (`ComposeSheet` only ever adds draft text).
   *  - A closed socket disables the post outright, so the write is never
   *    attempted into a connection that will reject it.
   *
   * ── Draft lifetime ───────────────────────────────────────────────────────
   * The draft lives in the shared store, keyed by PR url, for the life of the
   * PAGE — not of this screen. Leaving a PR and coming back keeps what you
   * dictated, which on a phone is the difference between a usable review and a
   * lost one; a reconnect keeps it too, since nothing about it lives on the Mac.
   * A reload drops it, deliberately: a draft restored days later would carry
   * line anchors into a head SHA that has moved, and a stale anchor is worse
   * than retyping. Nothing is ever posted from a resurrected draft without the
   * confirm naming its verdict and counts first.
   */
  import { screenPrsStore } from '../renderer/stores/screenprs.svelte'
  import type { PrRef, PrReviewCommentSource, PrReviewVerdict } from '../shared/screenprs'
  import { verdictChoice } from './lib/prs.svelte'
  import ComposeSheet from './ComposeSheet.svelte'
  import ConfirmSubmitModal from './ConfirmSubmitModal.svelte'

  interface Props {
    pr: Pick<PrRef, 'owner' | 'repo' | 'number' | 'url'>
    /** Whether the socket is open right now — read at the point of use. */
    connected: boolean
  }

  let { pr, connected }: Props = $props()

  let url = $derived(pr.url)
  let draft = $derived(screenPrsStore.draftFor(url))
  let submitted = $derived(screenPrsStore.submittedFor(url))
  let submitting = $derived(screenPrsStore.isSubmitting(url))
  let draftError = $derived(screenPrsStore.draftError(url))
  let chosen = $derived(verdictChoice.made(url))

  let open = $state(false)
  let confirming = $state(false)
  let summaryOpen = $state(false)
  let error = $state<string | null>(null)

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

  let blocked = $derived(
    !chosen ? 'Choose a verdict first.' : draftError,
  )

  function chooseVerdict(v: PrReviewVerdict): void {
    screenPrsStore.setVerdict(url, v)
    verdictChoice.make(url)
    error = null
  }

  async function post(): Promise<void> {
    error = null
    // Re-checked here, not just on the disabled button: an `invoke` written to a
    // closed socket is QUEUED by the shim, not rejected — it would post on the
    // next reconnect, while this modal claimed it had already gone.
    if (!connected) {
      error = 'Not connected to the Mac — nothing was sent.'
      return
    }
    try {
      const res = await screenPrsStore.submitReview(pr, draft)
      if (res.ok) {
        confirming = false
        // A posted review is done with; a follow-up starts from no verdict.
        verdictChoice.reset(url)
      } else {
        // Main answered. Whatever went wrong, nothing was posted.
        error = res.error
      }
    } catch {
      // The socket died before main answered, so we do NOT know whether GitHub
      // took it. Retrying blind could double-post; say so and let the user look.
      error =
        `The connection dropped before the Mac answered, so it isn’t known whether the review was ` +
        `posted. Check ${pr.repo}#${pr.number} on GitHub before posting again.`
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
          onclick={() => { error = null; confirming = true }}
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
    {error}
    onconfirm={() => void post()}
    oncancel={() => (confirming = false)}
  />
{/if}
