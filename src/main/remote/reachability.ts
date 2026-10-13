/**
 * Reachability providers: what puts the loopback server somewhere a phone can
 * reach, under a name with a real certificate.
 *
 * Every provider writes state outside the app that can outlive it, so the
 * contract is about lifetime as much as about publishing: a mapping follows
 * its server, is torn down synchronously at quit, and is reclaimed at the next
 * launch after a crash. `serve.ts` states those rules in full for Tailscale
 * Serve, the first implementation.
 *
 * Only one provider is chosen at a time (`RemoteAccessConfig.exposure`), but
 * teardown and crash reclaim run across all of them: a provider that was
 * switched away from can still hold a mapping it failed to remove.
 */
import type { RemoteExposure, TunnelStatus } from '../../shared/ipc-types'
import { tailscaleServe } from './serve'

/** The running server a provider publishes. */
export interface TunnelTarget {
  port: number
  /** The server's access key. A provider must never hand it to the tunnel itself. */
  token: string
}

export interface ReachabilityProvider {
  readonly id: Exclude<RemoteExposure, 'off'>
  /**
   * Ask for `target` to be published, re-pointed, or with null removed, and
   * return as soon as the request is accepted — typically `busy`. Provisioning
   * can take a minute, and nothing that starts or reconfigures the server may
   * wait on it. The latest call wins over one still in flight.
   */
  apply(target: TunnelTarget | null): TunnelStatus
  status(): TunnelStatus
  /** Teardown for quit, where an `await` never settles. */
  stopSync(): void
  /** Remove a mapping a crashed run left behind. Runs before any server starts. */
  reclaimAbandoned(): Promise<void>
  /**
   * Fires whenever the status changes, on the provider's own timeline: a
   * request accepted or settled, progress, a new URL, a reconnect, an error.
   * This, not `apply`'s return value, is how an outcome is learned. Returns
   * the unsubscribe.
   */
  onChange(listener: (status: TunnelStatus) => void): () => void
}

export const PROVIDERS = {
  'tailscale-serve': tailscaleServe,
} satisfies Record<Exclude<RemoteExposure, 'off'>, ReachabilityProvider>

const ALL: readonly ReachabilityProvider[] = Object.values(PROVIDERS)

/**
 * The status to show for `exposure`.
 *
 * With exposure off there is still something to report while a provider is
 * tearing down, or holds a mapping it could not remove — that is exactly when
 * the pane has to say why.
 */
export function tunnelStatus(exposure: RemoteExposure): TunnelStatus {
  if (exposure !== 'off') return PROVIDERS[exposure].status()
  const statuses = ALL.map((provider) => provider.status())
  return (
    statuses.find((status) => status.busy || status.active || status.port !== null || status.error !== null) ??
    statuses[0]
  )
}

/** Publish `target` through the chosen provider, and withdraw it from every other. */
export function applyExposure(exposure: RemoteExposure, target: TunnelTarget | null): TunnelStatus {
  for (const provider of ALL) {
    try {
      provider.apply(provider.id === exposure ? target : null)
    } catch (err: unknown) {
      console.error(`[SimpleEdit] ${provider.id} refused a tunnel request:`, err)
    }
  }
  return tunnelStatus(exposure)
}

export function stopAllTunnelsSync(): void {
  for (const provider of ALL) {
    try { provider.stopSync() } catch { /* one provider failing must not strand another's mapping */ }
  }
}

/** Settles only once EVERY provider has finished, so no reclaim can race the server start behind it. */
export async function reclaimAbandonedTunnels(): Promise<void> {
  const results = await Promise.allSettled(ALL.map((provider) => provider.reclaimAbandoned()))
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[SimpleEdit] Failed to reclaim an abandoned ${ALL[i].id} mapping:`, result.reason)
    }
  })
}
