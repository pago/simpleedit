/**
 * Candidate bind addresses for the Remote access pane.
 *
 * Offering a list beats a free-text host field: the point is to make the
 * Tailscale interface an obvious, single click and to leave `0.0.0.0` off the
 * menu entirely. Tailscale hands out addresses in 100.64.0.0/10 (the CGNAT
 * range), which is what identifies one here.
 */
import { networkInterfaces } from 'os'
import type { RemoteInterface } from '../../shared/ipc-types'

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
      out.push({
        name,
        address: addr.address,
        isTailscale: isTailscaleAddress(addr.address),
        isLoopback: addr.internal,
      })
    }
  }
  // Tailscale first (the one a phone can reach), loopback next (the one a
  // desktop browser uses and the only non-TLS secure context), then the rest.
  return out.sort((a, b) => rank(a) - rank(b))
}

function rank(i: RemoteInterface): number {
  if (i.isTailscale) return 0
  if (i.isLoopback) return 1
  return 2
}
