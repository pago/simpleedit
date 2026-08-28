<script lang="ts">
  /**
   * The mobile shell.
   *
   * Two chrome rules, held here so no screen can drift from them:
   *
   *  - A **top-level** screen has a title, at most one trailing action, and the
   *    tab bar. Never a segmented control.
   *  - A **detail** screen has a back button and a title, and no tab bar.
   *
   * There is one tab today. It is a tab bar rather than a bare title because
   * the second one (PRs) is a later phase, and a bar that appears when a second
   * screen lands moves everything under the user's thumb on the day it ships.
   */
  import SessionsScreen from './SessionsScreen.svelte'
  import SessionScreen from './SessionScreen.svelte'
  import { onOpenSession } from './lib/push-client'
  import { sessionFromUrl } from './lib/push-payload'
  import type { ConnectionState, RemoteConnection } from './api-shim'
  import type { WindowSession } from '../shared/ipc-types'

  interface Props {
    connection: RemoteConnection
  }

  let { connection }: Props = $props()

  type Tab = { id: 'sessions'; label: string; icon: string }
  const TABS: Tab[] = [{ id: 'sessions', label: 'Sessions', icon: '◆' }]

  let tab = $state<Tab['id']>('sessions')
  /** Non-null means a detail screen is on top of `tab`. */
  let openSession = $state<WindowSession | null>(null)
  /** This screen was reached by tapping a notification, not by tapping a row. */
  let arrivedFromNotification = $state(false)
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
      openSession = match
      return
    }
    const elsewhere =
      pending.windowId !== null && pending.windowId !== connection.identity()?.windowId
    deepLinkProblem = elsewhere
      ? 'That session is on a different SimpleEdit window, which this phone is not connected to. Reconnect from that window to reach it.'
      : 'That session is no longer running.'
  }

  const title = $derived(openSession ? openSession.label : (TABS.find((t) => t.id === tab)?.label ?? ''))
  const dot = $derived(
    state === 'open' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-amber-400' : 'bg-red-500',
  )
</script>

<div class="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
  <header
    class="flex flex-none items-center gap-2 border-b border-zinc-800 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2"
  >
    {#if openSession}
      <button
        type="button"
        onclick={() => { openSession = null; arrivedFromNotification = false }}
        data-testid="back"
        class="-ml-1 flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-zinc-400 active:bg-zinc-800"
      >‹ <span>Sessions</span></button>
    {/if}
    <h1 class="min-w-0 flex-1 truncate text-[15px] font-semibold" data-testid="screen-title">{title}</h1>
    <span
      class="h-2 w-2 flex-none rounded-full {dot}"
      title="Connection: {state}"
      data-testid="connection-dot"
      data-state={state}
    ></span>
  </header>

  <main class="flex min-h-0 flex-1 flex-col">
    {#if openSession}
      <SessionScreen session={openSession} {connection} focusComposer={arrivedFromNotification} />
    {:else if tab === 'sessions'}
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
      <SessionsScreen onopen={(session) => { openSession = session; arrivedFromNotification = false }} />
    {/if}
  </main>

  <!-- Detail screens have no tab bar; the back button is the way out. -->
  {#if !openSession}
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
