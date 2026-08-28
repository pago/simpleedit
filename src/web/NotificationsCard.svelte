<script lang="ts">
  /**
   * Turning notifications on, at the only place a user gesture exists.
   *
   * It sits on the Sessions screen and disappears once this device is
   * registered — an always-visible settings row would be chrome on the one
   * screen the plan says gets a title, one action and nothing else.
   *
   * Permission is requested from the tap and never on load. On iOS a page that
   * asks on load is refused outright; everywhere else it is the behaviour that
   * teaches people to deny.
   */
  import { onMount } from 'svelte'
  import {
    blockerMessage,
    enablePush,
    hasSubscription,
    pushCapability,
    PushCancelled,
    type PushCapability,
  } from './lib/push-client'

  let capability = $state<PushCapability | null>(null)
  let subscribed = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let controller: AbortController | null = null

  onMount(() => {
    capability = pushCapability()
    void hasSubscription().then((next) => { subscribed = next })
    // The operation is bound to this component: leaving the screen mid-flight
    // must not leave a subscription registered with Apple that nothing on this
    // Mac knows about.
    return () => controller?.abort()
  })

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
      await enablePush(status.vapidPublicKey, (subscription) => window.api.invoke('push:subscribe', subscription), {
        signal,
        label: deviceLabel(),
      })
      subscribed = true
    } catch (err) {
      if (!(err instanceof PushCancelled)) {
        error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      busy = false
      controller = null
      capability = pushCapability()
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

{#if capability && !subscribed}
  <section
    class="mb-4 rounded-lg border border-zinc-800 bg-zinc-900 p-3"
    data-testid="notifications-card"
  >
    <h2 class="text-[13px] font-medium text-zinc-100">Get told when a session blocks</h2>
    <p class="mt-1 text-xs leading-relaxed text-zinc-500">
      One notification when an agent stops and needs you — nothing else. Tapping it opens that
      session with the composer ready; the microphone never opens on its own.
    </p>

    {#if hint}
      <p class="mt-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-xs leading-relaxed text-amber-300" data-testid="push-blocker">
        {hint}
      </p>
    {/if}

    {#if error}
      <p class="mt-2 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs text-red-300" data-testid="push-error">
        {error}
      </p>
    {/if}

    <div class="mt-2.5 flex items-center gap-2">
      <button
        type="button"
        onclick={() => void enable()}
        disabled={busy || capability.blocker !== null}
        data-testid="enable-push"
        class="min-h-9 rounded-md bg-zinc-100 px-3 text-xs font-semibold text-zinc-900 disabled:opacity-40"
      >{busy ? 'Asking…' : 'Turn on notifications'}</button>
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
