/**
 * The addresses remote access may bind to.
 *
 * This is an ALLOWLIST, not an enumeration. `os.networkInterfaces()` also
 * reports the café Wi-Fi, and one click on that puts a surface that can spawn
 * shells and delete worktrees on an untrusted LAN, over plain HTTP, with the
 * access token in cleartext in every request line. Two kinds of address are
 * defensible and nothing else is:
 *
 *  - **Loopback** — reaches this machine only, and is the one non-TLS origin
 *    browsers still treat as a secure context.
 *  - **Tailscale** — reaches your own devices, authenticated at the device
 *    level, with a real certificate. Identified by the INTERFACE, not by the
 *    address: Tailscale allocates from 100.64.0.0/10, but so does carrier-grade
 *    NAT, and Starlink, T-Mobile Home Internet, mobile hotspots, hotels and
 *    campuses hand those addresses to ordinary LAN interfaces. Matching the
 *    range alone would offer the café network first, with a green badge
 *    asserting it was safe.
 *
 * Anything else is filtered out here rather than labelled in the UI, because a
 * warning next to a button is not a control. `0.0.0.0` is not reachable by any
 * path: it is not an interface address, so it can never appear in this list,
 * and `isAllowedBindHost` is what every entry point validates against.
 */
import { networkInterfaces } from 'os'
import type { RemoteInterface } from '../../shared/ipc-types'

/** Loopback, and the only address guaranteed to exist. */
export const REMOTE_DEFAULT_HOST = '127.0.0.1'

/**
 * The 100.64.0.0/10 shared-address space (RFC 6598).
 *
 * Necessary for a Tailscale address and nowhere near sufficient — this is the
 * range carrier-grade NAT draws from too. Never use it on its own to decide
 * whether an interface is safe to bind.
 */
export function isCgnatAddress(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const [a, b] = parts.map((p) => Number(p))
  return a === 100 && b >= 64 && b <= 127
}

/**
 * Does this interface belong to the Tailscale device itself?
 *
 * Tailscale gives its interface a host route — a /32 — which a LAN interface
 * on a carrier-NAT network never has, and that is what separates the two on
 * macOS, where the name is an ordinary `utunN` shared with every other VPN.
 * Linux and Windows name the interface outright.
 */
function isTailscaleInterface(name: string, address: string, netmask: string, internal: boolean): boolean {
  if (internal || !isCgnatAddress(address)) return false
  if (process.platform === 'darwin') return /^utun\d+$/.test(name) && netmask === '255.255.255.255'
  if (process.platform === 'win32') return /tailscale/i.test(name)
  return name === 'tailscale0'
}

export function listRemoteInterfaces(): RemoteInterface[] {
  const out: RemoteInterface[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4') continue
      const isTailscale = isTailscaleInterface(name, addr.address, addr.netmask, addr.internal)
      if (!isTailscale && !addr.internal) continue
      out.push({ name, address: addr.address, isTailscale, isLoopback: addr.internal })
    }
  }
  // Tailscale first (the one a phone can reach), loopback after.
  out.sort((a, b) => Number(b.isTailscale) - Number(a.isTailscale))
  return out
}

/**
 * Does this bind address reach only this machine?
 *
 * Serve is offered for a loopback bind and nothing else, so this decides more
 * than a label — see `syncServe` in `index.ts`.
 */
export function isLoopbackHost(host: string | null): boolean {
  return host === REMOTE_DEFAULT_HOST || host === 'localhost' || host === '::1'
}

/**
 * May the server bind here? Validated in MAIN at every entry point — the
 * setting is reachable over the socket, so a token holder must not be able to
 * name an address the pane would never have offered.
 *
 * Loopback is always allowed even if enumeration fails, so a machine with no
 * usable interfaces still has somewhere safe to fall back to.
 */
export function isAllowedBindHost(host: string): boolean {
  if (host === REMOTE_DEFAULT_HOST) return true
  return listRemoteInterfaces().some((i) => i.address === host)
}
