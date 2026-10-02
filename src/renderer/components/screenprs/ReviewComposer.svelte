<script lang="ts">
  import type { PrContext, PrReviewVerdict, PrReviewComment } from '../../../shared/screenprs'
  import { describeFolds } from '../../../shared/screenprs'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import ConfirmReviewModal from './ConfirmReviewModal.svelte'
  import { SOURCE_CLASS } from './commentSource'

  interface Props {
    context: PrContext
    /** Whether a comment's line is in the diff on screen, so it can be revealed and edited there. */
    editable?: (c: PrReviewComment) => boolean
    onreveal?: (c: PrReviewComment) => void
    onedit?: (c: PrReviewComment) => void
  }

  let { context, editable, onreveal, onedit }: Props = $props()

  let url = $derived(context.url)
  let draft = $derived(screenPrsStore.draftFor(url))
  let submitted = $derived(screenPrsStore.submittedFor(url))
  let submitting = $derived(screenPrsStore.isSubmitting(url))
  let draftError = $derived(screenPrsStore.draftError(url))
  let headSha = $derived(context.headSha)
  // Only the isolated compare diff has old-side numbers that aren't GitHub's.
  let isolatedBase = $derived(context.base?.kind === 'polluted' && context.base.isolated)

  let open = $state(false)
  let confirming = $state(false)
  let error = $state<string | null>(null)

  const VERDICT_LABEL: Record<PrReviewVerdict, string> = {
    approve: '✓ Approve',
    comment: 'Comment',
    request_changes: '⟳ Request changes',
  }
  const VERDICTS: PrReviewVerdict[] = ['approve', 'comment', 'request_changes']

  async function confirmPost(): Promise<void> {
    error = null
    try {
      const res = await screenPrsStore.submitReview(context, draft, { headSha, isolatedBase })
      if (!res.ok) error = res.error
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      confirming = false
    }
  }
</script>

<div class="flex-none border-t border-zinc-700 bg-zinc-900">
  {#if submitted}
    <div class="flex items-center gap-2 px-5 py-3 text-[12px] text-emerald-300">
      <span class="font-medium">✓ Review submitted to GitHub — {VERDICT_LABEL[submitted.verdict].replace(/^[✓⟳]\s*/, '')}</span>
      {#if submitted.folded.count > 0}
        <span class="text-[10.5px] text-amber-300/80" data-testid="review-folded"
          >({submitted.folded.count} comment{submitted.folded.count === 1 ? '' : 's'} folded into the summary: {describeFolds(submitted.folded)})</span>
      {/if}
      <div class="flex-1"></div>
      {#if submitted.reviewUrl}
        <button class="text-blue-400 hover:underline" onclick={() => submitted?.reviewUrl && window.api.invoke('app:open-external', submitted.reviewUrl)}>↗ view on GitHub</button>
      {/if}
      <button class="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800" onclick={() => screenPrsStore.resetSubmitted(url)}>Compose another</button>
    </div>
  {:else}
    <button class="flex w-full items-center gap-2 px-5 py-3 text-left text-[12px] text-zinc-200 hover:bg-zinc-800/60" onclick={() => (open = !open)}>
      <span class="text-[10px] text-zinc-500">{open ? '▾' : '▸'}</span>
      <span class="font-semibold">📝 Review to post</span>
      {#if draft.comments.length}
        <span class="rounded-full bg-blue-600 px-1.5 text-[10px] font-bold tabular-nums text-white">{draft.comments.length}</span>
      {/if}
      <div class="flex-1"></div>
      <span class="text-[11px] text-zinc-500">{VERDICT_LABEL[draft.verdict]}</span>
    </button>

    {#if open}
      <div class="flex max-h-[42vh] flex-col gap-2.5 overflow-y-auto px-5 pb-4 pt-0.5">
        <!-- collected line comments -->
        {#if draft.comments.length === 0}
          <div class="py-1 text-[11px] italic text-zinc-600">No line comments yet — add them with ＋ on a diff line or from the findings above (＋ review), or just pick a verdict and post.</div>
        {:else}
          <div class="flex flex-col gap-1.5">
            {#each draft.comments as c (c.id)}
              {@const inDiff = editable?.(c) ?? false}
              <div class="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5" data-testid="composer-comment">
                <span class="mt-0.5 flex-none rounded px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide {SOURCE_CLASS[c.source]}">{c.source}</span>
                <div class="min-w-0 flex-1">
                  {#if c.file}
                    {@const where = `${c.file}${c.line ? ':' + c.line : ''}`}
                    <span class="block font-mono text-[10px] text-zinc-500">
                      {#if inDiff && onreveal}
                        <button type="button" class="hover:text-blue-300 hover:underline" title="Show in the diff" onclick={() => onreveal(c)}>{where}</button>
                      {:else}{where}{/if}
                      {#if c.side === 'LEFT'}<span class="ml-1 text-red-400/80">· deleted line</span>{/if}
                    </span>
                  {/if}
                  <span class="whitespace-pre-wrap text-[11.5px] text-zinc-200">{c.text}</span>
                </div>
                {#if inDiff && onedit}
                  <button class="flex-none rounded px-1.5 text-[10.5px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Edit in the diff" onclick={() => onedit(c)}>Edit</button>
                {/if}
                <button class="flex-none rounded px-1 text-zinc-600 hover:bg-zinc-800 hover:text-red-400" title="Remove" onclick={() => screenPrsStore.removeComment(url, c.id)}>×</button>
              </div>
            {/each}
          </div>
        {/if}

        <!-- overall summary -->
        <textarea
          class="min-h-[46px] w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-[12px] text-zinc-200 outline-none focus:border-blue-500"
          placeholder="Overall review summary (optional)…"
          value={draft.summary}
          oninput={(e) => screenPrsStore.setSummary(url, e.currentTarget.value)}
        ></textarea>

        {#if error}
          <div class="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">Couldn’t post: {error}</div>
        {/if}

        <!-- verdict + submit -->
        <div class="flex items-center gap-2">
          <div class="inline-flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
            {#each VERDICTS as val (val)}
              <button
                class="rounded px-2.5 py-1 text-[11px]
                  {draft.verdict === val
                    ? val === 'approve'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : val === 'request_changes'
                        ? 'bg-red-500/20 text-red-300'
                        : 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'}"
                onclick={() => screenPrsStore.setVerdict(url, val)}
              >{VERDICT_LABEL[val]}</button>
            {/each}
          </div>
          <div class="flex-1"></div>
          <button
            class="rounded-md border border-blue-500 bg-blue-700 px-3 py-1 text-[12px] font-medium text-blue-50 hover:bg-blue-600 disabled:cursor-default disabled:opacity-50"
            title={draftError ?? 'Review the post before it goes to GitHub'}
            disabled={draftError != null}
            onclick={() => (confirming = true)}
          >{VERDICT_LABEL[draft.verdict].replace(/^[✓⟳]\s*/, '')} on GitHub →</button>
        </div>
      </div>
    {/if}
  {/if}
</div>

{#if confirming}
  <ConfirmReviewModal
    repo={context.repo}
    number={context.number}
    {draft}
    {headSha}
    {isolatedBase}
    {submitting}
    onconfirm={confirmPost}
    oncancel={() => (confirming = false)}
  />
{/if}
