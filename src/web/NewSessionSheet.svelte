<script lang="ts">
  /**
   * Start a session from the phone. One field: the brief.
   *
   * There is nothing else to ask. Agents launch at the project root and create
   * their own worktrees, so there is no branch to name and no directory to
   * browse — the two things that would be miserable here do not exist. Provider
   * and model come from the same default ⌘T uses; a phone is not where you
   * comparison-shop models.
   *
   * The composer is the reply composer, unchanged: the same hold-to-talk, the
   * same mandatory transcript review. Only the button's word differs.
   *
   * ── What this screen is designed against ────────────────────────────────
   * A thin brief makes the agent open with a clarifying question, so you have
   * created a BLOCKED session instead of filling a free slot — a net loss
   * against the whole point of starting work from a phone. Voice makes a full
   * brief cheap, so the nudge is a nudge: it never refuses to start. A wrong
   * refusal costs more than a thin brief, and the user knows what they meant.
   *
   * ── Lifetimes ───────────────────────────────────────────────────────────
   * **The brief's lifetime is the sheet's.** It is never persisted and never
   * resurrected: a half-finished brief replayed into a live spawn days later
   * is worse than saying it again. Dismissing therefore discards it — but not
   * silently, so a non-empty brief asks first.
   *
   * The socket is deliberately NOT one of its boundaries. The text is local, so
   * a drop costs nothing; Start is what waits for the connection, and says so.
   *
   * **The intent's lifetime spans the attempts.** `requestId` is minted at the
   * first Start and kept until one succeeds, so a tap that fails — or whose
   * answer never arrives — retries the same intent rather than asking for a
   * second session. Main is what enforces that; this only has to stop naming
   * the same intent twice.
   */
  import VoiceComposer from './VoiceComposer.svelte'
  import { briefNudge, labelFromBrief } from '../shared/brief'
  import type { ConnectionState } from './api-shim'
  import type { SessionCreateResult } from '../shared/ipc-types'

  interface Props {
    connection: ConnectionState
    /** A session exists. The sheet is done; the host decides what to show. */
    oncreated: (created: SessionCreateResult) => void
    onclose: () => void
  }

  let { connection, oncreated, onclose }: Props = $props()

  let brief = $state('')
  let starting = $state(false)
  let confirmingDiscard = $state(false)
  /**
   * The user's intent, not this call. Null until they first commit to starting
   * a session, and cleared only once one exists.
   */
  let requestId: string | null = null

  const nudge = $derived(briefNudge(brief))
  const label = $derived(labelFromBrief(brief))
  const offline = $derived(connection !== 'open')

  /**
   * `randomUUID` needs a secure context, which the Tailscale HTTPS transport
   * always is — but typing has to keep working even where the microphone
   * cannot open, so this never becomes the reason the sheet fails.
   */
  function mintRequestId(): string {
    return (
      globalThis.crypto?.randomUUID?.() ??
      `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    )
  }

  /**
   * Throwing is how the composer learns it failed: it keeps the brief in the
   * field and shows the reason, which is exactly what a failed start needs.
   */
  async function start(text: string): Promise<void> {
    if (offline) {
      throw new Error('Not connected to the Mac. The brief is safe here — try again in a moment.')
    }
    requestId ??= mintRequestId()
    starting = true
    try {
      const created = await window.api.invoke('session:create', { requestId, brief: text })
      // The intent is spent. A later Start in this sheet is a NEW session.
      requestId = null
      oncreated(created)
    } finally {
      starting = false
    }
  }

  /** Leaving discards the brief, so anything worth losing is asked about. */
  function requestClose(): void {
    if (starting) return
    if (brief.trim()) {
      confirmingDiscard = true
      return
    }
    onclose()
  }
</script>

<!-- A bottom sheet. Line comments and new sessions arrive this way; confirms
     are centred modals, which is why the discard prompt below is not one. -->
<div class="fixed inset-0 z-40 flex flex-col justify-end" data-testid="new-session-sheet">
  <button
    type="button"
    aria-label="Dismiss"
    onclick={requestClose}
    class="flex-1 bg-black/60"
    data-testid="sheet-scrim"
  ></button>

  <div
    class="flex-none rounded-t-2xl border-t border-zinc-800 bg-zinc-950 px-3 pt-3
           pb-[max(0.75rem,env(safe-area-inset-bottom))]"
  >
    <div class="mb-2 flex items-center gap-2">
      <h2 class="min-w-0 flex-1 text-[15px] font-semibold text-zinc-100">New session</h2>
      <button
        type="button"
        onclick={requestClose}
        disabled={starting}
        data-testid="sheet-close"
        class="-mr-1 min-h-9 px-2 text-sm text-zinc-400 disabled:opacity-40"
      >Cancel</button>
    </div>

    <p class="mb-2 text-[11px] leading-relaxed text-zinc-500">
      It starts at the project root and makes its own worktree. Say what to do.
    </p>

    <VoiceComposer
      bind:text={brief}
      onsend={start}
      sendLabel="Start"
      placeholder="What should the agent do?"
    />

    {#if starting}
      <p class="mt-2 text-[11px] text-amber-400" data-testid="starting-note">
        Starting — this can't be cancelled from here.
      </p>
    {:else if offline}
      <p class="mt-2 text-[11px] text-amber-400" data-testid="offline-note">
        Not connected. The brief is safe here; Start works once the dot goes green.
      </p>
    {:else if nudge}
      <p class="mt-2 text-[11px] leading-relaxed text-amber-400/90" data-testid="brief-nudge">
        {nudge}
      </p>
    {:else if label}
      <p class="mt-2 text-[11px] text-zinc-500" data-testid="label-preview">
        Appears as “{label}” until it renames itself.
      </p>
    {/if}
  </div>
</div>

{#if confirmingDiscard}
  <!-- Centred modal: this is a confirm, not a sheet. -->
  <div class="fixed inset-0 z-50 flex items-center justify-center p-6">
    <div class="absolute inset-0 bg-black/70"></div>
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Discard this brief?"
      class="relative w-full max-w-xs rounded-xl border border-zinc-800 bg-zinc-900 p-4"
      data-testid="discard-confirm"
    >
      <h3 class="text-sm font-semibold text-zinc-100">Discard this brief?</h3>
      <p class="mt-1 text-[11px] leading-relaxed text-zinc-400">
        It isn't kept anywhere — leaving loses what you dictated.
      </p>
      <div class="mt-4 flex gap-2">
        <button
          type="button"
          onclick={() => { confirmingDiscard = false }}
          class="min-h-10 flex-1 rounded-lg border border-zinc-700 text-sm text-zinc-200"
        >Keep writing</button>
        <button
          type="button"
          onclick={() => { confirmingDiscard = false; onclose() }}
          data-testid="discard-confirmed"
          class="min-h-10 flex-1 rounded-lg bg-red-600 text-sm font-semibold text-white"
        >Discard</button>
      </div>
    </div>
  </div>
{/if}
