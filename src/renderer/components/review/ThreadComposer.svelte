<script lang="ts">
  /**
   * Starts a thread: a question for the companion, or the user's own comment
   * with no question at all. The text is kept per place (`draftKey`) until the
   * thread exists, so a remount or a cancelled shift-click doesn't lose it.
   */
  import { reviewRoom } from '../../stores/reviewRoom.svelte'

  interface Props {
    draftKey: string
    /** What the thread is on, e.g. `Line 12` or `the whole stack`. */
    label: string
    onask: (text: string) => Promise<void>
    ondraft: (text: string) => Promise<void>
    oncancel?: () => void
    autofocus?: boolean
  }

  let { draftKey, label, onask, ondraft, oncancel, autofocus = true }: Props = $props()

  let field = $state<HTMLTextAreaElement>()
  let busy = $state(false)
  let error = $state<string | null>(null)
  let text = $derived(reviewRoom.askDraft(draftKey))

  $effect(() => {
    if (autofocus) field?.focus()
  })

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

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault()
      void submit(onask)
    } else if (e.key === 'Escape' && oncancel) {
      e.preventDefault()
      oncancel()
    }
  }
</script>

<div class="my-1.5 max-w-[760px] rounded-md border border-blue-500/70 bg-zinc-900 p-2 font-sans" data-testid="thread-composer">
  <div class="mb-1 text-[10.5px] text-zinc-500">{label}</div>
  <textarea
    bind:this={field}
    class="min-h-14 w-full resize-y bg-transparent text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
    placeholder="Ask the companion, or write the comment you want to post"
    aria-label="New thread"
    value={text}
    oninput={(e) => reviewRoom.setAskDraft(draftKey, e.currentTarget.value)}
    onkeydown={onKeydown}
  ></textarea>
  {#if error}<p role="alert" class="mb-1 text-[11px] text-red-300">{error}</p>{/if}
  <div class="flex items-center justify-end gap-1.5">
    {#if oncancel}
      <button type="button" class="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" onclick={oncancel}>Cancel</button>
    {/if}
    <button type="button" class="rounded bg-blue-600 px-2.5 py-0.5 text-[11.5px] text-white hover:bg-blue-500 disabled:opacity-40" disabled={!text.trim() || busy} onclick={() => submit(ondraft)}>
      Draft comment
    </button>
    <button
      type="button"
      class="rounded bg-violet-500/15 px-2.5 py-0.5 text-[11.5px] font-semibold text-violet-300 hover:bg-violet-500/25 disabled:opacity-40"
      disabled={!text.trim() || busy}
      onclick={() => submit(onask)}
    >Ask companion</button>
  </div>
</div>
