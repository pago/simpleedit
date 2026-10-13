<script lang="ts">
  import { onMount } from 'svelte'
  import Toggle from './Toggle.svelte'
  import QrCode from './QrCode.svelte'
  import { EXPOSURE_LABELS, pairingTarget } from '../../../shared/remote-pairing'
  import type {
    PushStatus,
    RemoteAccessConfig,
    RemoteAccessStatus,
    RemoteExposure,
    RemoteInterface,
    SttStatus,
    TailscaleStatus,
    TunnelConnectionState,
    TunnelStatus,
  } from '../../../shared/ipc-types'

  interface ExposureChoice {
    id: RemoteExposure
    blurb: string
    experimental: boolean
  }

  const EXPOSURE_CHOICES: ExposureChoice[] = [
    { id: 'off', blurb: 'Nothing is published. The bind above is all there is.', experimental: false },
    {
      id: 'tailscale-serve',
      blurb: 'An HTTPS address on your tailnet, reachable from your own devices only. Recommended.',
      experimental: false,
    },
    {
      id: 'opentunnel',
      blurb: 'A public HTTPS address on the internet, through a third-party relay. Works without Tailscale.',
      experimental: true,
    },
  ]

  const CONNECTION_LABELS: Record<TunnelConnectionState, string> = {
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    closing: 'Closing…',
  }

  let config = $state<RemoteAccessConfig | null>(null)
  let status = $state<RemoteAccessStatus | null>(null)
  let interfaces = $state<RemoteInterface[]>([])
  let busy = $state(false)
  let copied = $state(false)
  let hostError = $state<string | null>(null)
  let stt = $state<SttStatus | null>(null)
  let sttError = $state<string | null>(null)
  let ts = $state<TailscaleStatus | null>(null)
  let tunnel = $state<TunnelStatus | null>(null)
  let exposureError = $state<string | null>(null)
  /** OpenTunnel was picked and its one-time warning is on screen. */
  let acknowledging = $state(false)
  let radioGroup = $state<HTMLFieldSetElement | null>(null)
  /** Where the user asked to go from OpenTunnel, held until they confirm the tunnel's deletion. */
  let confirmingLeave = $state<RemoteExposure | null>(null)
  let push = $state<PushStatus | null>(null)
  let pushError = $state<string | null>(null)

  const enabled = $derived(config?.enabled ?? false)
  const tailscale = $derived(interfaces.find((i) => i.isTailscale) ?? null)
  const boundToLoopback = $derived(status?.host === '127.0.0.1' || status?.host === 'localhost')
  const boundToTailscale = $derived(
    interfaces.some((i) => i.isTailscale && i.address === status?.host),
  )

  /**
   * What, if anything, is worth putting in front of a phone's camera. The
   * decision lives in `shared/remote-pairing` so that "never a loopback URL"
   * is a checked property rather than a rule this template remembers.
   */
  const pairing = $derived(
    pairingTarget({
      exposure: config?.exposure ?? 'off',
      running: status?.running ?? false,
      directUrl: status?.url ?? null,
      boundToTailscale,
      tunnelUrl: tunnel?.url ?? null,
    }),
  )

  const exposure = $derived<RemoteExposure>(config?.exposure ?? 'off')
  /**
   * Locked while a request is in flight, except while OpenTunnel provisions:
   * that can take minutes, and switching away is how it is cancelled.
   */
  const choicesLocked = $derived(
    busy || config === null || (tunnel?.busy === true && exposure !== 'opentunnel'),
  )
  /** Providers switched away from that are still deleting, or failed to. */
  const elsewhere = $derived(tunnel?.elsewhere ?? [])
  const keptNow = $derived(tunnel?.kept ?? false)

  // A confirmation asked about a tunnel that has since gone, or a choice that
  // has since changed, must not be answerable any more.
  $effect(() => {
    void exposure
    void keptNow
    confirmingLeave = null
  })
  const exposureLabel = $derived(EXPOSURE_LABELS[exposure])
  /** The public address alone: the key belongs in the pairing code, not on display here. */
  const publicOrigin = $derived(tunnel?.url ? new URL(tunnel.url).origin : null)

  onMount(() => {
    void refresh()
    const offStatus = window.api.on('remote:status-changed', (next) => { status = next })
    const offTunnel = window.api.on('remote:tunnel-changed', (next) => { tunnel = next })
    // A phone registering itself changes this pane while nobody is touching
    // it — that is the whole point of the list.
    const offPush = window.api.on('push:status-changed', (next) => { push = next })
    return () => { offStatus(); offTunnel(); offPush() }
  })

  async function refresh(): Promise<void> {
    ;[config, status, interfaces, stt, ts, tunnel, push] = await Promise.all([
      window.api.invoke('remote:config'),
      window.api.invoke('remote:status'),
      window.api.invoke('remote:interfaces'),
      window.api.invoke('stt:status'),
      window.api.invoke('tailscale:status'),
      window.api.invoke('remote:tunnel-status'),
      window.api.invoke('push:status'),
    ])
  }

  /**
   * A native radio checks itself on the click; when the choice does not go
   * through (the warning, a refusal), put the group back to what main has.
   */
  function showStoredChoice(): void {
    for (const input of radioGroup?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []) {
      input.checked = input.value === exposure
    }
  }

  async function chooseExposure(next: RemoteExposure, confirmed = false): Promise<void> {
    // `aria-disabled`, not `disabled`, while locked: disabling the radio that
    // has focus drops focus to the body, and the next arrow key goes nowhere.
    if (choicesLocked) {
      showStoredChoice()
      return
    }
    exposureError = null
    if (next === 'opentunnel' && !config?.openTunnelAcknowledged) {
      acknowledging = true
      showStoredChoice()
      return
    }
    // One click or arrow key would otherwise delete a public address a phone
    // relies on. A first provisioning that never published one is let go.
    if (!confirmed && exposure === 'opentunnel' && next !== 'opentunnel' && tunnel?.kept) {
      confirmingLeave = next
      showStoredChoice()
      return
    }
    confirmingLeave = null
    acknowledging = false
    busy = true
    try {
      // The answer is only the acceptance, and can land after the outcome's
      // `remote:tunnel-changed`; adopting it would leave the choice stuck busy.
      await window.api.invoke('remote:set-exposure', next)
      config = await window.api.invoke('remote:config')
    } catch (error) {
      // Main refuses a provider when the bind is not loopback, and says why.
      exposureError = error instanceof Error ? error.message : String(error)
      showStoredChoice()
    } finally {
      busy = false
    }
  }

  async function forgetTunnel(provider: Exclude<RemoteExposure, 'off'>): Promise<void> {
    exposureError = null
    try {
      // The outcome arrives as `remote:tunnel-changed`, like every other.
      await window.api.invoke('remote:forget-tunnel', provider)
    } catch (error) {
      exposureError = error instanceof Error ? error.message : String(error)
    }
  }

  async function acknowledgeOpenTunnel(): Promise<void> {
    exposureError = null
    try {
      config = await window.api.invoke('remote:acknowledge-opentunnel')
    } catch (error) {
      exposureError = error instanceof Error ? error.message : String(error)
      return
    }
    await chooseExposure('opentunnel')
  }

  function openExternal(url: string): void {
    void window.api.invoke('app:open-external', url)
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

  async function forgetDevice(id: string): Promise<void> {
    pushError = null
    try {
      push = await window.api.invoke('push:unsubscribe', id)
    } catch (error) {
      pushError = error instanceof Error ? error.message : String(error)
    }
  }

  async function forgetAllDevices(): Promise<void> {
    pushError = null
    try {
      push = await window.api.invoke('push:forget-all')
    } catch (error) {
      pushError = error instanceof Error ? error.message : String(error)
    }
  }

  function when(at: number | null): string {
    if (at === null) return 'never'
    return new Date(at).toLocaleString()
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
      Serves SimpleEdit to a browser on this machine, over your Tailscale network, or through a
      public tunnel. Anyone with the link below can run terminals, edit files and remove
      worktrees — treat it as a password.
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

  <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
    <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">How the phone reaches this Mac</h2>
    <div class="mt-3">
      <h3 class="text-[13px] font-medium text-zinc-100">Network interface</h3>
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
    </div>

    <div class="mt-4 border-t border-zinc-800 pt-4">
      <h3 class="text-[13px] font-medium text-zinc-100">Tailscale</h3>
      {#if ts}
        <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt class="text-zinc-500">Command line</dt>
          <dd class="min-w-0 break-all {ts.cliUsable ? 'text-zinc-300' : 'text-amber-400'}">{ts.cli ?? 'not found'}</dd>
          <dt class="text-zinc-500">Connection</dt>
          <dd class={ts.backendState === 'Running' ? 'text-emerald-400' : 'text-amber-400'}>
            {ts.backendState ?? 'no answer'}
          </dd>
          <dt class="text-zinc-500">This node</dt>
          <dd class="min-w-0 break-all text-zinc-300">{ts.dnsName ?? '—'}</dd>
          <dt class="text-zinc-500">HTTPS certificate</dt>
          <dd class={ts.httpsReady ? 'text-emerald-400' : 'text-amber-400'}>
            {ts.httpsReady ? 'issued for this node' : 'not issued'}
          </dd>
        </dl>
        {#if ts.hint}
          <p class="mt-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-300">
            {ts.hint}
          </p>
        {/if}
      {/if}
    </div>

    <div class="mt-4 border-t border-zinc-800 pt-4">
      <h3 class="text-[13px] font-medium text-zinc-100">Publish beyond this Mac</h3>
      <p class="mt-2 text-xs leading-relaxed text-zinc-500">
        Gives SimpleEdit a real HTTPS address, which is the only kind of origin a browser will open a
        microphone on. Both options proxy to this Mac over loopback. Who can reach the address is a
        separate decision from turning remote access on, and never implied by it.
      </p>
      <fieldset class="mt-3 space-y-1.5" bind:this={radioGroup}>
        <legend class="sr-only">Publish beyond this Mac</legend>
        {#each EXPOSURE_CHOICES as choice (choice.id)}
          {@const selected = exposure === choice.id}
          {@const unavailable = choice.id === 'tailscale-serve' && !ts?.cliUsable}
          <label
            class="flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors
              has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-600
              {unavailable || choicesLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
              {selected
                ? 'border-blue-800 bg-blue-950/50'
                : 'border-zinc-800 hover:bg-zinc-800'}"
          >
            <input
              type="radio"
              name="remote-exposure"
              value={choice.id}
              checked={selected}
              disabled={unavailable}
              aria-disabled={choicesLocked}
              aria-label={EXPOSURE_LABELS[choice.id]}
              aria-describedby="exposure-{choice.id}"
              onchange={() => void chooseExposure(choice.id)}
              class="mt-0.5 flex-none accent-blue-500"
            />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-2 text-[13px] {selected ? 'text-blue-300' : 'text-zinc-200'}">
                {EXPOSURE_LABELS[choice.id]}
                {#if choice.experimental}
                  <span class="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">Experimental</span>
                {/if}
              </span>
              <span id="exposure-{choice.id}" class="mt-0.5 block text-xs leading-relaxed text-zinc-500">
                {#if choice.experimental}<span class="sr-only">Experimental. </span>{/if}{choice.blurb}
              </span>
            </span>
          </label>
        {/each}
      </fieldset>

      {#if acknowledging}
        <div
          class="mt-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-3 text-xs leading-relaxed text-amber-200"
          data-testid="opentunnel-ack"
        >
          <p class="font-semibold text-amber-300">OpenTunnel puts this Mac on the public internet</p>
          <ul class="mt-2 list-disc space-y-1 pl-4">
            <li>
              Anyone with the address can reach the sign-in page. The access key is the only
              protection: nothing checks which device is asking, as Tailscale does.
            </li>
            <li>
              OpenTunnel is a third-party service with no published terms, pricing or uptime
              guarantee. It can change or go away.
            </li>
            <li>
              Switching away from OpenTunnel deletes the tunnel. Choosing it again makes a new
              address, and the phone has to scan again.
            </li>
          </ul>
          <div class="mt-3 flex items-center gap-2">
            <button
              type="button"
              onclick={() => void acknowledgeOpenTunnel()}
              class="rounded-md bg-amber-900/60 px-2.5 py-1 text-xs font-medium text-amber-100 hover:bg-amber-900"
            >I understand, use OpenTunnel</button>
            <button
              type="button"
              onclick={() => { acknowledging = false }}
              class="rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >Cancel</button>
          </div>
        </div>
      {/if}

      {#if confirmingLeave}
        {@const target = confirmingLeave}
        <div
          class="mt-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-3 text-xs leading-relaxed text-amber-200"
          data-testid="opentunnel-leave"
        >
          <p class="font-semibold text-amber-300">Delete the OpenTunnel address?</p>
          <p class="mt-2">
            Switching to {EXPOSURE_LABELS[target]} deletes the tunnel. Its address stops working for
            good, and the phone will need to scan a new code. Choosing OpenTunnel again later makes a
            different address.
          </p>
          <div class="mt-3 flex items-center gap-2">
            <button
              type="button"
              onclick={() => void chooseExposure(target, true)}
              class="rounded-md bg-amber-900/60 px-2.5 py-1 text-xs font-medium text-amber-100 hover:bg-amber-900"
            >Delete tunnel and switch</button>
            <button
              type="button"
              onclick={() => { confirmingLeave = null }}
              class="rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >Keep OpenTunnel</button>
          </div>
        </div>
      {/if}

      {#if exposureError}
        <p class="mt-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs leading-relaxed text-red-300">{exposureError}</p>
      {/if}

      <!--
        The failure text is shown whatever it says, and the enable link is an
        addition to it rather than a replacement. Branching the other way meant a
        misclassified failure — one that merely mentioned a URL — replaced its own
        message with a link to the wrong place, so over-firing hid the error.
      -->
      {#if tunnel?.error}
        <div class="mt-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs leading-relaxed text-red-300">
          <p>{tunnel.error}</p>
          {#if tunnel.enableUrl}
            {@const enableUrl = tunnel.enableUrl}
            <p class="mt-2">
              Serve is an admin-console setting for the whole tailnet, so it cannot be turned on
              from here — and this link names your node, so it cannot be guessed either.
            </p>
            <button
              type="button"
              onclick={() => openExternal(enableUrl)}
              class="mt-2 break-all text-left text-blue-400 underline hover:text-blue-300"
            >{enableUrl} ↗</button>
          {/if}
        </div>
      {/if}

      {#each elsewhere as notice (notice.provider)}
        <p
          class="mt-3 rounded-md border px-3 py-2 text-xs leading-relaxed
            {notice.error ? 'border-red-900/60 bg-red-950/40 text-red-300' : 'border-zinc-800 text-zinc-400'}"
          data-testid="tunnel-elsewhere"
          role="status"
        >
          {EXPOSURE_LABELS[notice.provider]}: {notice.error ?? notice.progress ?? 'Removing…'}
          {#if notice.forgettable}
            <span class="mt-2 block text-zinc-400">
              If the relay stays unreachable you can forget the tunnel here instead. It may then remain
              on the relay, unused, with nothing on this Mac able to delete it later.
            </span>
            <button
              type="button"
              onclick={() => void forgetTunnel(notice.provider)}
              class="mt-2 rounded-md px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >Forget without deleting</button>
          {/if}
        </p>
      {/each}

      {#if tunnel?.busy && tunnel.progress}
        <p class="mt-3 text-xs leading-relaxed text-zinc-400" data-testid="tunnel-progress" role="status">
          {tunnel.progress}
          {#if exposure === 'opentunnel'}
            <span class="block text-zinc-500">
              The first time, this can take a minute while a certificate is issued for the address.
            </span>
          {/if}
        </p>
      {/if}

      {#if exposure !== 'off' && !status?.running}
        <p class="mt-3 text-xs leading-relaxed text-zinc-500">
          Remote access is off, so nothing is published yet.
          {#if exposure === 'opentunnel'}
            The address is kept while it is off, so turning it back on reuses it.
          {:else}
            Serve starts and stops with it, and the mapping never outlives the server it points at.
          {/if}
        </p>
      {:else if exposure !== 'off' && !boundToLoopback}
        <p class="mt-3 text-xs leading-relaxed text-amber-400">
          {exposureLabel} proxies to this Mac over loopback, so it stays idle while remote access is
          bound to {status?.host}. Choose “This Mac only” above to publish again.
        </p>
      {:else if exposure === 'opentunnel' && tunnel?.active && publicOrigin}
        <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt class="text-zinc-500">Address</dt>
          <dd class="min-w-0 break-all text-zinc-300" data-testid="tunnel-origin">{publicOrigin}</dd>
          <dt class="text-zinc-500">Relay</dt>
          <dd class={tunnel.connection === 'connected' ? 'text-emerald-400' : 'text-amber-400'} data-testid="tunnel-connection">
            {tunnel.connection ? CONNECTION_LABELS[tunnel.connection] : 'not connected'}
          </dd>
        </dl>
        <p class="mt-3 text-xs leading-relaxed text-zinc-500">
          The address stays the same across restarts and is deleted when you switch away from
          OpenTunnel. Every connection still needs the access key.
        </p>
      {:else if exposure === 'tailscale-serve' && tunnel?.active && tunnel.port}
        <p class="mt-3 text-xs leading-relaxed text-zinc-500">
          Serving port {tunnel.port}. The mapping is removed when remote access stops, when
          SimpleEdit quits, and at the next launch if it ever crashes — it proxies the server root,
          so the access key is still required for every connection.
        </p>
      {/if}
    </div>
  </section>

  {#if enabled && status?.running}
    <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">Pair a phone</h2>
      {#if pairing.url}
        <div class="mt-3 flex flex-wrap items-start gap-4">
          <QrCode value={pairing.url} label="Pairing code for remote access" />
          <div class="min-w-0 flex-1 space-y-2">
            <p class="text-[13px] leading-relaxed text-zinc-300">
              Point the phone's camera at this. The code carries the access key, so a photo of it
              is a password; it stops working when remote access stops, because the key is minted
              fresh on every start.
              {#if pairing.secure}
                After a restart, open the Home Screen app and use
                <span class="text-zinc-100">Scan QR code</span> in it — this address stays the same,
                so the app and its notifications carry on.
              {:else}
                This address changes port on every start, so after a restart scan the new code with
                the Camera again; a Home Screen copy cannot follow it. Tailscale Serve or OpenTunnel
                gives a stable address.
              {/if}
            </p>
            <code class="block break-all rounded-md bg-zinc-950 px-2.5 py-2 text-[11px] text-zinc-400">{pairing.url}</code>
            {#if pairing.secure}
              <p class="text-xs text-emerald-400">A real HTTPS certificate, so the phone will let the microphone open.</p>
            {/if}
            {#if pairing.note}
              <p class="text-xs leading-relaxed text-amber-400">{pairing.note}</p>
            {/if}
          </div>
        </div>
      {:else}
        <p class="mt-2 text-[13px] leading-relaxed text-zinc-400" data-testid="pairing-note">
          {pairing.note ?? 'There is nothing to pair with yet.'}
        </p>
      {/if}
    </section>

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
        The <code>k=</code> part is the access key. It is regenerated every time the server
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
  {/if}

  <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
    <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">Notifications</h2>
    <p class="mt-2 text-xs leading-relaxed text-zinc-500">
      A phone gets one notification when a session stops and needs you, and nothing else. It fires
      only on a signal the agent reported itself — never on a guess — because a buzz that might
      mean nothing teaches you to ignore the one that mattered. It covers every provider, which is
      why it exists: Claude Code's own Remote Control only notifies for Claude.
    </p>
    <p class="mt-2 text-xs leading-relaxed text-zinc-500">
      Nothing is sent while you are here — a SimpleEdit window focused, and this Mac used in the
      last couple of minutes. The prompt is already on the screen in front of you. Walk away and
      the next one reaches your phone. SimpleEdit writes that same “I am here” signal where Claude
      Code reads it, so a Claude session does not buzz you twice.
    </p>
    <p class="mt-2 text-xs leading-relaxed text-zinc-500">
      The message is encrypted end to end. Apple relays it without being able to read it, and the
      signing key never leaves this Mac.
    </p>

    <!--
      The one thing that must be explained rather than discovered. On iOS the
      push APIs do not exist in a Safari tab at all, so the button on the phone
      is not merely disabled — the page cannot ask.
    -->
    <ol class="mt-3 space-y-1.5 text-xs leading-relaxed text-zinc-400" data-testid="push-install-steps">
      <li>
        <span class="font-semibold text-zinc-300">1.</span>
        Open the pairing link on the phone. It has to be the <span class="text-zinc-300">https://</span>
        one; if there isn't one, the publishing section above says what is still missing.
      </li>
      <li>
        <span class="font-semibold text-zinc-300">2.</span>
        In Safari, tap Share → <span class="text-zinc-300">Add to Home Screen</span>. iOS will not
        let a page ask for notification permission until it has been installed, so this step is not
        optional and there is no way to do it from here.
      </li>
      <li>
        <span class="font-semibold text-zinc-300">3.</span>
        Open SimpleEdit from the Home Screen icon and tap
        <span class="text-zinc-300">Turn on notifications</span> on the Sessions screen. The
        permission prompt only appears from that tap.
      </li>
    </ol>

    {#if !status?.running}
      <p class="mt-3 text-xs leading-relaxed text-amber-400" data-testid="push-needs-server">
        Remote access is off, so nothing would be sent: a notification has to open something, and
        with the server down there is no address to open.
      </p>
    {/if}

    {#if pushError}
      <p class="mt-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">{pushError}</p>
    {:else if push?.error}
      <p class="mt-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">{push.error}</p>
    {/if}

    {#if push}
      <div class="mt-4 border-t border-zinc-800 pt-3">
        <div class="flex items-center justify-between gap-4">
          <h3 class="text-[13px] font-medium text-zinc-100">Registered devices</h3>
          {#if push.devices.length > 0}
            <button
              type="button"
              onclick={() => void forgetAllDevices()}
              data-testid="forget-all-devices"
              class="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >Forget all</button>
          {/if}
        </div>

        {#if push.devices.length === 0}
          <p class="mt-2 text-xs leading-relaxed text-zinc-500" data-testid="no-push-devices">
            No device is registered yet. A device registers itself from the mobile app — there is
            nothing to do here.
          </p>
        {:else}
          <ul class="mt-2 space-y-1.5" data-testid="push-devices">
            {#each push.devices as device (device.id)}
              <li class="flex items-center gap-3 rounded-md border border-zinc-800 px-3 py-2 text-xs">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13px] text-zinc-200">{device.label}</span>
                  <span class="block truncate text-zinc-500">
                    {device.service} · last notified {when(device.lastPushAt)}
                  </span>
                  {#if device.lastError}
                    <span class="block truncate text-amber-400">{device.lastError}</span>
                  {/if}
                </span>
                <button
                  type="button"
                  onclick={() => void forgetDevice(device.id)}
                  data-testid="forget-device"
                  class="flex-none rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >Forget</button>
              </li>
            {/each}
          </ul>
          <p class="mt-2 text-xs leading-relaxed text-zinc-500">
            A device is listed by the push service it uses, never by its address — that address is
            itself permission to notify it. One that the push service reports as gone is dropped on
            the next attempt, without being retried forever.
          </p>
        {/if}
      </div>
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

  {#if enabled && status?.running}
    <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">Sleep</h2>
      <p class="mt-2 text-[13px] text-zinc-300">
        {#if status.powerSaveBlocked}
          Holding a power assertion — this Mac will not fall asleep on its own while remote access
          is on.
        {:else}
          <span class="text-amber-400">No power assertion is held.</span>
          This Mac can sleep, and your agents stop with it.
        {/if}
      </p>
      <p class="mt-1.5 text-xs leading-relaxed text-zinc-500">
        Sleeping stops the agents, not just the notifications — and it does so silently, which is
        why this is stated rather than assumed. The display is still allowed to sleep.
      </p>
      <!--
        Said plainly because the notification depends on it, and because
        "will not sleep" is the sentence a user would otherwise carry away.
        The assertion covers IDLE sleep only; nothing an app can hold stops
        macOS sleeping when the lid closes.
      -->
      <p class="mt-1.5 text-xs leading-relaxed text-zinc-500">
        What it does not cover: closing the lid. A MacBook asleep in a bag runs no agents and sends
        no notifications, whatever assertion is held. Leave it open, or attach a display.
      </p>
    </section>
  {/if}
</div>
