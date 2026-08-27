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
 *  - **Tailscale** (100.64.0.0/10, the CGNAT range it allocates from) —
 *    reaches your own devices, authenticated at the device level, with a real
 *    certificate.
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

export function isTailscaleAddress(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const [a, b] = parts.map((p) => Number(p))
  return a === 100 && b >= 64 && b <= 127
}

export function listRemoteInterfaces(): RemoteInterface[] {
  const out: RemoteInterface[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4') continue
      const isTailscale = isTailscaleAddress(addr.address)
      if (!isTailscale && !addr.internal) continue
      out.push({ name, address: addr.address, isTailscale, isLoopback: addr.internal })
    }
  }
  // Tailscale first (the one a phone can reach), loopback after.
  out.sort((a, b) => Number(b.isTailscale) - Number(a.isTailscale))
  return out
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
