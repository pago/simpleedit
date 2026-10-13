import { describe, it, expect } from 'vitest'
import { pairingTarget, isPhoneReachable, appLink, withoutKey } from '../remote-pairing'

const TOKEN_PATH = '/app/?k=9f3c0a7e5b1d4826aa11cc22dd33ee44ff5566778899aabbccddeeff00112233'

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
      pairingTarget({ exposure: 'off', running: false, directUrl: null, boundToTailscale: false, tunnelUrl: null }),
    ).toEqual({ url: null, secure: false, note: null })
  })

  it('never offers a loopback URL, even when the caller claims it is on the tailnet', () => {
    const result = pairingTarget({
      exposure: 'off',
      running: true,
      directUrl: `http://127.0.0.1:5173${TOKEN_PATH}`,
      boundToTailscale: true,
      tunnelUrl: null,
    })
    expect(result.url).toBeNull()
  })

  it('ignores a serve URL that points at this machine', () => {
    const result = pairingTarget({
      exposure: 'off',
      running: true,
      directUrl: null,
      boundToTailscale: false,
      tunnelUrl: `https://localhost${TOKEN_PATH}`,
    })
    expect(result.url).toBeNull()
  })

  it('prefers the HTTPS serve URL and marks it secure', () => {
    const tunnelUrl = `https://mac.tail050858.ts.net${TOKEN_PATH}`
    const result = pairingTarget({
      exposure: 'off',
      running: true,
      directUrl: `http://100.109.247.56:5173${TOKEN_PATH}`,
      boundToTailscale: true,
      tunnelUrl,
    })
    expect(result).toEqual({ url: tunnelUrl, secure: true, note: null })
  })

  it('falls back to the tailnet address, flagged as not a secure context', () => {
    const directUrl = `http://100.109.247.56:5173${TOKEN_PATH}`
    const result = pairingTarget({
      exposure: 'off',
      running: true,
      directUrl,
      boundToTailscale: true,
      tunnelUrl: null,
    })
    expect(result.url).toBe(directUrl)
    expect(result.secure).toBe(false)
    expect(result.note).toMatch(/secure context/)
  })

  it('explains a loopback bind rather than showing a code that cannot work', () => {
    const result = pairingTarget({
      exposure: 'off',
      running: true,
      directUrl: `http://127.0.0.1:5173${TOKEN_PATH}`,
      boundToTailscale: false,
      tunnelUrl: null,
    })
    expect(result.url).toBeNull()
    expect(result.note).toMatch(/bound to this Mac only/i)
  })

  it('does not tell the user to do the one thing that makes Serve refuse', () => {
    // Serve proxies from this Mac and main refuses the opt-in on a non-loopback
    // bind, so "pick the Tailscale address AND turn on Serve" is an instruction
    // that cannot succeed. Serve is offered on the bind it actually wants; the
    // Tailscale address is offered as the alternative to Serve, not a step
    // toward it.
    const loopback = pairingTarget({
      exposure: 'off',
      running: true,
      directUrl: `http://127.0.0.1:5173${TOKEN_PATH}`,
      boundToTailscale: false,
      tunnelUrl: null,
    }).note
    expect(loopback).toMatch(/Choose Tailscale Serve or OpenTunnel above/)
    expect(loopback).toMatch(/without either, pick the Tailscale address/)

    const overTailnet = pairingTarget({
      exposure: 'off',
      running: true,
      directUrl: `http://100.109.247.56:5173${TOKEN_PATH}`,
      boundToTailscale: true,
      tunnelUrl: null,
    }).note
    expect(overTailnet).toMatch(/switch the bind to .This Mac only. and turn on Tailscale Serve/)
  })
})

describe('pairingTarget while a provider is still publishing', () => {
  it('names the chosen provider instead of telling the user to choose one', () => {
    const result = pairingTarget({
      exposure: 'opentunnel',
      running: true,
      directUrl: `http://127.0.0.1:5173${TOKEN_PATH}`,
      boundToTailscale: false,
      tunnelUrl: null,
    })
    expect(result.url).toBeNull()
    expect(result.note).toBe('OpenTunnel has not published an address yet. Its status is shown above.')
  })

  it('encodes the OpenTunnel URL once there is one', () => {
    const tunnelUrl = `https://46a58ed880bbfb4a.shmeg77if6cw.opentunnel.xyz${TOKEN_PATH}`
    const result = pairingTarget({
      exposure: 'opentunnel',
      running: true,
      directUrl: `http://127.0.0.1:5173${TOKEN_PATH}`,
      boundToTailscale: false,
      tunnelUrl,
    })
    expect(result).toEqual({ url: tunnelUrl, secure: true, note: null })
  })
})

describe('appLink / withoutKey', () => {
  const KEY = 'c'.repeat(64)

  it('puts the key in the query of the fixed shell path', () => {
    expect(appLink('https://mac.tailnet.ts.net', KEY)).toBe(`https://mac.tailnet.ts.net/app/?k=${KEY}`)
  })

  // Where a notification tap lands: the installed app holds its own key, and
  // a notification is stored by the OS long after this start's key is dead.
  it('takes the key out of a link and keeps everything else', () => {
    expect(withoutKey(appLink('https://mac.tailnet.ts.net', KEY))).toBe('https://mac.tailnet.ts.net/app/')
    expect(withoutKey(`http://100.1.2.3:5173/app/?k=${KEY}&x=1`)).toBe('http://100.1.2.3:5173/app/?x=1')
  })
})
