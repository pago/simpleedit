<script lang="ts">
  /**
   * The mobile shell.
   *
   * Two chrome rules, held here so no screen can drift from them:
   *
   *  - A **top-level** screen has a title, at most one trailing action, and the
   *    tab bar. Never a segmented control.
   *  - A **detail** screen has a back button and a title, and no tab bar. It
   *    may have a segmented control, but only when it genuinely has two panes,
   *    and labelled for that screen — Session's is Terminal / Changes, PR's is
   *    Conversation / Files. The control belongs to the screen; this header
   *    never carries one.
   *
   * Two tabs, each with at most one detail screen on top of it, and sheets and
   * modals above that. Depth stops there deliberately — nothing here needs a
   * navigation stack, and a back button that could mean four different things
   * is worse than one that always means "out of this detail".
   */
  import SessionsScreen from './SessionsScreen.svelte'
  import SessionScreen from './SessionScreen.svelte'
  import NewSessionSheet from './NewSessionSheet.svelte'
  import PrBoard from './PrBoard.svelte'
  import PrDetail from './PrDetail.svelte'
  import { onOpenSession } from './lib/push-client'
  import { sessionFromUrl } from './lib/push-payload'
  import type { ConnectionState, RemoteConnection } from './api-shim'
  import type { SessionCreateResult, WindowSession } from '../shared/ipc-types'
  import type { PrRef } from '../shared/screenprs'

  interface Props {
    connection: RemoteConnection
  }

  let { connection }: Props = $props()

  type Tab = { id: 'sessions' | 'prs'; label: string; icon: string }
  const TABS: Tab[] = [
    { id: 'sessions', label: 'Sessions', icon: '◆' },
    { id: 'prs', label: 'PRs', icon: '⑂' },
  ]

  let tab = $state<Tab['id']>('sessions')
  /** Non-null means a detail screen is on top of `tab`. */
  let openSession = $state<WindowSession | null>(null)
  /** This screen was reached by tapping a notification, not by tapping a row. */
  let arrivedFromNotification = $state(false)
  /** The PR whose detail is open. The `PrRef` is enough to render the header
   *  even if a re-screen empties the board underneath it. */
  let openPr = $state<PrRef | null>(null)
  let state = $state<ConnectionState>('connecting')
  /**
   * The session a notification asked for, held until the list arrives.
   *
   * A tap can land before the socket has answered `session:list` — a cold
   * launch from a lock screen always does — and the deep link has to survive
   * that gap or it silently drops you on the list you were trying to skip.
   *
   * It is resolved ONCE and then cleared whatever the outcome. Keeping it
   * pending until a match appeared was a trap: `session:list-changed` fires
   * every time any session changes status, so a link that never matched would
   * sit armed and then yank the user out of whatever they had opened in the
   * meantime, minutes later.
   */
  let pendingSession = $state<{ terminalId: string; windowId: number | null } | null>(
    initialPending(),
  )
  /**
   * Why a notification's session could not be opened. Shown instead of leaving
   * the user on a list wondering what the buzz was about.
   */
  let deepLinkProblem = $state<string | null>(null)
  /** The new-session sheet is up. Its brief lives and dies with it. */
  let composingNew = $state(false)
  /**
   * A session this phone just started, held until the user acknowledges it.
   *
   * Without this, `+` → Start → the sheet closing is indistinguishable from
   * nothing having happened: the list is main's and arrives on its own clock,
   * and a session that is still booting looks like every other row. Opening it
   * goes through `pendingSession` — the same resolution a notification tap
   * uses, including its answer for a session this phone cannot see.
   */
  let startedNote = $state<SessionCreateResult | null>(null)

  function initialPending(): { terminalId: string; windowId: number | null } | null {
    const terminalId = sessionFromUrl(window.location.href)
    return terminalId ? { terminalId, windowId: null } : null
  }

  /**
   * Drop the `#session=` fragment once it has been acted on.
   *
   * It is an instruction, not an address: left in place, a pull-to-refresh or
   * an iOS PWA relaunch replays it and drags the user back to a session they
   * deliberately left.
   */
  function clearFragment(): void {
    if (!window.location.hash.includes('session=')) return
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }

  $effect(() => connection.onStateChange((next) => { state = next }))

  /**
   * A tap in an already-open tab. The service worker messages rather than
   * navigates, so this is the only path by which a notification can move the
   * app — and all it does is move it. Never the microphone, never a send.
   */
  $effect(() =>
    onOpenSession(({ terminalId, windowId }) => {
      deepLinkProblem = null
      pendingSession = { terminalId, windowId }
      openSession = null
    }),
  )

  // A session that closed while it was open on this phone leaves a detail
  // screen addressing a terminal that no longer exists. Fall back to the list
  // rather than to a dead terminal.
  // Registered once: the effect body reads nothing reactive, so re-subscribing
  // on every list update — which this handler itself causes — cannot happen.
  $effect(() =>
    window.api.on('session:list-changed', (sessions) => {
      resolvePending(sessions)
      const open = openSession
      if (!open) return
      openSession = sessions.find((s) => s.terminalId === open.terminalId) ?? null
    }),
  )

  // The list is fetched by `SessionsScreen` too; asking again here is what
  // makes a cold launch from a notification land on the session rather than on
  // the list, without coupling the two screens. This ONE answer decides the
  // deep link — there is no waiting for a later list to change its mind.
  $effect(() => {
    if (!pendingSession) return
    void window.api
      .invoke('session:list')
      .then(resolvePending)
      .catch(() => {
        pendingSession = null
        clearFragment()
        deepLinkProblem = 'Could not reach the Mac to open that session.'
      })
  })

  /**
   * Open what the notification named, or say why not.
   *
   * The miss that matters: a phone's socket joins ONE window's hub and
   * `session:list` answers for that window alone, while the notification
   * trigger fires for every window's sessions. So a perfectly valid tap can
   * name a session this phone cannot see. Silence there is the worst outcome —
   * the user stopped running for it.
   */
  function resolvePending(sessions: WindowSession[]): void {
    const pending = pendingSession
    if (!pending) return
    pendingSession = null
    clearFragment()
    const match = sessions.find((s) => s.terminalId === pending.terminalId)
    if (match) {
      arrivedFromNotification = true
      deepLinkProblem = null
      // A tap has to land on the session whatever was on screen, including the
      // PR board — the phone was buzzed about a blocked agent, not about a PR.
      tab = 'sessions'
      openPr = null
      openSession = match
      return
    }
    const elsewhere =
      pending.windowId !== null && pending.windowId !== connection.identity()?.windowId
    deepLinkProblem = elsewhere
      ? 'That session is on a different SimpleEdit window, which this phone is not connected to. Reconnect from that window to reach it.'
      : 'That session is no longer running.'
  }

  const tabLabel = $derived(TABS.find((t) => t.id === tab)?.label ?? '')
  const detail = $derived(tab === 'sessions' ? openSession !== null : openPr !== null)
  const title = $derived(
    tab === 'sessions'
      ? (openSession?.label ?? tabLabel)
      : openPr
        ? `${openPr.repo}#${openPr.number}`
        : tabLabel,
  )

  /**
   * Out of whichever detail is open.
   *
   * `arrivedFromNotification` goes with the session it described: left set, the
   * next session opened by a tap on a row would autofocus the composer as
   * though a notification had sent the user there.
   */
  function back(): void {
    openSession = null
    arrivedFromNotification = false
    openPr = null
  }
  const dot = $derived(
    state === 'open' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-amber-400' : 'bg-red-500',
  )
</script>

<div class="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
  <header
    class="flex flex-none items-center gap-2 border-b border-zinc-800 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2"
  >
    {#if detail}
      <button
        type="button"
        onclick={back}
        data-testid="back"
        class="-ml-1 flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-zinc-400 active:bg-zinc-800"
      >‹ <span>{tabLabel}</span></button>
    {/if}
    <h1 class="min-w-0 flex-1 truncate text-[15px] font-semibold" data-testid="screen-title">{title}</h1>
    <!-- The one trailing action a top-level screen is allowed. -->
    {#if !detail && tab === 'sessions'}
      <button
        type="button"
        onclick={() => { composingNew = true }}
        aria-label="New session"
        data-testid="new-session"
        class="flex min-h-9 min-w-9 flex-none items-center justify-center rounded-md text-lg
               text-zinc-300 active:bg-zinc-800"
      >+</button>
    {/if}
    <span
      class="h-2 w-2 flex-none rounded-full {dot}"
      title="Connection: {state}"
      data-testid="connection-dot"
      data-state={state}
    ></span>
  </header>

  <main class="flex min-h-0 flex-1 flex-col">
    {#if tab === 'sessions'}
      {#if openSession}
        <SessionScreen session={openSession} {connection} focusComposer={arrivedFromNotification} />
      {:else}
        {#if startedNote}
          {@const note = startedNote}
          <div class="px-3 pt-3" data-testid="started-note">
            <div
              class="flex items-center gap-2 rounded-md border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300"
            >
              <span class="min-w-0 flex-1 truncate">Started “{note.label}”</span>
              <button
                type="button"
                data-testid="open-started"
                onclick={() => {
                  pendingSession = { terminalId: note.terminalId, windowId: connection.identity()?.windowId ?? null }
                  startedNote = null
                }}
                class="flex-none px-1 font-semibold underline"
              >Open</button>
              <button
                type="button"
                onclick={() => { startedNote = null }}
                aria-label="Dismiss"
                class="flex-none px-1 text-emerald-400/70"
              >✕</button>
            </div>
          </div>
        {/if}
        {#if deepLinkProblem}
          <div class="px-3 pt-3" data-testid="deep-link-problem">
            <div
              class="flex items-start gap-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-300"
            >
              <span class="min-w-0 flex-1">{deepLinkProblem}</span>
              <button
                type="button"
                onclick={() => { deepLinkProblem = null }}
                aria-label="Dismiss"
                class="flex-none px-1 text-amber-400/70"
              >✕</button>
            </div>
          </div>
        {/if}
        <SessionsScreen
          connected={state === 'open'}
          onopen={(session) => { openSession = session; arrivedFromNotification = false }}
        />
      {/if}
    {:else if openPr}
      <PrDetail pr={openPr} connected={state === 'open'} />
    {:else}
      <PrBoard onopen={(pr) => { openPr = pr }} />
    {/if}
  </main>

  {#if composingNew}
    <NewSessionSheet
      connection={state}
      oncreated={(created) => { composingNew = false; startedNote = created; deepLinkProblem = null }}
      onclose={() => { composingNew = false }}
    />
  {/if}

  <!-- Detail screens have no tab bar; the back button is the way out. -->
  {#if !detail}
    <nav
      class="flex flex-none border-t border-zinc-800 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
      data-testid="tab-bar"
    >
      {#each TABS as entry (entry.id)}
        <button
          type="button"
          onclick={() => { tab = entry.id }}
          aria-current={tab === entry.id ? 'page' : undefined}
          class="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[10px]
            {tab === entry.id ? 'text-zinc-100' : 'text-zinc-500'}"
        >
          <span class="text-sm leading-none">{entry.icon}</span>
          {entry.label}
        </button>
      {/each}
    </nav>
  {/if}
</div>
