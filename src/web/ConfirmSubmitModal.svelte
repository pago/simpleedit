<script lang="ts">
  /**
   * The last door before GitHub.
   *
   * Same shape and same source of truth as the desktop `ConfirmReviewModal`:
   * the preview is computed by `buildReviewPayload`, the very function main
   * posts with, so what this names — the verdict, the anchored count, what got
   * folded — cannot drift from what is sent. Only the geometry is different; a
   * 460px dialog is not a phone.
   *
   * Two things this adds because the phone has them and the desk does not:
   *
   *  - **A dropped socket disables posting.** The submit is an `invoke`, and an
   *    invoke over a dead socket rejects — so posting while `closed` could only
   *    produce a failure the user would then have to interpret.
   *  - **Once tapped, it is explicitly NOT cancellable.** GitHub has no unsend,
   *    so a Cancel button next to an in-flight POST would be a lie. It is
   *    replaced by a line that says so.
   */
  import { buildReviewPayload, type PrReviewDraft, type PrReviewVerdict } from '../shared/screenprs'

  interface Props {
    repo: string
    number: number
    draft: PrReviewDraft
    submitting: boolean
    connected: boolean
    /** A failure message, or null. */
    error: string | null
    onconfirm: () => void
    oncancel: () => void
  }

  let { repo, number, draft, submitting, connected, error, onconfirm, oncancel }: Props = $props()

  let payload = $derived(buildReviewPayload(draft))
  let foldedCount = $derived(draft.comments.length - payload.comments.length)

  const VERDICT: Record<PrReviewVerdict, { label: string; chip: string; button: string }> = {
    approve: { label: 'Approve', chip: 'bg-emerald-500/15 text-emerald-300', button: 'bg-emerald-600' },
    comment: { label: 'Comment', chip: 'bg-blue-500/15 text-blue-300', button: 'bg-blue-600' },
    request_changes: { label: 'Request changes', chip: 'bg-red-500/15 text-red-300', button: 'bg-red-600' },
  }
  let v = $derived(VERDICT[draft.verdict])
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
  onclick={() => !submitting && oncancel()}
  data-testid="confirm-submit"
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-4"
    onclick={(e) => e.stopPropagation()}
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
      {#if payload.body.trim()}
        <pre
          class="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-300">{payload.body}</pre>
      {/if}
    </div>

    {#if !connected}
      <p class="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300"
        data-testid="confirm-offline">
        Disconnected from the Mac. Reconnect before posting.
      </p>
    {/if}

    {#if error}
      <p class="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-300"
        data-testid="confirm-error">{error}</p>
    {/if}

    <div class="mt-4 flex flex-col gap-2">
      <button
        type="button"
        onclick={onconfirm}
        disabled={submitting || !connected}
        data-testid="confirm-post"
        class="min-h-11 rounded-lg px-3 text-sm font-semibold text-white disabled:bg-zinc-800 disabled:text-zinc-500 {v.button}"
      >{submitting ? 'Posting…' : `Post ${v.label.toLowerCase()} on GitHub`}</button>
      {#if submitting}
        <p class="text-center text-[11px] text-zinc-500" data-testid="not-cancellable">
          Already sent to GitHub — this can’t be cancelled.
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
