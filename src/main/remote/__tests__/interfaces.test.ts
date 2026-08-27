import { describe, it, expect } from 'vitest'
import { isTailscaleAddress, isAllowedBindHost, listRemoteInterfaces, REMOTE_DEFAULT_HOST } from '../interfaces'

describe('isTailscaleAddress', () => {
  it('recognises the CGNAT range Tailscale allocates from', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true)
    expect(isTailscaleAddress('100.101.102.103')).toBe(true)
    expect(isTailscaleAddress('100.127.255.255')).toBe(true)
  })

  it('rejects neighbouring 100.x addresses outside 100.64.0.0/10', () => {
    expect(isTailscaleAddress('100.63.0.1')).toBe(false)
    expect(isTailscaleAddress('100.128.0.1')).toBe(false)
  })

  it('rejects ordinary LAN, loopback and malformed addresses', () => {
    expect(isTailscaleAddress('192.168.1.10')).toBe(false)
    expect(isTailscaleAddress('127.0.0.1')).toBe(false)
    expect(isTailscaleAddress('::1')).toBe(false)
    expect(isTailscaleAddress('nonsense')).toBe(false)
  })
})

describe('the bind allowlist', () => {
  it('never offers an address that is neither loopback nor Tailscale', () => {
    // The blocker this list exists to prevent: one click binding the café LAN.
    for (const iface of listRemoteInterfaces()) {
      expect(iface.isLoopback || iface.isTailscale).toBe(true)
    }
  })

  it('always allows loopback, even if enumeration finds nothing', () => {
    expect(isAllowedBindHost(REMOTE_DEFAULT_HOST)).toBe(true)
  })

  it('refuses the addresses that would widen the surface', () => {
    // `0.0.0.0` is not an interface address, so it can never enumerate — this
    // is the assertion that keeps it unreachable through every entry point.
    expect(isAllowedBindHost('0.0.0.0')).toBe(false)
    expect(isAllowedBindHost('::')).toBe(false)
    expect(isAllowedBindHost('192.168.1.10')).toBe(false)
    expect(isAllowedBindHost('')).toBe(false)
  })

  it('allows exactly what it offers', () => {
    for (const iface of listRemoteInterfaces()) {
      expect(isAllowedBindHost(iface.address)).toBe(true)
    }
  })
})
