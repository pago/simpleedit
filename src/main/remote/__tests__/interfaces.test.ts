import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockInterfaces = vi.fn()
vi.mock('os', () => ({ networkInterfaces: () => mockInterfaces() }))

import { isCgnatAddress, isAllowedBindHost, listRemoteInterfaces, REMOTE_DEFAULT_HOST } from '../interfaces'

const LOOPBACK = { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }
/** Tailscale on macOS: an ordinary utun name, but a /32 host route. */
const TAILSCALE_MAC = { address: '100.101.102.103', netmask: '255.255.255.255', family: 'IPv4', internal: false }
/** The dangerous one: a real LAN behind carrier-grade NAT. */
const CGNAT_LAN = { address: '100.96.14.7', netmask: '255.255.255.0', family: 'IPv4', internal: false }
/** A corporate VPN — same utun naming, different range and prefix. */
const OTHER_VPN = { address: '10.10.1.62', netmask: '255.255.252.0', family: 'IPv4', internal: false }
const PLAIN_LAN = { address: '192.168.178.130', netmask: '255.255.255.0', family: 'IPv4', internal: false }

function onPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

const realPlatform = process.platform

beforeEach(() => {
  onPlatform('darwin')
  mockInterfaces.mockReturnValue({})
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('isCgnatAddress', () => {
  it('recognises the shared-address range', () => {
    expect(isCgnatAddress('100.64.0.1')).toBe(true)
    expect(isCgnatAddress('100.127.255.255')).toBe(true)
  })

  it('rejects neighbouring 100.x addresses outside 100.64.0.0/10', () => {
    expect(isCgnatAddress('100.63.0.1')).toBe(false)
    expect(isCgnatAddress('100.128.0.1')).toBe(false)
  })

  it('rejects ordinary LAN, loopback and malformed addresses', () => {
    expect(isCgnatAddress('192.168.1.10')).toBe(false)
    expect(isCgnatAddress('127.0.0.1')).toBe(false)
    expect(isCgnatAddress('::1')).toBe(false)
    expect(isCgnatAddress('nonsense')).toBe(false)
  })
})

describe('Tailscale identification', () => {
  it('accepts a Tailscale utun on macOS — CGNAT range with a /32 host route', () => {
    mockInterfaces.mockReturnValue({ lo0: [LOOPBACK], utun3: [TAILSCALE_MAC] })
    const found = listRemoteInterfaces()
    expect(found[0]).toMatchObject({ name: 'utun3', address: '100.101.102.103', isTailscale: true })
    expect(isAllowedBindHost('100.101.102.103')).toBe(true)
  })

  // The blocker this test exists for: Starlink, T-Mobile Home Internet, mobile
  // hotspots, hotels and campuses hand CGNAT addresses to ordinary interfaces.
  // A range check called this Tailscale, sorted it FIRST, and badged it safe.
  it('refuses a carrier-NAT LAN address, however much it looks like Tailscale', () => {
    mockInterfaces.mockReturnValue({ lo0: [LOOPBACK], en0: [CGNAT_LAN] })
    const found = listRemoteInterfaces()
    expect(found.map((i) => i.address)).toEqual(['127.0.0.1'])
    expect(isAllowedBindHost('100.96.14.7')).toBe(false)
  })

  it('refuses another VPN on the same utun naming', () => {
    mockInterfaces.mockReturnValue({ lo0: [LOOPBACK], utun4: [OTHER_VPN] })
    expect(listRemoteInterfaces().map((i) => i.address)).toEqual(['127.0.0.1'])
    expect(isAllowedBindHost('10.10.1.62')).toBe(false)
  })

  it('refuses a CGNAT address on a utun that is not a host route', () => {
    mockInterfaces.mockReturnValue({ utun9: [{ ...TAILSCALE_MAC, netmask: '255.255.255.0' }] })
    expect(listRemoteInterfaces()).toEqual([])
  })

  it('identifies the interface by name on Linux', () => {
    onPlatform('linux')
    mockInterfaces.mockReturnValue({ lo: [LOOPBACK], tailscale0: [{ ...TAILSCALE_MAC, netmask: '255.255.255.255' }], eth0: [CGNAT_LAN] })
    const found = listRemoteInterfaces()
    expect(found.filter((i) => i.isTailscale).map((i) => i.name)).toEqual(['tailscale0'])
    expect(isAllowedBindHost('100.96.14.7')).toBe(false)
  })
})

describe('the bind allowlist', () => {
  it('never offers an address that is neither loopback nor Tailscale', () => {
    mockInterfaces.mockReturnValue({ lo0: [LOOPBACK], en0: [PLAIN_LAN], utun3: [TAILSCALE_MAC] })
    for (const iface of listRemoteInterfaces()) {
      expect(iface.isLoopback || iface.isTailscale).toBe(true)
    }
    expect(isAllowedBindHost('192.168.178.130')).toBe(false)
  })

  it('sorts the Tailscale address first — it is the one a phone can reach', () => {
    mockInterfaces.mockReturnValue({ lo0: [LOOPBACK], utun3: [TAILSCALE_MAC] })
    expect(listRemoteInterfaces()[0].isTailscale).toBe(true)
  })

  it('always allows loopback, even when enumeration finds nothing', () => {
    mockInterfaces.mockReturnValue({})
    expect(isAllowedBindHost(REMOTE_DEFAULT_HOST)).toBe(true)
  })

  it('refuses the addresses that would widen the surface', () => {
    mockInterfaces.mockReturnValue({ lo0: [LOOPBACK] })
    expect(isAllowedBindHost('0.0.0.0')).toBe(false)
    expect(isAllowedBindHost('::')).toBe(false)
    expect(isAllowedBindHost('')).toBe(false)
  })
})
