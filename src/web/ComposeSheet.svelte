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
   * Text in the field — or a recording still in progress — is not in the
   * draft yet, so nothing but this sheet holds it. Every way out — ✕, the scrim, and the system Back gesture through
   * `holdForDraft` — asks before throwing it away. Editing a comment already in
   * the draft starts the field at its text, and only a change to it is held.
   */
  import VoiceComposer from './VoiceComposer.svelte'
  import DiscardConfirm from './DiscardConfirm.svelte'
  import { untrack } from 'svelte'
  import { draftAtRisk } from './lib/nav'

  interface Props {
    /** What is being commented on: `path:line`, or "Review summary". */
    title: string
    /** The tapped diff line, shown because the keyboard will cover the code. */
    snippet?: string
    /** A caveat about where this text will end up. */
    note?: string
    sendLabel: string
    placeholder: string
    /** The comment's saved text, when editing one rather than writing a new one. */
    initial?: string
    onadd: (text: string) => void
    /** Offered only when editing: takes the comment out of the draft. */
    ondelete?: () => void
    onclose: () => void
  }

  let { title, snippet, note, sendLabel, placeholder, initial = '', onadd, ondelete, onclose }: Props = $props()

  // Mounted once per open, so the starting text never needs to follow the prop.
  let text = $state(untrack(() => initial))
  let confirmingDiscard = $state(false)
  let composer = $state<VoiceComposer | undefined>()

  /** True when leaving has to wait — there is a draft, and the confirm is now up. */
  export function holdForDraft(): boolean {
    if (!draftAtRisk(text, composer?.dictating() ?? false, initial)) return false
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
      {#if ondelete}
        <button
          type="button"
          onclick={() => { ondelete(); onclose() }}
          data-testid="compose-delete"
          class="min-h-9 flex-none rounded border border-red-500/30 px-2.5 text-[11px] text-red-300"
        >Delete</button>
      {/if}
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

    <VoiceComposer bind:this={composer} bind:text onsend={async (value) => { onadd(value); onclose() }} {sendLabel} {placeholder} />
  </div>
</div>

{#if confirmingDiscard}
  <DiscardConfirm
    title={initial ? 'Discard your changes?' : 'Discard this comment?'}
    body={initial ? 'The comment keeps the text it had.' : 'It hasn’t been added to the review yet.'}
    testid="compose-discard-confirm"
    onkeep={() => { confirmingDiscard = false }}
    ondiscard={() => {
      confirmingDiscard = false
      composer?.discardRecording()
      onclose()
    }}
  />
{/if}
