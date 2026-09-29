<script lang="ts">
  /**
   * Turning notifications on and off, at the only place a user gesture exists.
   *
   * It sits on the Sessions screen. Once notifications are working it shrinks
   * to a single line with a way out — never to nothing. An earlier version hid
   * itself entirely on the browser's own answer to "am I subscribed", which is
   * half the question: the Mac can forget this device (the user taps Forget in
   * the pane, the push service disowns the endpoint, a corrupt VAPID pair is
   * replaced) and the phone would then sit believing it was registered, showing
   * no control at all, with no way back short of clearing site data.
   *
   * Permission is requested from the tap and never on load. On iOS a page that
   * asks on load is refused outright; everywhere else it is the behaviour that
   * teaches people to deny.
   */
  import { onMount } from 'svelte'
  import {
    blockerMessage,
    disablePush,
    enablePush,
    pushCapability,
    PushCancelled,
    subscriptionState,
    type PushCapability,
    type SubscriptionState,
  } from './lib/push-client'

  let capability = $state<PushCapability | null>(null)
  let subscription = $state<SubscriptionState | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let controller: AbortController | null = null

  onMount(() => {
    capability = pushCapability()
    void refresh()
    // The operation is bound to this component: leaving the screen mid-flight
    // must not leave a subscription registered with Apple that nothing on this
    // Mac knows about.
    return () => controller?.abort()
  })

  async function refresh(): Promise<void> {
    subscription = await subscriptionState((endpoint) =>
      window.api.invoke('push:device-id', endpoint),
    )
  }

  async function enable(): Promise<void> {
    if (busy) return
    // Reserved synchronously, before the first await — the window between the
    // tap and the first tracked resource is exactly where a second tap would
    // start a second subscription.
    busy = true
    error = null
    controller = new AbortController()
    const signal = controller.signal
    try {
      const status = await window.api.invoke('push:status')
      await enablePush(status.vapidPublicKey, (sub) => window.api.invoke('push:subscribe', sub), {
        signal,
        label: deviceLabel(),
        remove: (endpoint) => window.api.invoke('push:unsubscribe', endpoint),
      })
    } catch (err) {
      if (!(err instanceof PushCancelled)) {
        error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      busy = false
      controller = null
      capability = pushCapability()
      await refresh()
    }
  }

  async function disable(): Promise<void> {
    if (busy) return
    busy = true
    error = null
    try {
      await disablePush((endpoint) => window.api.invoke('push:unsubscribe', endpoint))
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
      await refresh()
    }
  }

  function cancel(): void {
    controller?.abort()
  }

  /** Something a person can tell apart in the Remote access pane. */
  function deviceLabel(): string {
    const ua = navigator.userAgent
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/iPad/.test(ua)) return 'iPad'
    if (/Android/.test(ua)) return 'Android phone'
    if (/Macintosh/.test(ua)) return 'Mac browser'
    return 'A browser'
  }

  const hint = $derived(capability ? blockerMessage(capability) : null)
</script>

{#if capability && subscription}
  {#if subscription.active}
    <!-- Working: one line, and a way out. Never nothing. -->
    <div
      class="mb-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2"
      data-testid="notifications-active"
    >
      <span class="h-1.5 w-1.5 flex-none rounded-full bg-emerald-400"></span>
      <span class="min-w-0 flex-1 truncate text-xs text-zinc-400">
        Notifications on for this device
      </span>
      <button
        type="button"
        onclick={() => void disable()}
        disabled={busy}
        data-testid="disable-push"
        class="flex-none rounded-md px-2 py-1 text-xs text-zinc-500 active:bg-zinc-800 disabled:opacity-40"
      >Turn off</button>
    </div>
  {:else}
    <section
      class="mb-4 rounded-lg border border-zinc-800 bg-zinc-900 p-3"
      data-testid="notifications-card"
    >
      <h2 class="text-[13px] font-medium text-zinc-100">
        {subscription.orphaned ? 'Notifications stopped working' : 'Get told when a session blocks'}
      </h2>
      <p class="mt-1 text-xs leading-relaxed text-zinc-500">
        {#if subscription.orphaned}
          This device is no longer registered on the Mac — it was forgotten there, or the push
          service dropped it. Turning them on again re-registers this device.
        {:else}
          One notification when an agent stops and needs you — nothing else, and nothing while
          you are at the Mac. Tapping it opens that session with the composer ready; the
          microphone never opens on its own.
        {/if}
      </p>

      {#if hint}
        <p
          class="mt-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-xs leading-relaxed text-amber-300"
          data-testid="push-blocker"
        >{hint}</p>
      {/if}

      {#if error}
        <p
          class="mt-2 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs text-red-300"
          data-testid="push-error"
        >{error}</p>
      {/if}

      <div class="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onclick={() => void enable()}
          disabled={busy || capability.blocker !== null}
          data-testid="enable-push"
          class="min-h-9 rounded-md bg-zinc-100 px-3 text-xs font-semibold text-zinc-900 disabled:opacity-40"
        >{busy ? 'Asking…' : subscription.orphaned ? 'Turn them back on' : 'Turn on notifications'}</button>
        {#if busy}
          <button
            type="button"
            onclick={cancel}
            data-testid="cancel-push"
            class="min-h-9 rounded-md px-3 text-xs text-zinc-400 active:bg-zinc-800"
          >Cancel</button>
        {/if}
      </div>
    </section>
  {/if}
{/if}
