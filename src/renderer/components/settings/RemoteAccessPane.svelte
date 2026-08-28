<script lang="ts">
  import { onMount } from 'svelte'
  import Toggle from './Toggle.svelte'
  import type { RemoteAccessConfig, RemoteAccessStatus, RemoteInterface, SttStatus } from '../../../shared/ipc-types'

  let config = $state<RemoteAccessConfig | null>(null)
  let status = $state<RemoteAccessStatus | null>(null)
  let interfaces = $state<RemoteInterface[]>([])
  let busy = $state(false)
  let copied = $state(false)
  let hostError = $state<string | null>(null)
  let stt = $state<SttStatus | null>(null)
  let sttError = $state<string | null>(null)

  const enabled = $derived(config?.enabled ?? false)
  const tailscale = $derived(interfaces.find((i) => i.isTailscale) ?? null)
  const boundToLoopback = $derived(status?.host === '127.0.0.1' || status?.host === 'localhost')

  onMount(() => {
    void refresh()
    return window.api.on('remote:status-changed', (next) => { status = next })
  })

  async function refresh(): Promise<void> {
    ;[config, status, interfaces, stt] = await Promise.all([
      window.api.invoke('remote:config'),
      window.api.invoke('remote:status'),
      window.api.invoke('remote:interfaces'),
      window.api.invoke('stt:status'),
    ])
  }

  async function pickModel(): Promise<void> {
    sttError = null
    try {
      const next = await window.api.invoke('stt:pick-model')
      if (next) stt = next
    } catch (error) {
      sttError = error instanceof Error ? error.message : String(error)
    }
  }

  async function clearModel(): Promise<void> {
    sttError = null
    try {
      stt = await window.api.invoke('stt:set-model-path', '')
    } catch (error) {
      sttError = error instanceof Error ? error.message : String(error)
    }
  }

  async function setEnabled(next: boolean): Promise<void> {
    busy = true
    try {
      status = await window.api.invoke('remote:set-enabled', next)
      config = await window.api.invoke('remote:config')
    } finally {
      busy = false
    }
  }

  async function setHost(host: string): Promise<void> {
    busy = true
    hostError = null
    try {
      status = await window.api.invoke('remote:set-host', host)
      config = await window.api.invoke('remote:config')
    } catch (error) {
      // Main validates the address independently of what this list offered.
      hostError = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
    }
  }

  async function copyUrl(): Promise<void> {
    if (!status?.url) return
    await navigator.clipboard.writeText(status.url)
    copied = true
    setTimeout(() => { copied = false }, 1500)
  }
</script>

<div class="max-w-2xl space-y-6">
  <header>
    <h1 class="text-lg font-semibold text-zinc-100">Remote access</h1>
    <p class="mt-1 text-[13px] leading-relaxed text-zinc-400">
      Serves SimpleEdit to a browser on this machine or over your Tailscale network. Anyone with
      the link below can run terminals, edit files and remove worktrees — treat it as a password.
    </p>
  </header>

  <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0">
        <p class="text-[13.5px] font-medium text-zinc-100">Enable remote access</p>
        <p class="mt-0.5 text-xs text-zinc-500">
          Off by default, and off again whenever SimpleEdit is not running.
        </p>
      </div>
      <Toggle
        checked={enabled}
        disabled={busy || config === null}
        label="Enable remote access"
        onchange={(v) => void setEnabled(v)}
      />
    </div>

    {#if status?.error}
      <p class="mt-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
        Could not start: {status.error}
      </p>
    {/if}
  </section>

  {#if enabled && status?.running}
    <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">Connection</h2>
      <div class="mt-2 flex items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded-md bg-zinc-950 px-2.5 py-2 text-xs text-zinc-200">{status.url}</code>
        <button
          type="button"
          onclick={() => void copyUrl()}
          class="flex-none rounded-md bg-zinc-800 px-2.5 py-2 text-xs text-zinc-200 hover:bg-zinc-700"
        >{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p class="mt-2 text-xs leading-relaxed text-zinc-500">
        The random path segment is the access token. It is regenerated every time the server
        starts, so an old link stops working — share the current one, and never through a
        service that stores it.
      </p>
      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt class="text-zinc-500">Bound to</dt>
        <dd class="text-zinc-300">{status.host}:{status.port}</dd>
        <dt class="text-zinc-500">Connected clients</dt>
        <dd class="text-zinc-300">{status.clients}</dd>
      </dl>
    </section>

    <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">Sleep</h2>
      <p class="mt-2 text-[13px] text-zinc-300">
        {#if status.powerSaveBlocked}
          Holding a power assertion — this Mac will not sleep while remote access is on.
        {:else}
          <span class="text-amber-400">No power assertion is held.</span>
          This Mac can sleep, and your agents stop with it.
        {/if}
      </p>
      <p class="mt-1.5 text-xs leading-relaxed text-zinc-500">
        Sleeping stops the agents, not just the notifications — and it does so silently, which is
        why this is stated rather than assumed. The display is still allowed to sleep.
      </p>
    </section>
  {/if}

  <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
    <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">Network interface</h2>
    <p class="mt-2 text-xs leading-relaxed text-zinc-500">
      Only two kinds of address are offered, and the list is a filter rather than a warning:
      loopback reaches this machine alone, and a Tailscale address reaches your own devices and
      nothing else. Your LAN is deliberately absent — remote access must never answer on a network
      you do not control, and there is no “all interfaces” option at all.
    </p>
    {#if hostError}
      <p class="mt-2 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">{hostError}</p>
    {/if}
    <div class="mt-3 space-y-1.5">
      {#each interfaces as iface (iface.name + iface.address)}
        {@const selected = config?.host === iface.address}
        <button
          type="button"
          disabled={busy}
          onclick={() => void setHost(iface.address)}
          class="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-[13px] transition-colors
            {selected
              ? 'border-blue-800 bg-blue-950/50 text-blue-300'
              : 'border-zinc-800 text-zinc-300 hover:bg-zinc-800'}"
        >
          <code class="flex-none">{iface.address}</code>
          <span class="min-w-0 flex-1 truncate text-xs text-zinc-500">{iface.name}</span>
          {#if iface.isTailscale}
            <span class="flex-none rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">Tailscale</span>
          {:else}
            <span class="flex-none rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">This Mac only</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if !tailscale}
      <p class="mt-3 text-xs leading-relaxed text-zinc-500">
        No Tailscale interface found. Without one, a phone can only reach this over plain HTTP on
        the LAN — which is not a secure context, so the microphone will never open there.
      </p>
    {:else if boundToLoopback}
      <p class="mt-3 text-xs leading-relaxed text-zinc-500">
        Bound to loopback, so only a browser on this Mac can connect. Pick the Tailscale address
        to reach a phone.
      </p>
    {/if}
  </section>

  <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
    <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">Dictation</h2>
    <p class="mt-2 text-xs leading-relaxed text-zinc-500">
      The remote composer can take a spoken reply. Audio is captured in the browser, transcribed
      on this Mac by whisper.cpp, and never leaves your network — and never touches disk beyond a
      temporary file that is deleted as soon as the transcription finishes.
      Typing always works, whether or not any of this is set up.
    </p>

    {#if stt}
      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt class="text-zinc-500">whisper.cpp</dt>
        <dd class={stt.installed ? 'text-emerald-400' : 'text-amber-400'}>
          {stt.installed ? stt.binary : 'not installed'}
        </dd>
        <dt class="text-zinc-500">Model</dt>
        <dd class="min-w-0 break-all {stt.modelReady ? 'text-zinc-300' : 'text-amber-400'}">
          {stt.modelPath || 'none selected'}
        </dd>
      </dl>

      {#if stt.hint}
        <p class="mt-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-300">
          {stt.hint}
        </p>
      {/if}
      {#if sttError}
        <p class="mt-2 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">{sttError}</p>
      {/if}

      <div class="mt-3 flex items-center gap-2">
        <button
          type="button"
          onclick={() => void pickModel()}
          class="rounded-md bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
        >{stt.modelPath ? 'Change model…' : 'Choose model…'}</button>
        {#if stt.modelPath}
          <button
            type="button"
            onclick={() => void clearModel()}
            class="rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >Clear</button>
        {/if}
        <button
          type="button"
          onclick={() => void refresh()}
          class="ml-auto rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >Re-check</button>
      </div>
    {/if}
  </section>
</div>
