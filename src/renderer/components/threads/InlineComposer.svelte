<script lang="ts">
  import { agentThreadsStore } from '../../stores/agentThreads.svelte'

  /** Starts a thread from an editor, in a view zone under the commented lines (`lib/thread-zones.ts`). */
  interface Props {
    /** Where the thread will anchor, e.g. `src/a.ts:12-14`. */
    label: string
    /** Where the typed text is kept until it is sent or cancelled. */
    draftKey: string
    /** Rejects if the thread couldn't be started; the text stays. */
    onsubmit: (body: string) => Promise<void>
    oncancel: () => void
  }

  let { label, draftKey, onsubmit, oncancel }: Props = $props()

  let body = $derived(agentThreadsStore.draft(draftKey))
  let sending = $state(false)
  let error = $state<string | null>(null)
  let box: HTMLTextAreaElement | undefined = $state()

  $effect(() => {
    box?.focus()
  })

  async function submit(): Promise<void> {
    const text = body.trim()
    if (!text || sending) return
    sending = true
    error = null
    try {
      await onsubmit(text)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    sending = false
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      oncancel()
    }
  }
</script>

<div class="my-1 mr-4 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-sans shadow-lg">
  <div class="mb-1 truncate font-mono text-[11px] text-zinc-400">New thread · {label}</div>
  <textarea
    bind:this={box}
    value={body}
    oninput={(e) => agentThreadsStore.setDraft(draftKey, e.currentTarget.value)}
    class="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
    rows="2"
    placeholder="Comment for the agent…"
    aria-label="Comment on these lines"
    {onkeydown}
  ></textarea>
  {#if error}
    <p role="alert" class="text-[11px] text-red-300">{error}</p>
  {/if}
  <div class="mt-1 flex items-center gap-1.5">
    <button
      class="rounded bg-orange-600 px-2 py-0.5 text-[11px] text-white hover:bg-orange-500 disabled:opacity-40"
      disabled={!body.trim() || sending}
      onclick={submit}
    >
      Comment
    </button>
    <button class="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200" onclick={oncancel}>
      Cancel
    </button>
    <span class="flex-1"></span>
    <span class="text-[10px] text-zinc-600">Enter to send · Esc to cancel</span>
  </div>
</div>
