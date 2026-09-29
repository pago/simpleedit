<script lang="ts">
  /**
   * The last door before GitHub.
   *
   * Same shape and same source of truth as the desktop `ConfirmReviewModal`:
   * the preview is computed by `buildReviewPayload`, the very function main
   * posts with, so what this names — the verdict, the anchored count, what got
   * folded — cannot drift from what is sent. Only the geometry differs; a 460px
   * dialog is not a phone.
   *
   * Being the last door before an irreversible write, it behaves like one:
   *
   *  - **It takes focus and keeps it.** Tab cycles inside; the sheet behind is
   *    not reachable by keyboard while this is up.
   *  - **Escape cancels**, unless a post is already in flight.
   *  - **A dropped socket disables posting**, so the write is never attempted
   *    into a connection that would reject it.
   *  - **Once tapped it is explicitly NOT cancellable.** GitHub has no unsend,
   *    so a Cancel button beside an in-flight POST would be a lie; it is
   *    replaced by a line saying so.
   *  - **An unanswered submit latches.** The reviews API has no idempotency
   *    key, so posting again after an outcome nobody knows is how one review
   *    becomes two. Re-arming takes an explicit acknowledgement.
   */
  import { buildReviewPayload, type AnchorState, type PrReviewDraft, type PrReviewVerdict } from '../shared/screenprs'
  import type { SubmitOutcome } from './lib/prs.svelte'

  interface Props {
    repo: string
    number: number
    draft: PrReviewDraft
    submitting: boolean
    connected: boolean
    /** How many comments are in each anchor state, so the two reasons a line
     *  was dropped can be named apart. */
    anchors: Record<AnchorState, number>
    /** How the last attempt ended, or null if there hasn't been one. */
    outcome: SubmitOutcome | null
    /** True while an unanswered submit is holding the post button down. */
    latched: boolean
    onacknowledge: () => void
    onconfirm: () => void
    oncancel: () => void
  }

  let {
    repo, number, draft, submitting, connected, anchors, outcome, latched,
    onacknowledge, onconfirm, oncancel,
  }: Props = $props()

  let payload = $derived(buildReviewPayload(draft))
  let foldedCount = $derived(draft.comments.length - payload.comments.length)

  const VERDICT: Record<PrReviewVerdict, { label: string; chip: string; button: string }> = {
    approve: { label: 'Approve', chip: 'bg-emerald-500/15 text-emerald-300', button: 'bg-emerald-600' },
    comment: { label: 'Comment', chip: 'bg-blue-500/15 text-blue-300', button: 'bg-blue-600' },
    request_changes: { label: 'Request changes', chip: 'bg-red-500/15 text-red-300', button: 'bg-red-600' },
  }
  let v = $derived(VERDICT[draft.verdict])
  let canPost = $derived(!submitting && connected && !latched)

  let dialog = $state<HTMLDivElement | undefined>()

  // Captured during init, before the effect below moves focus, so it can be
  // handed back when this closes.
  const opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  $effect(() => () => opener?.focus())

  /**
   * Keep focus inside the dialog — on open, and again whenever the element
   * holding it goes away.
   *
   * That second case is not hypothetical: pressing Post disables it and
   * replaces Cancel with a paragraph, so `activeElement` falls back to `body`,
   * OUTSIDE the element that owns `onkeydown`. Tab would then walk into the
   * sheet behind and Escape would reach nothing — while an irreversible write
   * is in flight, which is the worst moment for either.
   */
  $effect(() => {
    void submitting
    void latched
    const here = document.activeElement
    if (!dialog || here === dialog || (here instanceof Node && dialog.contains(here))) return
    dialog.focus()
  })

  function focusable(): HTMLElement[] {
    return [...(dialog?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])]
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      // Dismisses even mid-post. It does NOT cancel the write — nothing can —
      // but a `gh` that hangs must not leave the reviewer sealed inside a focus
      // trap with no key that does anything. The outcome lands in the sheet.
      e.preventDefault()
      oncancel()
      return
    }
    if (e.key !== 'Tab') return
    const stops = focusable()
    if (stops.length === 0) {
      e.preventDefault()
      return
    }
    const first = stops[0]
    const last = stops[stops.length - 1]
    const here = document.activeElement
    if (e.shiftKey && (here === first || here === dialog)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && here === last) {
      e.preventDefault()
      first.focus()
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
  onclick={() => !submitting && oncancel()}
  data-testid="confirm-submit"
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    bind:this={dialog}
    class="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-4"
    onclick={(e) => e.stopPropagation()}
    {onkeydown}
    role="dialog"
    aria-modal="true"
    aria-label="Confirm review"
    tabindex="-1"
  >
    <h2 class="text-sm font-semibold text-zinc-100">
      Post review to <span class="font-mono">{repo}#{number}</span>?
    </h2>
    <p class="mt-1 text-[11px] text-zinc-500">This posts to GitHub as you and can’t be undone.</p>

    <div class="mt-3 flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
      <div class="flex items-center gap-2 text-[12px]">
        <span class="text-zinc-500">Verdict</span>
        <span class="rounded px-1.5 py-0.5 text-[11px] font-semibold {v.chip}" data-testid="confirm-verdict"
          >{v.label}</span
        >
      </div>
      <div class="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-400">
        <span data-testid="confirm-anchored"
          ><b class="text-zinc-200">{payload.comments.length}</b> line comment{payload.comments.length === 1
            ? ''
            : 's'} anchored</span
        >
        {#if foldedCount > 0}
          <span class="text-amber-300/90" data-testid="confirm-folded"
            >{foldedCount} folded into the summary (no diff anchor)</span
          >
        {/if}
      </div>
      {#if anchors.moved > 0}
        <p class="text-[11px] leading-relaxed text-amber-300/90" data-testid="confirm-moved">
          {anchors.moved} written against an earlier commit — the branch has moved, so
          {anchors.moved === 1 ? 'that line no longer points' : 'those lines no longer point'} at the code you read.
        </p>
      {/if}
      {#if anchors.unverified > 0}
        <p class="text-[11px] leading-relaxed text-amber-300/90" data-testid="confirm-unverified">
          {anchors.unverified} that can’t be checked against this branch’s current commit.
        </p>
      {/if}
      {#if payload.body.trim()}
        <pre
          class="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-300">{payload.body}</pre>
      {/if}
    </div>

    {#if !connected}
      <p
        class="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300"
        data-testid="confirm-offline"
      >Disconnected from the Mac. Reconnect before posting.</p>
    {/if}

    {#if outcome}
      <p
        class="mt-3 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed
          {outcome.kind === 'unknown'
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
            : 'border-red-500/30 bg-red-500/10 text-red-300'}"
        data-testid="confirm-error"
      >{outcome.message}</p>
    {/if}

    <div class="mt-4 flex flex-col gap-2">
      {#if latched}
        <button
          type="button"
          onclick={onacknowledge}
          data-testid="confirm-acknowledge"
          class="min-h-11 rounded-lg border border-amber-500/50 px-3 text-sm font-semibold text-amber-200"
        >I checked GitHub — let me post anyway</button>
      {/if}
      <button
        type="button"
        onclick={onconfirm}
        disabled={!canPost}
        data-testid="confirm-post"
        class="min-h-11 rounded-lg px-3 text-sm font-semibold text-white disabled:bg-zinc-800 disabled:text-zinc-500 {v.button}"
      >{submitting ? 'Posting…' : `Post ${v.label.toLowerCase()} on GitHub`}</button>
      {#if submitting}
        <p class="text-center text-[11px] text-zinc-500" data-testid="not-cancellable">
          Already sent to GitHub — this can’t be cancelled. Esc closes this box; the result appears below.
        </p>
      {:else}
        <button
          type="button"
          onclick={oncancel}
          data-testid="confirm-cancel"
          class="min-h-11 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-300"
        >Cancel</button>
      {/if}
    </div>
  </div>
</div>
