import { describe, it, expect } from 'vitest'
import { isTailscaleAddress } from '../interfaces'

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
