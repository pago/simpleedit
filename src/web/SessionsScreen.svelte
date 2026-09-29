<script lang="ts">
  /**
   * The window's sessions, ordered by what is costing you throughput.
   *
   * Blocked first, and a blocked session shows how long it has been blocked —
   * not how long it has been running. A session waiting on a reply is a
   * parallel slot doing nothing, and the length of that wait is the only number
   * on this screen that changes a decision. Everything else is context.
   *
   * The list is main's, per window (`session-registry.ts`), pushed there by the
   * renderer that owns it — so this is the same state the desktop sidebar
   * renders, not a second derivation of it.
   */
  import { onMount } from 'svelte'
  import NotificationsCard from './NotificationsCard.svelte'
  import type { WindowSession } from '../shared/ipc-types'

  interface Props {
    /** Whether the socket is open. The list is a read, and a read needs one. */
    connected: boolean
    onopen: (session: WindowSession) => void
  }

  let { connected, onopen }: Props = $props()

  let sessions = $state<WindowSession[]>([])
  let loaded = $state(false)
  let error = $state<string | null>(null)
  let now = $state(Date.now())

  /**
   * Load whenever a connection exists, not once at mount.
   *
   * During a reconnect backoff there is no socket, and `invoke` refuses rather
   * than queueing — so a mount that lands in that window, or a read that failed
   * because of it, would otherwise sit on its error for good. The terminal
   * resyncs on `open` for the same reason.
   */
  $effect(() => {
    if (connected) void load()
  })

  onMount(() => {
    const off = window.api.on('session:list-changed', (next) => {
      sessions = next
      loaded = true
    })
    // Idle time is the point of this screen, so it ticks.
    const timer = setInterval(() => { now = Date.now() }, 1000)
    return () => {
      off()
      clearInterval(timer)
    }
  })

  /** Guards against a slow earlier load landing on top of a newer one. */
  let loadToken = 0

  async function load(): Promise<void> {
    const mine = ++loadToken
    error = null
    try {
      const next = await window.api.invoke('session:list')
      if (mine !== loadToken) return
      sessions = next
      loaded = true
    } catch (err) {
      if (mine !== loadToken) return
      error = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * Buckets, most expensive first. `waiting` is a slot standing idle for want
   * of a sentence from you; `running` is working; the rest is history.
   */
  const GROUPS = [
    { key: 'blocked', title: 'Blocked on you', statuses: ['waiting'] },
    { key: 'working', title: 'Working', statuses: ['running', 'initializing'] },
    { key: 'idle', title: 'Idle', statuses: ['idle', 'unknown'] },
    { key: 'ended', title: 'Ended', statuses: ['error', 'exited'] },
  ] as const

  const grouped = $derived(
    GROUPS.map((group) => ({
      ...group,
      // Within a bucket, the longest-waiting first: same reasoning, one level
      // down. `statusSince` is main's stamp, so it survives this page loading
      // long after the transition happened.
      members: sessions
        .filter((session) => (group.statuses as readonly string[]).includes(session.status))
        .sort((a, b) => a.statusSince - b.statusSince),
    })).filter((group) => group.members.length > 0),
  )

  function elapsed(since: number): string {
    const total = Math.max(0, Math.floor((now - since) / 1000))
    if (total < 60) return `${total}s`
    const minutes = Math.floor(total / 60)
    if (minutes < 60) return `${minutes}m ${total % 60}s`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }

  function dotClass(status: WindowSession['status']): string {
    switch (status) {
      case 'waiting': return 'bg-amber-400'
      case 'running': return 'bg-emerald-400 animate-pulse'
      case 'initializing': return 'bg-sky-400'
      case 'error':
      case 'exited': return 'bg-red-500'
      default: return 'bg-zinc-600'
    }
  }

  function subtitle(session: WindowSession): string {
    const where = session.worktreePath.split('/').slice(-2).join('/')
    return session.provider ? `${session.provider} · ${where}` : where
  }
</script>

<div class="flex h-full flex-col overflow-y-auto px-3 py-3" data-testid="sessions-screen">
  <NotificationsCard />

  {#if error}
    <div class="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
      {error}
      <button type="button" onclick={() => void load()} class="ml-2 underline">Retry</button>
    </div>
  {:else if !loaded}
    <p class="px-1 py-6 text-sm text-zinc-500">Loading sessions…</p>
  {:else if sessions.length === 0}
    <p class="px-1 py-6 text-sm leading-relaxed text-zinc-500">
      No sessions on the window this connected to. Start one at the desk and it appears here.
    </p>
  {:else}
    {#each grouped as group (group.key)}
      <section class="mb-5">
        <h2 class="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
          {group.title}
        </h2>
        <ul class="space-y-1.5">
          {#each group.members as session (session.terminalId)}
            <li>
              <button
                type="button"
                onclick={() => onopen(session)}
                data-testid="session-row"
                data-session-id={session.terminalId}
                class="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-3
                       text-left active:bg-zinc-800"
              >
                <span class="h-2 w-2 flex-none rounded-full {dotClass(session.status)}"></span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm text-zinc-100">{session.label}</span>
                  <span class="block truncate text-[11px] text-zinc-500">{subtitle(session)}</span>
                </span>
                {#if session.status === 'waiting'}
                  <span
                    class="flex-none rounded bg-amber-950 px-1.5 py-0.5 text-[11px] font-semibold text-amber-400"
                    data-testid="idle-for"
                  >{elapsed(session.statusSince)} idle</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>
