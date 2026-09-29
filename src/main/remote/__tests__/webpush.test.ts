import { describe, it, expect } from 'vitest'
import { createVerify, createDecipheriv, createECDH, hkdfSync } from 'crypto'
import {
  audienceOf,
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  isGoneStatus,
  isValidVapidKeys,
  sendPush,
  toBase64Url,
  vapidAuthorization,
  vapidPublicKeyObject,
  type PushTransport,
} from '../webpush'

/**
 * The published worked example from RFC 8291 §5 and Appendix A.
 *
 * This is the only part of push notifications that can be verified without a
 * phone, an installed PWA and a live push service — and it is the part where a
 * mistake is invisible everywhere else: a wrong HKDF info string or a swapped
 * key order produces a body that is internally consistent, encrypts and
 * decrypts against itself, and that no browser on earth can read.
 *
 * Every value below is transcribed from the RFC, whitespace removed. Nothing
 * here was produced by running the code it tests.
 */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  sharedSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

function rfcEncrypted(): Buffer {
  return encryptPayload(Buffer.from(RFC8291.plaintext, 'utf8'), {
    keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
    salt: fromBase64Url(RFC8291.salt),
    senderKeys: {
      publicKey: fromBase64Url(RFC8291.asPublic),
      privateKey: fromBase64Url(RFC8291.asPrivate),
    },
  })
}

describe('encryptPayload — RFC 8291 §5 worked example', () => {
  it('produces the exact body the RFC publishes', () => {
    expect(toBase64Url(rfcEncrypted())).toBe(RFC8291.body)
  })

  it('produces the RFC 86-octet header and the RFC ciphertext', () => {
    const encrypted = rfcEncrypted()
    expect(toBase64Url(encrypted.subarray(0, 86))).toBe(RFC8291.header)
    expect(toBase64Url(encrypted.subarray(86))).toBe(RFC8291.ciphertext)
  })

  it('derives the RFC intermediate values', () => {
    // Recomputed here from the RFC's own inputs, so a change to the info
    // strings or the key order fails at the step that broke rather than only
    // at the end.
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(fromBase64Url(RFC8291.asPrivate))
    const shared = ecdh.computeSecret(fromBase64Url(RFC8291.uaPublic))
    expect(toBase64Url(shared)).toBe(RFC8291.sharedSecret)

    const keyInfo = Buffer.concat([
      Buffer.from('WebPush: info\0', 'utf8'),
      fromBase64Url(RFC8291.uaPublic),
      fromBase64Url(RFC8291.asPublic),
    ])
    const ikm = Buffer.from(hkdfSync('sha256', shared, fromBase64Url(RFC8291.authSecret), keyInfo, 32))
    expect(toBase64Url(ikm)).toBe(RFC8291.ikm)

    const salt = fromBase64Url(RFC8291.salt)
    expect(
      toBase64Url(Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))),
    ).toBe(RFC8291.cek)
    expect(
      toBase64Url(Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))),
    ).toBe(RFC8291.nonce)
  })

  it('is readable by the receiver, holding only ITS private key', () => {
    // What a browser actually does. The sender key comes out of the message,
    // not from the test's knowledge of it.
    const encrypted = rfcEncrypted()
    const salt = encrypted.subarray(0, 16)
    const asPublic = encrypted.subarray(21, 21 + 65)
    const ciphertext = encrypted.subarray(86)

    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(fromBase64Url(RFC8291.uaPrivate))
    const shared = ecdh.computeSecret(asPublic)
    const keyInfo = Buffer.concat([
      Buffer.from('WebPush: info\0', 'utf8'),
      ecdh.getPublicKey(),
      asPublic,
    ])
    const ikm = Buffer.from(hkdfSync('sha256', shared, fromBase64Url(RFC8291.authSecret), keyInfo, 32))
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

    const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
    const plain = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
      decipher.final(),
    ])
    expect(plain[plain.length - 1]).toBe(0x02)
    expect(plain.subarray(0, plain.length - 1).toString('utf8')).toBe(RFC8291.plaintext)
  })

  it('uses a fresh sender key and salt for every message', () => {
    const keys = { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret }
    const a = encryptPayload(Buffer.from('same'), { keys })
    const b = encryptPayload(Buffer.from('same'), { keys })
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false)
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false)
  })

  it('refuses a subscription key that is not an uncompressed P-256 point', () => {
    expect(() =>
      encryptPayload(Buffer.from('x'), { keys: { p256dh: toBase64Url(Buffer.alloc(64)), auth: RFC8291.authSecret } }),
    ).toThrow(/uncompressed P-256/)
  })
})

describe('VAPID', () => {
  const keys = generateVapidKeys()
  const endpoint = 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV?x=1'

  it('generates a self-consistent P-256 pair', () => {
    expect(isValidVapidKeys(keys)).toBe(true)
    expect(fromBase64Url(keys.publicKey)).toHaveLength(65)
    expect(fromBase64Url(keys.privateKey)).toHaveLength(32)
  })

  it('rejects a pair whose halves do not belong together', () => {
    expect(isValidVapidKeys({ publicKey: keys.publicKey, privateKey: generateVapidKeys().privateKey })).toBe(false)
    expect(isValidVapidKeys({ publicKey: 'not-a-key', privateKey: keys.privateKey })).toBe(false)
  })

  it('signs a JWT the matching public key verifies', () => {
    const header = vapidAuthorization(endpoint, { keys, subject: 'mailto:dev@example.com', now: () => 1_700_000_000_000 })
    const [, token] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? []
    const [encodedHeader, encodedClaims, signature] = token.split('.')

    const verifier = createVerify('sha256')
    verifier.update(`${encodedHeader}.${encodedClaims}`)
    expect(
      verifier.verify(
        { key: vapidPublicKeyObject(keys.publicKey), dsaEncoding: 'ieee-p1363' },
        fromBase64Url(signature),
      ),
    ).toBe(true)
  })

  it('advertises the same public key the browser subscribed with', () => {
    const header = vapidAuthorization(endpoint, { keys, subject: 'mailto:dev@example.com' })
    expect(header.endsWith(`, k=${keys.publicKey}`)).toBe(true)
  })

  it('audiences the ORIGIN, never the full endpoint', () => {
    const header = vapidAuthorization(endpoint, { keys, subject: 'mailto:dev@example.com' })
    const claims = JSON.parse(
      fromBase64Url(header.slice('vapid t='.length).split(',')[0].split('.')[1]).toString('utf8'),
    ) as { aud: string; sub: string; exp: number }
    expect(claims.aud).toBe('https://push.example.net')
    expect(claims.sub).toBe('mailto:dev@example.com')
    expect(audienceOf(endpoint)).toBe('https://push.example.net')
  })

  it('never issues a JWT valid for more than 24 hours', () => {
    const now = 1_700_000_000_000
    const header = vapidAuthorization(endpoint, {
      keys,
      subject: 'mailto:dev@example.com',
      expiresInSeconds: 60 * 60 * 24 * 30,
      now: () => now,
    })
    const claims = JSON.parse(
      fromBase64Url(header.slice('vapid t='.length).split(',')[0].split('.')[1]).toString('utf8'),
    ) as { exp: number }
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(60 * 60 * 24)
  })
})

describe('sendPush', () => {
  const keys = generateVapidKeys()
  const target = {
    endpoint: 'https://push.example.net/push/abc',
    keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
  }

  function capturing(status: number): { transport: PushTransport; calls: { url: string; headers: Record<string, string>; body: Buffer }[] } {
    const calls: { url: string; headers: Record<string, string>; body: Buffer }[] = []
    return {
      calls,
      transport: (url, headers, body) => {
        calls.push({ url, headers, body })
        return Promise.resolve({ status })
      },
    }
  }

  it('posts an encrypted aes128gcm body with a VAPID header', async () => {
    const { transport, calls } = capturing(201)
    const result = await sendPush(target, JSON.stringify({ title: 'hi' }), {
      vapid: { keys, subject: 'mailto:dev@example.com' },
      transport,
    })
    expect(result).toEqual({ status: 201, error: null })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(target.endpoint)
    expect(calls[0].headers['content-encoding']).toBe('aes128gcm')
    expect(calls[0].headers.urgency).toBe('high')
    expect(calls[0].headers.authorization).toMatch(/^vapid t=.+, k=.+$/)
    // The payload must not be recoverable from the wire without the keys.
    expect(calls[0].body.includes(Buffer.from('title'))).toBe(false)
  })

  it('reports a rejection as a status rather than throwing', async () => {
    const { transport } = capturing(410)
    const result = await sendPush(target, '{}', { vapid: { keys, subject: 'mailto:dev@example.com' }, transport })
    expect(result.status).toBe(410)
    expect(result.error).toMatch(/410/)
  })

  it('survives a transport that throws', async () => {
    const result = await sendPush(target, '{}', {
      vapid: { keys, subject: 'mailto:dev@example.com' },
      transport: () => Promise.reject(new Error('ECONNRESET')),
    })
    expect(result).toEqual({ status: null, error: 'ECONNRESET' })
  })

  it('treats only 404 and 410 as a dead endpoint', () => {
    expect(isGoneStatus(404)).toBe(true)
    expect(isGoneStatus(410)).toBe(true)
    for (const status of [200, 201, 400, 401, 403, 429, 500, 502, null]) {
      expect(isGoneStatus(status)).toBe(false)
    }
  })
})
