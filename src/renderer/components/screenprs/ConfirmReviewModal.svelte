<script lang="ts">
  import type { PrReviewDraft, PrReviewVerdict } from '../../../shared/screenprs'
  import { anchorCounts, anchorsForHead, buildReviewPayload } from '../../../shared/screenprs'

  let {
    repo,
    number,
    draft,
    headSha,
    isolatedBase = false,
    submitting = false,
    error = null,
    onconfirm,
    oncancel,
  }: {
    repo: string
    number: number
    /** The raw draft — re-anchored here for `headSha`, as main does before posting. */
    draft: PrReviewDraft
    /** The head on screen. Absent: the draft's anchors are previewed as they stand. */
    headSha?: string
    isolatedBase?: boolean
    submitting?: boolean
    error?: string | null
    onconfirm: () => void
    oncancel: () => void
  } = $props()

  // Show what will hit GitHub — the anchored/folded split is computed by the
  // same pure builder the main process posts with, so the preview can't drift.
  // Only main's check against GitHub's own diff is missing here: it can fold
  // more, never fewer.
  let payload = $derived(buildReviewPayload(headSha ? anchorsForHead(draft, headSha) : draft, { isolatedBase }))
  let foldedCount = $derived(draft.comments.length - payload.comments.length)
  // Counted on the raw draft: after `anchorsForHead` a moved anchor looks like
  // a note that never had a line.
  let anchors = $derived(headSha ? anchorCounts(draft, headSha) : null)

  const VERDICT: Record<PrReviewVerdict, { label: string; tone: 'approve' | 'comment' | 'request' }> = {
    approve: { label: 'Approve', tone: 'approve' },
    comment: { label: 'Comment', tone: 'comment' },
    request_changes: { label: 'Request changes', tone: 'request' },
  }
  let v = $derived(VERDICT[draft.verdict])
  const TONE_BTN: Record<'approve' | 'comment' | 'request', string> = {
    approve: 'bg-emerald-600 enabled:hover:bg-emerald-500',
    comment: 'bg-blue-600 enabled:hover:bg-blue-500',
    request: 'bg-red-600 enabled:hover:bg-red-500',
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!submitting) oncancel()
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onclick={() => !submitting && oncancel()}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="w-[460px] rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="Confirm review"
    tabindex="-1"
  >
    <h2 class="text-sm font-semibold text-zinc-100">
      Post review to <span class="font-mono">{repo}#{number}</span>?
    </h2>
    <p class="mt-1 text-[11px] text-zinc-500">This posts to GitHub as you and can’t be undone from here.</p>

    <div class="mt-3 flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-3 text-[12px]">
      <div class="flex items-center gap-2">
        <span class="text-zinc-500">Verdict</span>
        <span
          class="rounded px-1.5 py-0.5 text-[11px] font-semibold
            {v.tone === 'approve' ? 'bg-emerald-500/15 text-emerald-300' : v.tone === 'request' ? 'bg-red-500/15 text-red-300' : 'bg-blue-500/15 text-blue-300'}"
        >{v.label}</span>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
        <span><b class="text-zinc-200">{payload.comments.length}</b> line comment{payload.comments.length === 1 ? '' : 's'} anchored</span>
        {#if foldedCount > 0}
          <span class="text-amber-300/90" data-testid="confirm-folded">{foldedCount} folded into the summary (no diff anchor)</span>
        {/if}
      </div>
      {#if anchors && anchors.moved > 0}
        <p class="text-[11px] leading-relaxed text-amber-300/90" data-testid="confirm-moved">
          {anchors.moved} written against an earlier commit — the branch has moved, so
          {anchors.moved === 1 ? 'that line no longer points' : 'those lines no longer point'} at the code you read.
        </p>
      {/if}
      {#if anchors && anchors.unverified > 0}
        <p class="text-[11px] leading-relaxed text-amber-300/90" data-testid="confirm-unverified">
          {anchors.unverified} that can’t be checked against this branch’s current commit.
        </p>
      {/if}
      {#if payload.body.trim()}
        <div class="mt-1">
          <div class="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">Summary body</div>
          <pre class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-300">{payload.body}</pre>
        </div>
      {/if}
    </div>

    {#if error}
      <div class="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">Couldn’t post: {error}</div>
    {/if}

    <div class="mt-4 flex justify-end gap-2">
      <button
        class="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        onclick={oncancel}
        disabled={submitting}
      >Cancel</button>
      <button
        class="rounded px-3 py-1 text-sm text-white disabled:opacity-60 {TONE_BTN[v.tone]}"
        onclick={onconfirm}
        disabled={submitting}
      >{submitting ? 'Posting…' : `Post ${v.label.toLowerCase()} on GitHub`}</button>
    </div>
  </div>
</div>
