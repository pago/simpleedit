<script lang="ts">
  /**
   * A bottom sheet that composes text into the review draft — a line comment,
   * or the summary.
   *
   * Sheets are where composition happens (the chrome rule: line comments arrive
   * as bottom sheets, confirms as centred modals), and this one is deliberately
   * the ONLY way voice reaches a review. The composer inside is the same
   * `VoiceComposer` the session reply uses, so a transcript still lands in a
   * field to be read before it is committed — and the most this button can do
   * is add text to a local draft. Between a microphone and GitHub there remain
   * a verdict tap and a confirm.
   */
  import VoiceComposer from './VoiceComposer.svelte'

  interface Props {
    /** What is being commented on: `path:line`, or "Review summary". */
    title: string
    /** The tapped diff line, shown because the keyboard will cover the code. */
    snippet?: string
    /** A caveat about where this text will end up. */
    note?: string
    sendLabel: string
    placeholder: string
    onadd: (text: string) => void
    onclose: () => void
  }

  let { title, snippet, note, sendLabel, placeholder, onadd, onclose }: Props = $props()
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-40 flex flex-col justify-end bg-black/60" onclick={onclose} data-testid="compose-sheet">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="rounded-t-2xl border-t border-zinc-700 bg-zinc-950 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    onclick={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
  >
    <div class="mb-2 flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <p class="truncate font-mono text-[11px] text-zinc-400" data-testid="compose-title">{title}</p>
        {#if snippet}
          <pre
            class="mt-1 overflow-x-auto rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[10.5px] text-zinc-400">{snippet}</pre>
        {/if}
      </div>
      <button
        type="button"
        onclick={onclose}
        aria-label="Close"
        class="-mr-1 flex-none rounded px-2 py-1 text-sm text-zinc-500"
      >✕</button>
    </div>

    {#if note}
      <p class="mb-2 text-[11px] leading-relaxed text-amber-300/90" data-testid="compose-note">{note}</p>
    {/if}

    <VoiceComposer onsend={async (text) => { onadd(text); onclose() }} {sendLabel} {placeholder} />
  </div>
</div>
