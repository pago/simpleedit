<script lang="ts">
  /**
   * Starts a Review Room thread on the phone: a question for the companion, or
   * the user's own comment with no question at all (the desktop's
   * `ThreadComposer` at thumb size). The text is kept per place (`draftKey`) in
   * the room's store until the thread exists, so a remount keeps it; a reload
   * would not, so it is registered as unsaved work.
   *
   * Enter adds a newline: a phone keyboard's return key is how a paragraph is
   * typed, so Ask and Draft are buttons.
   */
  import { reviewRoom } from '../renderer/stores/reviewRoom.svelte'
  import { holdUnsaved } from './lib/unsaved-work'

  interface Props {
    draftKey: string
    /** What the thread is on, e.g. `src/a.ts · line 12`. */
    label: string
    /** The tapped line, shown because the keyboard will cover the code. */
    snippet?: string
    /** Why Ask can't be sent from here right now; Draft still works. */
    askBlocked?: string | null
    onask: (text: string) => Promise<void>
    ondraft: (text: string) => Promise<void>
    oncancel?: () => void
  }

  let { draftKey, label, snippet, askBlocked = null, onask, ondraft, oncancel }: Props = $props()

  let busy = $state(false)
  let error = $state<string | null>(null)
  let text = $derived(reviewRoom.askDraft(draftKey))

  $effect(() => holdUnsaved(() => (text.trim() ? `your unsent thread on ${label}` : null)))

  async function submit(action: (text: string) => Promise<void>): Promise<void> {
    const body = text.trim()
    if (!body || busy) return
    busy = true
    error = null
    try {
      await action(body)
      // Only what went out: anything typed while it was in flight stays.
      if (reviewRoom.askDraft(draftKey).trim() === body) reviewRoom.setAskDraft(draftKey, '')
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    busy = false
  }
</script>

<div class="my-2 rounded-lg border border-blue-500/70 bg-zinc-900 p-2.5 font-sans" data-testid="room-composer">
  <div class="mb-1 truncate text-[11px] text-zinc-500">{label}</div>
  {#if snippet}
    <pre class="mb-1.5 max-h-16 overflow-hidden whitespace-pre-wrap rounded bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-400">{snippet}</pre>
  {/if}
  <textarea
    class="min-h-20 w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-blue-500"
    placeholder="Ask the companion, or write the comment you want to post"
    aria-label="New thread"
    value={text}
    oninput={(e) => reviewRoom.setAskDraft(draftKey, e.currentTarget.value)}
  ></textarea>
  {#if error}<p role="alert" class="mt-1 text-[12px] text-red-300">{error}</p>{/if}
  {#if askBlocked}<p class="mt-1 text-[11px] text-amber-300/90" data-testid="ask-blocked">{askBlocked}</p>{/if}
  <div class="mt-2 flex items-center gap-2">
    {#if oncancel}
      <button type="button" class="min-h-10 px-2 text-sm text-zinc-400" onclick={oncancel}>Cancel</button>
    {/if}
    <span class="flex-1"></span>
    <button
      type="button"
      class="min-h-10 rounded-lg bg-blue-600 px-3 text-sm font-semibold text-white active:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500"
      disabled={!text.trim() || busy}
      data-testid="composer-draft"
      onclick={() => submit(ondraft)}
    >Draft comment</button>
    <button
      type="button"
      class="min-h-10 rounded-lg bg-violet-500/20 px-3 text-sm font-semibold text-violet-200 active:bg-violet-500/30 disabled:opacity-40"
      disabled={!text.trim() || busy || !!askBlocked}
      data-testid="composer-ask"
      onclick={() => submit(onask)}
    >Ask</button>
  </div>
</div>
