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
 *
 * ── Server stopped is not provider deselected ────────────────────────────
 * Two different events, and a provider may treat them differently:
 *
 *  - `apply(null)`: the provider is still chosen, but there is no server to
 *    publish (remote access off, a non-loopback bind). Tailscale Serve removes
 *    its mapping, because the next server gets a fresh ephemeral port anyway.
 *    OpenTunnel only drops its connection and keeps its identity, so the next
 *    start comes back under the same URL and an installed phone app carries on.
 *  - `withdraw()`: the exposure moved away from this provider. Everything it
 *    keeps outside the app goes, including an identity kept for a stable URL.
 *
 * Quit is the first kind (`stopSync`), and so is a crash: `reclaimAbandoned`
 * is told which exposure is chosen, so a provider still chosen keeps what it
 * deliberately left in place.
 */
import type { RemoteExposure, TunnelNotice, TunnelStatus } from '../../shared/ipc-types'
import { tailscaleServe } from './serve'
import { openTunnel } from './opentunnel'
import type { ProxyTrust } from './server'

/** The running server a provider publishes. */
export interface TunnelTarget {
  port: number
  /** The server's access key. A provider must never hand it to the tunnel itself. */
  token: string
}

export interface ReachabilityProvider {
  readonly id: Exclude<RemoteExposure, 'off'>
  /**
   * May the server believe `x-forwarded-*` on a loopback request while this
   * provider is chosen? True only for a proxy that sets them itself and that
   * no visitor can reach past: `tailscale serve` does, and only tailnet devices
   * reach it. An OpenTunnel visitor's own headers arrive verbatim, from
   * 127.0.0.1 like everything tunnelled, so there they would be the visitor's
   * word for its own origin.
   */
  readonly trustsForwardedHeaders: boolean
  /**
   * Ask for `target` to be published, re-pointed, or with null removed, and
   * return as soon as the request is accepted — typically `busy`. Provisioning
   * can take a minute, and nothing that starts or reconfigures the server may
   * wait on it. The latest call wins over one still in flight.
   */
  apply(target: TunnelTarget | null): TunnelStatus
  /**
   * The exposure moved away from this provider: remove everything it holds
   * outside the app, as `apply` does, without waiting. Called on every sync
   * while another exposure is chosen, so it must be cheap when there is
   * nothing to remove.
   */
  withdraw(): TunnelStatus
  /**
   * Give up on removing what a withdrawal could not: forget it here and leave
   * it wherever it is. Only for a provider whose removal can fail for good
   * (OpenTunnel, against an unreachable relay); only while not chosen.
   */
  forget?(): TunnelStatus
  status(): TunnelStatus
  /** Teardown for quit, where an `await` never settles. Never deletes what a restart should find again. */
  stopSync(): void
  /**
   * Remove what a crashed run left behind. Runs before any server starts.
   * `exposure` is what is chosen now, so a provider can keep what it means to
   * keep while it is still the one chosen.
   */
  reclaimAbandoned(exposure: RemoteExposure): Promise<void>
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
  opentunnel: openTunnel,
} satisfies Record<Exclude<RemoteExposure, 'off'>, ReachabilityProvider>

const ALL: readonly ReachabilityProvider[] = Object.values(PROVIDERS)

/** Holds a mapping or a connection, or has work in flight. */
function engaged(status: TunnelStatus): boolean {
  return status.busy || status.active || status.port !== null
}

/**
 * Could visitors be arriving through this provider right now: a bridge live or
 * being attached, or a port held. Narrower than `engaged` on purpose: a
 * removal stuck retrying against a dead relay is busy, but delivers nobody,
 * and must not keep Serve's forwarded headers distrusted the whole time.
 */
function deliversVisitors(status: TunnelStatus): boolean {
  return status.active || status.port !== null || (status.connection ?? null) !== null
}

/**
 * The status to show for `exposure`.
 *
 * With exposure off there is still something to report while a provider is
 * tearing down, or holds a mapping it could not remove — that is exactly when
 * the pane has to say why. The same goes for a provider that was switched away
 * from while another is chosen: its teardown or its failure to tear down rides
 * along in `elsewhere`, because a public tunnel that could not be deleted must
 * not go quiet just because Tailscale is now the one on screen.
 */
export function tunnelStatus(exposure: RemoteExposure): TunnelStatus {
  // With nothing chosen, a provider that can be forgotten never takes the
  // primary slot: `elsewhere` is where its failure comes with the Forget action.
  const primary =
    exposure !== 'off'
      ? PROVIDERS[exposure]
      : (ALL.find((provider) => {
          if (provider.forget) return false
          const status = provider.status()
          return engaged(status) || status.error !== null
        }) ?? ALL[0])
  const status = primary.status()
  const elsewhere: TunnelNotice[] = []
  for (const provider of ALL) {
    if (provider === primary) continue
    const other = provider.status()
    if (!other.busy && other.error === null) continue
    elsewhere.push({
      provider: provider.id,
      busy: other.busy,
      progress: other.progress ?? null,
      error: other.error,
      forgettable: provider.forget !== undefined && other.error !== null,
    })
  }
  return elsewhere.length > 0 ? { ...status, elsewhere } : status
}

/** Publish `target` through the chosen provider, and withdraw every other. */
export function applyExposure(exposure: RemoteExposure, target: TunnelTarget | null): TunnelStatus {
  for (const provider of ALL) {
    try {
      if (provider.id === exposure) provider.apply(target)
      else provider.withdraw()
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

/** Forget a provider's leftover that could not be removed; never the chosen one's. */
export function forgetTunnel(provider: Exclude<RemoteExposure, 'off'>, exposure: RemoteExposure): TunnelStatus {
  if (provider === exposure) throw new Error('Choose another exposure before forgetting this one')
  PROVIDERS[provider].forget?.()
  return tunnelStatus(exposure)
}

/**
 * What the server may believe about a loopback request's origin while
 * `exposure` is chosen. With nothing chosen, forwarded headers stay trusted: a
 * person can run their own `tailscale serve` by hand.
 *
 * An untrusted provider counts while it is chosen AND while it could still
 * deliver visitors after being switched away from (`deliversVisitors`): its close is queued behind the
 * switch, and until it runs, visitors can still arrive through it. Failing
 * closed costs a Serve page a moment; failing open hands any visitor its own
 * origin.
 *
 * Such a provider still terminates TLS, so its public host is named here: a
 * request for that host came in over HTTPS, and the page it loads reports an
 * `https://` origin.
 */
export function proxyTrust(exposure: RemoteExposure): ProxyTrust {
  const untrusted = ALL.filter(
    (provider) => !provider.trustsForwardedHeaders && (provider.id === exposure || deliversVisitors(provider.status())),
  )
  if (untrusted.length === 0) return { forwardedHeaders: true, httpsHosts: [] }
  const httpsHosts = untrusted.flatMap((provider) => {
    const url = provider.status().url
    return url ? [new URL(url).host] : []
  })
  return { forwardedHeaders: false, httpsHosts }
}

/** Settles only once EVERY provider has finished, so no reclaim can race the server start behind it. */
export async function reclaimAbandonedTunnels(exposure: RemoteExposure): Promise<void> {
  const results = await Promise.allSettled(ALL.map((provider) => provider.reclaimAbandoned(exposure)))
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[SimpleEdit] Failed to reclaim an abandoned ${ALL[i].id} mapping:`, result.reason)
    }
  })
}
