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
   * Cleared once it resolves, so a later list update cannot yank the user
   * back to a session they navigated away from.
   */
  let pendingSession = $state<string | null>(sessionFromUrl(window.location.href))

  $effect(() => connection.onStateChange((next) => { state = next }))

  /**
   * A tap in an already-open tab. The service worker messages rather than
   * navigates, so this is the only path by which a notification can move the
   * app — and all it does is move it. Never the microphone, never a send.
   */
  $effect(() =>
    onOpenSession(({ terminalId }) => {
      pendingSession = terminalId
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
  // the list, without coupling the two screens.
  $effect(() => {
    if (!pendingSession) return
    void window.api.invoke('session:list').then(resolvePending).catch(() => { pendingSession = null })
  })

  function resolvePending(sessions: WindowSession[]): void {
    if (!pendingSession) return
    const match = sessions.find((s) => s.terminalId === pendingSession)
    if (!match) return
    pendingSession = null
    arrivedFromNotification = true
    openSession = match
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

  <main class="min-h-0 flex-1">
    {#if openSession}
      <SessionScreen session={openSession} {connection} focusComposer={arrivedFromNotification} />
    {:else if tab === 'sessions'}
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
