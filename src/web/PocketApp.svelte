<script lang="ts">
  /**
   * The mobile shell.
   *
   * Two chrome rules, held here so no screen can drift from them:
   *
   *  - A **top-level** screen has a title, at most one trailing action, and the
   *    tab bar. Never a segmented control.
   *  - A **detail** screen has a back button and a title. It may have a
   *    segmented control, but only when it genuinely has two panes, and
   *    labelled for that screen — Session's is Terminal / Changes, PR's is
   *    Conversation / Files. The control belongs to the screen; this header
   *    never carries one.
   *
   * Where the phone is lives in `nav` (`lib/nav.ts`): a stack per tab, with
   * sheets and modals as layers on it, bound to the browser's history so the
   * system Back gesture does what the on-screen one does. There is ONE back
   * behaviour: whatever is on top of the tab you are on goes.
   *
   * Nothing that navigation can come back to is unmounted by leaving it. Both
   * tabs stay mounted, and every screen on a stack stays mounted under the one
   * on top — a session under a notification's session keeps its composer draft,
   * a PR list keeps its scroll behind the PR you opened. Only popping an entry
   * unmounts it.
   *
   * The tab bar shows on list and detail screens alike, so another tab is one
   * tap away from anywhere. It hides only while a sheet or modal is up: a sheet
   * is modal, and switching away from one would strand it. It deliberately
   * does NOT hide while a field has focus — the tap on Send is what blurs the
   * field, so the bar reappearing would move Send out from under the finger
   * mid-tap.
   */
  import { untrack } from 'svelte'
  import SessionsScreen from './SessionsScreen.svelte'
  import SessionScreen from './SessionScreen.svelte'
  import NewSessionSheet from './NewSessionSheet.svelte'
  import PrBoard from './PrBoard.svelte'
  import PrDetail from './PrDetail.svelte'
  import { onOpenSession } from './lib/push-client'
  import { sessionFromUrl } from './lib/push-payload'
  import { nav } from './lib/nav.svelte'
  import { isOverlay, type NavEntry, type TabId } from './lib/nav'
  import type { ConnectionState, RemoteConnection } from './api-shim'
  import type { SessionCreateResult, WindowSession } from '../shared/ipc-types'

  interface Props {
    connection: RemoteConnection
  }

  let { connection }: Props = $props()

  type Tab = { id: TabId; label: string; icon: string }
  const TABS: Tab[] = [
    { id: 'sessions', label: 'Sessions', icon: '◆' },
    { id: 'prs', label: 'PRs', icon: '⑂' },
  ]

  type SessionEntry = Extract<NavEntry, { kind: 'session' }>
  type PrEntry = Extract<NavEntry, { kind: 'pr' }>

  let connState = $state<ConnectionState>('connecting')
  /**
   * The latest thing known about every session a screen may be showing. The
   * stack holds only terminal ids, so a status change or a rename reaches an
   * open screen without anything on the stack being rewritten.
   */
  let known = $state<Record<string, WindowSession>>({})
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
  let newSheet = $state<NewSessionSheet | undefined>()
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
   * deliberately left. The entry's state is kept — it carries the nav depth.
   */
  function clearFragment(): void {
    if (!window.location.hash.includes('session=')) return
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`)
  }

  // First, so history is bound before anything can be pushed. Untracked:
  // attaching reads the stack, and re-binding on every change would re-walk
  // history on top of a walk already in flight.
  $effect(() => untrack(() => nav.attach(window)))

  $effect(() => connection.onStateChange((next) => { connState = next }))

  function remember(session: WindowSession): void {
    known = { ...known, [session.terminalId]: session }
  }

  /**
   * A tap in an already-open tab. The service worker messages rather than
   * navigates, so this is the only path by which a notification can move the
   * app — and all it does is move it. Never the microphone, never a send.
   *
   * Nothing is closed here. The session is pushed on top once the list has
   * confirmed it, so whatever was open is still underneath for Back.
   */
  $effect(() =>
    onOpenSession(({ terminalId, windowId }) => {
      deepLinkProblem = null
      pendingSession = { terminalId, windowId }
    }),
  )

  // A session that closed while it was on a stack leaves a screen addressing a
  // terminal that no longer exists. It comes off the stack, wherever it was,
  // rather than leaving a dead terminal to come Back to.
  // Registered once: the effect body reads nothing reactive, so re-subscribing
  // on every list update — which this handler itself causes — cannot happen.
  $effect(() =>
    window.api.on('session:list-changed', (sessions) => {
      resolvePending(sessions)
      known = Object.fromEntries(sessions.map((s) => [s.terminalId, s]))
      nav.removeWhere(
        (entry) =>
          (entry.kind === 'session' || entry.kind === 'changes-diff') && !(entry.terminalId in known),
      )
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
      deepLinkProblem = null
      remember(match)
      // A tap has to land on the session whatever was on screen, including the
      // PR board — the phone was buzzed about a blocked agent, not about a PR.
      nav.openFromNotification(match.terminalId)
      return
    }
    const elsewhere =
      pending.windowId !== null && pending.windowId !== connection.identity()?.windowId
    deepLinkProblem = elsewhere
      ? 'That session is on a different SimpleEdit window, which this phone is not connected to. Reconnect from that window to reach it.'
      : 'That session is no longer running.'
  }

  function openSession(session: WindowSession): void {
    remember(session)
    nav.push({ kind: 'session', terminalId: session.terminalId, fromNotification: false })
  }

  function openNewSession(): void {
    nav.push({ kind: 'new-session' }, () => newSheet?.holdForDraft() ?? false)
  }

  const tab = $derived(nav.tab)
  const top = $derived(nav.top())
  const screen = $derived(nav.screen())
  const sessionEntries = $derived(
    nav.stack('sessions').filter((e): e is SessionEntry => e.kind === 'session'),
  )
  const prEntries = $derived(nav.stack('prs').filter((e): e is PrEntry => e.kind === 'pr'))
  const newSessionEntry = $derived(nav.stack('sessions').find((e) => e.kind === 'new-session') ?? null)
  const sessionScreen = $derived(nav.screen('sessions'))
  const prScreen = $derived(nav.screen('prs'))

  const tabLabel = $derived(TABS.find((t) => t.id === tab)?.label ?? '')

  function titleOf(entry: NavEntry | null): string {
    if (entry?.kind === 'session') return known[entry.terminalId]?.label ?? 'Session'
    if (entry?.kind === 'pr') return `${entry.pr.repo}#${entry.pr.number}`
    return tabLabel
  }

  const title = $derived(titleOf(screen))
  /** Where Back goes, named: the diff's log, or the screen under this one. */
  const backLabel = $derived.by(() => {
    if (top?.kind === 'changes-diff') return 'Changes'
    const stack = nav.stack()
    const at = screen ? stack.indexOf(screen) : -1
    const below = stack.slice(0, Math.max(0, at)).findLast((e) => e.kind === 'session' || e.kind === 'pr')
    return titleOf(below ?? null)
  })
  const showTabBar = $derived(!isOverlay(top))

  const dot = $derived(
    connState === 'open' ? 'bg-emerald-400' : connState === 'connecting' ? 'bg-amber-400' : 'bg-red-500',
  )
</script>

<div class="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
  <header
    class="flex flex-none items-center gap-2 border-b border-zinc-800 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2"
  >
    {#if screen || top?.kind === 'changes-diff'}
      <button
        type="button"
        onclick={() => nav.back()}
        data-testid="back"
        class="-ml-1 flex min-h-9 max-w-[40%] items-center gap-1 rounded-md px-2 text-sm text-zinc-400 active:bg-zinc-800"
      >‹ <span class="truncate">{backLabel}</span></button>
    {/if}
    <h1 class="min-w-0 flex-1 truncate text-[15px] font-semibold" data-testid="screen-title">{title}</h1>
    <!-- The one trailing action a top-level screen is allowed. -->
    {#if !screen && tab === 'sessions'}
      <button
        type="button"
        onclick={openNewSession}
        aria-label="New session"
        data-testid="new-session"
        class="flex min-h-9 min-w-9 flex-none items-center justify-center rounded-md text-lg
               text-zinc-300 active:bg-zinc-800"
      >+</button>
    {/if}
    <span
      class="h-2 w-2 flex-none rounded-full {dot}"
      title="Connection: {connState}"
      data-testid="connection-dot"
      data-state={connState}
    ></span>
  </header>

  <main class="flex min-h-0 flex-1 flex-col">
    <!-- Both tabs stay mounted; see the note at the top of this file. -->
    <div class={tab === 'sessions' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} data-testid="tab-sessions">
      <div class={sessionScreen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
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
        <SessionsScreen connected={connState === 'open'} onopen={openSession} />
      </div>

      {#each sessionEntries as entry (entry.id)}
        {@const session = known[entry.terminalId]}
        {@const showing = tab === 'sessions' && sessionScreen?.id === entry.id}
        {#if session}
          <div class={sessionScreen?.id === entry.id ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <SessionScreen
              {session}
              {connection}
              focusComposer={entry.fromNotification}
              visible={showing && top?.kind !== 'new-session'}
            />
          </div>
        {/if}
      {/each}

      {#if newSessionEntry}
        {@const sheetId = newSessionEntry.id}
        <!-- Under a notification's session it stays mounted, brief and all. -->
        <div class={top?.id === sheetId ? 'contents' : 'hidden'}>
          <NewSessionSheet
            bind:this={newSheet}
            connection={connState}
            oncreated={(created) => { nav.close(sheetId); startedNote = created; deepLinkProblem = null }}
            onclose={() => nav.close(sheetId)}
          />
        </div>
      {/if}
    </div>

    <div class={tab === 'prs' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} data-testid="tab-prs">
      <div class={prScreen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        <PrBoard onopen={(pr) => nav.push({ kind: 'pr', pr })} />
      </div>
      {#each prEntries as entry (entry.id)}
        <div class={prScreen?.id === entry.id ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <PrDetail pr={entry.pr} connected={connState === 'open'} />
        </div>
      {/each}
    </div>
  </main>

  {#if showTabBar}
    <nav
      class="flex flex-none border-t border-zinc-800 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
      data-testid="tab-bar"
    >
      {#each TABS as entry (entry.id)}
        <button
          type="button"
          onclick={() => nav.selectTab(entry.id)}
          aria-current={tab === entry.id ? 'page' : undefined}
          data-testid="tab-{entry.id}-button"
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
