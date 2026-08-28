import { describe, it, expect } from 'vitest'
import { pairingTarget, isPhoneReachable } from '../remote-pairing'

const TOKEN_PATH = '/9f3c0a7e5b1d4826aa11cc22dd33ee44ff5566778899aabbccddeeff00112233/'

describe('isPhoneReachable', () => {
  it('rejects every spelling of this machine', () => {
    expect(isPhoneReachable(`http://127.0.0.1:5173${TOKEN_PATH}`)).toBe(false)
    expect(isPhoneReachable(`http://localhost:5173${TOKEN_PATH}`)).toBe(false)
    expect(isPhoneReachable(`http://[::1]:5173${TOKEN_PATH}`)).toBe(false)
    expect(isPhoneReachable(`http://0.0.0.0:5173${TOKEN_PATH}`)).toBe(false)
  })

  it('is not fooled by a hostname that merely contains a loopback address', () => {
    expect(isPhoneReachable(`http://127.0.0.1.example.test:5173${TOKEN_PATH}`)).toBe(true)
  })

  it('treats an unparseable URL as unreachable', () => {
    expect(isPhoneReachable('not a url')).toBe(false)
  })
})

describe('pairingTarget', () => {
  it('offers nothing while the server is stopped', () => {
    expect(
      pairingTarget({ running: false, directUrl: null, boundToTailscale: false, serveUrl: null }),
    ).toEqual({ url: null, secure: false, note: null })
  })

  it('never offers a loopback URL, even when the caller claims it is on the tailnet', () => {
    const result = pairingTarget({
      running: true,
      directUrl: `http://127.0.0.1:5173${TOKEN_PATH}`,
      boundToTailscale: true,
      serveUrl: null,
    })
    expect(result.url).toBeNull()
  })

  it('ignores a serve URL that points at this machine', () => {
    const result = pairingTarget({
      running: true,
      directUrl: null,
      boundToTailscale: false,
      serveUrl: `https://localhost${TOKEN_PATH}`,
    })
    expect(result.url).toBeNull()
  })

  it('prefers the HTTPS serve URL and marks it secure', () => {
    const serveUrl = `https://mac.tail050858.ts.net${TOKEN_PATH}`
    const result = pairingTarget({
      running: true,
      directUrl: `http://100.109.247.56:5173${TOKEN_PATH}`,
      boundToTailscale: true,
      serveUrl,
    })
    expect(result).toEqual({ url: serveUrl, secure: true, note: null })
  })

  it('falls back to the tailnet address, flagged as not a secure context', () => {
    const directUrl = `http://100.109.247.56:5173${TOKEN_PATH}`
    const result = pairingTarget({
      running: true,
      directUrl,
      boundToTailscale: true,
      serveUrl: null,
    })
    expect(result.url).toBe(directUrl)
    expect(result.secure).toBe(false)
    expect(result.note).toMatch(/secure context/)
  })

  it('explains a loopback bind rather than showing a code that cannot work', () => {
    const result = pairingTarget({
      running: true,
      directUrl: `http://127.0.0.1:5173${TOKEN_PATH}`,
      boundToTailscale: false,
      serveUrl: null,
    })
    expect(result.url).toBeNull()
    expect(result.note).toMatch(/bound to this Mac only/i)
  })
})
