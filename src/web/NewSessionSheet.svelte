<script lang="ts">
  /**
   * Start a session from the phone. One field: the brief.
   *
   * There is nothing else to ask. Agents launch at the project root and create
   * their own worktrees, so there is no branch to name and no directory to
   * browse — the two things that would be miserable here do not exist. Provider
   * and model come from the same default the ✦ button and ⌘T use; a phone is
   * not where you comparison-shop models.
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
   * is worse than saying it again. So every way out of the sheet asks first —
   * ✕, the scrim, Escape, the system Back gesture (`holdForDraft`, asked by the
   * navigation stack before it pops the sheet), and the browser itself, since
   * an iOS PWA reclaiming the tab is the likeliest way to lose one that was
   * just dictated.
   *
   * The socket is deliberately NOT one of its boundaries. The text is local, so
   * a drop costs nothing; Start is what waits for the connection, and says so.
   *
   * **The intent's lifetime spans the attempts.** `requestId` is minted at the
   * first Start and kept until one succeeds, so a tap that fails — or whose
   * answer never arrives — retries the same intent rather than asking for a
   * second session. Main is what enforces that.
   *
   * The corner that needs an exit: main deliberately never re-spawns an intent
   * whose outcome nobody witnessed, so once it holds one, every retry returns
   * the same uncertainty. Without a way out, a timed-out Start becomes a dead
   * end whose only escape destroys the brief. Hence "Start a new session
   * anyway" — a fresh intent, the brief kept, and the duplicate risk named
   * rather than taken on the user's behalf.
   */
  import { onMount, tick } from 'svelte'
  import VoiceComposer from './VoiceComposer.svelte'
  import { briefNudge, labelFromBrief } from '../shared/brief'
  import { draftAtRisk } from './lib/nav'
  import { SESSION_CREATE_REUSED, SESSION_CREATE_UNWITNESSED } from '../shared/ipc-types'
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
  /** An attempt has failed, so main may be holding an outcome nobody saw. */
  let stalled = $state(false)
  /** Only the escape hatch reports here; the composer shows its own failures. */
  let anywayError = $state<string | null>(null)
  let sheetEl = $state<HTMLElement | undefined>()
  let composer = $state<VoiceComposer | undefined>()
  /**
   * The user's intent, not this call. Null until they first commit to starting
   * a session, and cleared only once one exists — or once they deliberately
   * abandon it.
   */
  let requestId: string | null = null

  const nudge = $derived(briefNudge(brief))
  const label = $derived(labelFromBrief(brief))
  const offline = $derived(connection !== 'open')
  const hasBrief = $derived(brief.trim().length > 0)

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

  onMount(() => {
    void tick().then(() => composer?.focusField())
    // The last boundary of the brief's life. It is held nowhere else, so a
    // reclaimed tab or a closed window would take it with no warning at all.
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!brief.trim()) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  })

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
    anywayError = null
    try {
      const created = await window.api.invoke('session:create', { requestId, brief: text })
      // The intent is spent. A later Start in this sheet is a NEW session.
      requestId = null
      stalled = false
      oncreated(created)
    } catch (error) {
      stalled = true
      throw error
    } finally {
      starting = false
    }
  }

  /**
   * The only outcome where a session may exist that nobody has seen.
   *
   * Compared against main's exact wording rather than sniffed for, because
   * everything below turns on this one distinction.
   */
  function unwitnessed(error: unknown): boolean {
    return error instanceof Error && error.message === SESSION_CREATE_UNWITNESSED
  }

  /** The brief was edited since the intent was made, so main won't answer it with the old one. */
  function reused(error: unknown): boolean {
    return error instanceof Error && error.message === SESSION_CREATE_REUSED
  }

  /**
   * Take the duplicate risk — but only after establishing there is one.
   *
   * Abandoning the intent outright would have re-spawned a session that
   * SUCCEEDED: main caches the answer, so a socket that drops before the
   * result frame arrives leaves the phone with a rejection and main with a
   * live session. Re-asking the SAME intent is what tells the two apart —
   * main hands the cached session straight back, and this ends with one agent
   * instead of two.
   *
   * Only when that re-ask comes back unwitnessed again — or refused because
   * the brief was edited since, which makes it a different request — is a
   * fresh intent the user's deliberate choice rather than an accident of the
   * transport.
   */
  async function startAnyway(): Promise<void> {
    if (starting || !hasBrief) return
    anywayError = null
    try {
      await start(brief.trim())
      return
    } catch (error) {
      if (!unwitnessed(error) && !reused(error)) {
        anywayError = error instanceof Error ? error.message : String(error)
        return
      }
    }

    requestId = null
    stalled = false
    try {
      await start(brief.trim())
    } catch (error) {
      anywayError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Whether leaving has to wait: true while a start is in flight (it cannot be
   * cancelled from here) or while there is a brief — typed, or still being
   * recorded — to lose, in which case the discard confirm is now up.
   */
  export function holdForDraft(): boolean {
    if (starting) return true
    if (!draftAtRisk(brief, composer?.dictating() ?? false)) return false
    confirmingDiscard = true
    return true
  }

  /**
   * What leaving would cost, without raising the confirm: a start in flight
   * (which nothing here can cancel), a brief to lose, or nothing.
   */
  export function atRisk(): 'starting' | 'draft' | null {
    if (starting) return 'starting'
    return draftAtRisk(brief, composer?.dictating() ?? false) ? 'draft' : null
  }

  /** Leaving discards the brief, so anything worth losing is asked about. */
  function requestClose(): void {
    if (!holdForDraft()) onclose()
  }

  /**
   * Keep Tab inside the sheet.
   *
   * Not only an accessibility nicety: tabbing OUT while a start is in flight
   * put the discard button within reach, and discarding unmounts the sheet
   * mid-call — the session appears nowhere, so the natural next move is to tap
   * `+` and start a second one.
   */
  function trapTab(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      // Stopped here, or the window handler below sees the confirm this very
      // keystroke just opened and closes it again on the same event.
      event.stopPropagation()
      requestClose()
      return
    }
    if (event.key !== 'Tab' || !sheetEl) return
    const stops = [...sheetEl.querySelectorAll<HTMLElement>('button, textarea, [href], input, select')].filter(
      (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1,
    )
    if (stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    const active = document.activeElement
    if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key !== 'Escape' || !confirmingDiscard) return
    event.preventDefault()
    confirmingDiscard = false
  }}
/>

<!-- A bottom sheet. Line comments and new sessions arrive this way; confirms
     are centred modals, which is why the discard prompt below is not one.
     `inert` while the confirm is up: the sheet is not merely covered, it is
     unreachable — a keyboard could otherwise still reach Start behind it. -->
<div
  bind:this={sheetEl}
  onkeydown={trapTab}
  inert={confirmingDiscard}
  role="dialog"
  aria-modal="true"
  aria-label="New session"
  tabindex="-1"
  class="fixed inset-0 z-40 flex flex-col justify-end"
  data-testid="new-session-sheet"
>
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
      bind:this={composer}
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

    {#if stalled && !starting}
      <div class="mt-2 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2" data-testid="stalled">
        {#if anywayError}
          <p class="mb-1.5 text-[11px] leading-relaxed text-red-300" data-testid="anyway-error">
            {anywayError}
          </p>
        {/if}
        <p class="mb-1.5 text-[11px] leading-relaxed text-zinc-400">
          Start retries the same request, so it can only ever give you one session — including
          one it may already have made. If nothing shows up in the list, ask for a new one:
        </p>
        <button
          type="button"
          onclick={() => void startAnyway()}
          disabled={!hasBrief}
          data-testid="start-anyway"
          class="min-h-10 w-full rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-200
                 active:bg-zinc-800 disabled:opacity-40"
        >Start a new session anyway</button>
      </div>
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
      tabindex="-1"
      class="relative w-full max-w-xs rounded-xl border border-zinc-800 bg-zinc-900 p-4"
      data-testid="discard-confirm"
    >
      <h3 class="text-sm font-semibold text-zinc-100">Discard this brief?</h3>
      <p class="mt-1 text-[11px] leading-relaxed text-zinc-400">
        It isn't kept anywhere — leaving loses what you dictated.
      </p>
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
          onclick={() => {
            confirmingDiscard = false
            // Destroyed here, not left to the unmount: the audio must never be
            // uploaded for a brief the user just threw away.
            composer?.discardRecording()
            onclose()
          }}
          data-testid="discard-confirmed"
          class="min-h-10 flex-1 rounded-lg bg-red-600 text-sm font-semibold text-white"
        >Discard</button>
      </div>
    </div>
  </div>
{/if}
