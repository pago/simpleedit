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
   *
   * Text in the field is not in the draft yet, so nothing but this sheet holds
   * it. Every way out — ✕, the scrim, and the system Back gesture through
   * `holdForDraft` — asks before throwing it away.
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

  let text = $state('')
  let confirmingDiscard = $state(false)

  /** True when leaving has to wait — there is text, and the confirm is now up. */
  export function holdForDraft(): boolean {
    if (!text.trim()) return false
    confirmingDiscard = true
    return true
  }

  function requestClose(): void {
    if (!holdForDraft()) onclose()
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-40 flex flex-col justify-end bg-black/60"
  onclick={requestClose}
  inert={confirmingDiscard}
  data-testid="compose-sheet"
>
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
        onclick={requestClose}
        aria-label="Close"
        class="-mr-1 flex-none rounded px-2 py-1 text-sm text-zinc-500"
      >✕</button>
    </div>

    {#if note}
      <p class="mb-2 text-[11px] leading-relaxed text-amber-300/90" data-testid="compose-note">{note}</p>
    {/if}

    <VoiceComposer bind:text onsend={async (value) => { onadd(value); onclose() }} {sendLabel} {placeholder} />
  </div>
</div>

{#if confirmingDiscard}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-6">
    <div class="absolute inset-0 bg-black/70"></div>
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Discard this comment?"
      tabindex="-1"
      class="relative w-full max-w-xs rounded-xl border border-zinc-800 bg-zinc-900 p-4"
      data-testid="compose-discard-confirm"
    >
      <h3 class="text-sm font-semibold text-zinc-100">Discard this comment?</h3>
      <p class="mt-1 text-[11px] leading-relaxed text-zinc-400">It hasn’t been added to the review yet.</p>
      <div class="mt-4 flex gap-2">
        <!-- svelte-ignore a11y_autofocus -->
        <button
          type="button"
          autofocus
          onclick={() => { confirmingDiscard = false }}
          class="min-h-10 flex-1 rounded-lg border border-zinc-700 text-sm text-zinc-200"
        >Keep writing</button>
        <button
          type="button"
          onclick={() => { confirmingDiscard = false; onclose() }}
          data-testid="compose-discard-confirmed"
          class="min-h-10 flex-1 rounded-lg bg-red-600 text-sm font-semibold text-white"
        >Discard</button>
      </div>
    </div>
  </div>
{/if}
