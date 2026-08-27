<script lang="ts">
  /**
   * Phase 3's whole web surface: proof that the transport works.
   *
   * No mobile UI lives here yet — this exists so the round-trip can be
   * verified from an ordinary browser tab before a single screen is designed:
   * an `invoke` that returns a real result from main, and a pushed event that
   * arrives unasked over the same socket.
   */
  import type { ConnectionState, RemoteConnection, RemoteIdentity } from './api-shim'
  import type { WorktreeInfo } from '../shared/ipc-types'

  interface Props {
    connection: RemoteConnection
  }

  let { connection }: Props = $props()

  // Starts pessimistic; the subscription below corrects it on the first tick.
  let state = $state<ConnectionState>('connecting')
  let identity = $state<RemoteIdentity | null>(null)
  let repo = $state<string | null>(null)
  let worktrees = $state<WorktreeInfo[]>([])
  let invokeError = $state<string | null>(null)
  let events = $state<{ at: string; channel: string; body: string }[]>([])

  $effect(() => connection.onStateChange((next) => { state = next }))
  $effect(() => { void connection.identity.then((id) => { identity = id }) })

  // Pushed events, unasked-for: these arrive because this socket registered as
  // a transport on a window's hub, so main's ordinary fan-out reaches it.
  const WATCHED = ['agent:status', 'pty:data', 'pty:owner-changed', 'worktree:list-changed'] as const

  $effect(() => {
    const offs = WATCHED.map((channel) =>
      window.api.on(channel, (data) => {
        const body = JSON.stringify(data)
        events = [
          { at: new Date().toLocaleTimeString(), channel, body: body.length > 160 ? `${body.slice(0, 160)}…` : body },
          ...events,
        ].slice(0, 40)
      }),
    )
    return () => { for (const off of offs) off() }
  })

  async function probe(): Promise<void> {
    invokeError = null
    try {
      repo = await window.api.invoke('app:get-repo')
      worktrees = await window.api.invoke('worktree:list')
    } catch (error) {
      invokeError = error instanceof Error ? error.message : String(error)
    }
  }

  void probe()

  const dot = $derived(
    state === 'open' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-amber-400' : 'bg-red-500',
  )
</script>

<main class="mx-auto flex h-full max-w-2xl flex-col gap-5 overflow-y-auto p-6 text-sm">
  <header class="flex items-center gap-2.5">
    <span class="h-2.5 w-2.5 flex-none rounded-full {dot}"></span>
    <h1 class="text-base font-semibold">SimpleEdit remote</h1>
    <span class="text-zinc-500">{state}</span>
  </header>

  <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
    <h2 class="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-500">Identity</h2>
    {#if identity}
      <p class="text-zinc-300">
        Attached to window <code class="text-zinc-100">{identity.windowId}</code> as
        <code class="text-zinc-100">{identity.clientKey}</code>
      </p>
      <p class="mt-1 text-xs text-zinc-500">
        The window id is shared with its desktop renderer; the client key is this socket's alone.
      </p>
    {:else}
      <p class="text-zinc-500">Waiting for the server's hello…</p>
    {/if}
  </section>

  <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">Invoke</h2>
      <button
        type="button"
        onclick={probe}
        class="rounded-md bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
      >Run again</button>
    </div>
    {#if invokeError}
      <p class="text-red-400">{invokeError}</p>
    {:else}
      <p class="text-zinc-300"><code>app:get-repo</code> → <code class="text-zinc-100">{repo ?? '(none)'}</code></p>
      <p class="mt-1 text-zinc-300"><code>worktree:list</code> → {worktrees.length} worktree{worktrees.length === 1 ? '' : 's'}</p>
      <ul class="mt-2 space-y-0.5 text-xs text-zinc-400">
        {#each worktrees as worktree (worktree.path)}
          <li><code>{worktree.branch}</code> — {worktree.path}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
    <h2 class="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-500">
      Pushed events ({events.length})
    </h2>
    {#if events.length === 0}
      <p class="text-zinc-500">
        Nothing yet. Type in a terminal, or add/remove a worktree, in the window this socket joined.
      </p>
    {:else}
      <ul class="space-y-1 font-mono text-xs">
        {#each events as event, i (`${event.at}-${i}`)}
          <li class="flex gap-2">
            <span class="text-zinc-600">{event.at}</span>
            <span class="text-emerald-400">{event.channel}</span>
            <span class="min-w-0 flex-1 truncate text-zinc-400">{event.body}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</main>
