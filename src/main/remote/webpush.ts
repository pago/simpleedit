/**
 * Web Push, from the two RFCs, using nothing but Node's crypto.
 *
 * ── Why no library ────────────────────────────────────────────────────────
 * `electron.vite.config.ts` bundles main's dependencies rather than shipping
 * `node_modules`, so every runtime dependency has to survive Rollup. The
 * protocol here is two RFCs' worth of HKDF and one AES-GCM call, and — the
 * deciding point — it is exactly verifiable offline: RFC 8291 publishes a
 * complete worked example with fixed keys and every intermediate value, so
 * `webpush.test.ts` checks this file against the specification itself rather
 * than against its own idea of the specification. That is stronger evidence
 * than "a popular package does it", and it is the only part of this feature
 * that can be proved without a phone.
 *
 * ── What the push service can see ─────────────────────────────────────────
 * The body is encrypted end to end (RFC 8291): Apple, Google or Mozilla relay
 * it without being able to read it. What they DO see is the endpoint, the
 * message size and the timing. So the payload may carry a session label and
 * the URL to open, and must never be padded up to a size that leaks nothing —
 * it already leaks approximately nothing.
 *
 * The VAPID JWT (RFC 8292) is the opposite: it is READ by the push service to
 * identify us, so it carries only an audience, an expiry and a contact.
 */
import {
  constants,
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'crypto'
import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'

const CURVE = 'prime256v1'
/** An uncompressed P-256 point: 0x04 || X(32) || Y(32). */
const P256_POINT_BYTES = 65
/** RFC 8188's record size. One record is all we ever send. */
const RECORD_SIZE = 4096
/** The `aes128gcm` key id field is our public key, so its length is fixed. */
const KEY_ID_LENGTH = P256_POINT_BYTES

export function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

/** A subscription exactly as `PushSubscription.toJSON()` produces it. */
export interface PushKeys {
  /** The user agent's public key, uncompressed P-256, base64url. */
  p256dh: string
  /** The 16-byte shared authentication secret, base64url. */
  auth: string
}

export interface VapidKeyPair {
  /** Uncompressed P-256 public key, base64url. Handed to the browser. */
  publicKey: string
  /** The raw 32-byte private scalar, base64url. NEVER leaves the main process. */
  privateKey: string
}

/**
 * A P-256 key pair in the shape both RFCs use: raw points, base64url.
 *
 * Deliberately not PEM. The public half has to reach `pushManager.subscribe`
 * as an uncompressed point either way, and keeping both halves in one
 * representation removes a conversion that would otherwise only be exercised
 * on the day a key is rotated.
 */
export function generateVapidKeys(): VapidKeyPair {
  const ecdh = createECDH(CURVE)
  ecdh.generateKeys()
  return {
    publicKey: toBase64Url(ecdh.getPublicKey()),
    privateKey: toBase64Url(ecdh.getPrivateKey()),
  }
}

/** True when `keys` is a structurally valid P-256 pair. Cheap, and load-bearing. */
export function isValidVapidKeys(keys: VapidKeyPair): boolean {
  try {
    const publicKey = fromBase64Url(keys.publicKey)
    const privateKey = fromBase64Url(keys.privateKey)
    if (publicKey.length !== P256_POINT_BYTES || publicKey[0] !== 0x04) return false
    if (privateKey.length !== 32) return false
    // The only check that matters: does the private scalar actually produce
    // this point? A mismatched pair would produce JWTs the push service
    // rejects with a 403 that says nothing about why.
    const ecdh = createECDH(CURVE)
    ecdh.setPrivateKey(privateKey)
    return ecdh.getPublicKey().equals(publicKey)
  } catch {
    return false
  }
}

/**
 * Rebuild a signing key from the raw scalar.
 *
 * Via JWK, because that is the one import format that takes the coordinates
 * directly — the alternative is hand-assembling SEC1 DER, which is a second
 * encoder to get wrong.
 */
function signingKey(keys: VapidKeyPair): KeyObject {
  const point = fromBase64Url(keys.publicKey)
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
    },
  })
}

/** The verifying half of `signingKey`. Exported so tests can check a JWT for real. */
export function vapidPublicKeyObject(publicKey: string): KeyObject {
  const point = fromBase64Url(publicKey)
  return createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
    },
  })
}

/** `https://updates.push.services.mozilla.com/wpush/v2/gAAA…` → its origin. */
export function audienceOf(endpoint: string): string {
  return new URL(endpoint).origin
}

export interface VapidOptions {
  keys: VapidKeyPair
  /** A `mailto:` or `https:` contact, per RFC 8292 §2.1. */
  subject: string
  /** Seconds from now. RFC 8292 caps this at 24 hours; push services enforce it. */
  expiresInSeconds?: number
  /** Injectable so a test's JWT is not a moving target. */
  now?: () => number
}

const MAX_JWT_LIFETIME_SECONDS = 22 * 60 * 60

/**
 * The `Authorization` header for one endpoint, per RFC 8292 §3 ("vapid" scheme).
 *
 * The audience is the endpoint's ORIGIN, not the endpoint — a JWT scoped to
 * the full URL is rejected, and the difference is invisible until a real push
 * service sees it.
 */
export function vapidAuthorization(endpoint: string, options: VapidOptions): string {
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000)
  const lifetime = Math.min(options.expiresInSeconds ?? MAX_JWT_LIFETIME_SECONDS, MAX_JWT_LIFETIME_SECONDS)
  const header = toBase64Url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'))
  const claims = toBase64Url(
    Buffer.from(
      JSON.stringify({ aud: audienceOf(endpoint), exp: now + lifetime, sub: options.subject }),
      'utf8',
    ),
  )
  const signingInput = Buffer.from(`${header}.${claims}`, 'utf8')
  // `ieee-p1363` is the raw r||s pair JWS wants. Node's default is DER, which
  // every push service rejects — and rejects with a bare 401.
  const signature = sign('sha256', signingInput, {
    key: signingKey(options.keys),
    dsaEncoding: 'ieee-p1363',
  })
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${options.keys.publicKey}`
}

export interface EncryptOptions {
  /** The subscription's keys, straight from `PushSubscription.toJSON()`. */
  keys: PushKeys
  /** Random per message. Overridable ONLY so the RFC's example can be reproduced. */
  salt?: Buffer
  /** Ephemeral sender key pair. Overridable for the same reason. */
  senderKeys?: { publicKey: Buffer; privateKey: Buffer }
}

/**
 * Encrypt one push message body — RFC 8291 over RFC 8188's `aes128gcm`.
 *
 * The sender key pair is ephemeral BY DESIGN: it is generated per message and
 * thrown away, which is what stops a push service correlating two messages to
 * the same subscription beyond what the endpoint already tells it. Passing one
 * in is a test affordance, never a caller's choice.
 */
export function encryptPayload(plaintext: Buffer, options: EncryptOptions): Buffer {
  const uaPublic = fromBase64Url(options.keys.p256dh)
  const authSecret = fromBase64Url(options.keys.auth)
  if (uaPublic.length !== P256_POINT_BYTES || uaPublic[0] !== 0x04) {
    throw new Error('Subscription key is not an uncompressed P-256 point')
  }

  const ecdh = createECDH(CURVE)
  if (options.senderKeys) ecdh.setPrivateKey(options.senderKeys.privateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const salt = options.salt ?? randomBytes(16)

  const sharedSecret = ecdh.computeSecret(uaPublic)

  // RFC 8291 §3.3: the auth secret is the HKDF salt, and the info binds both
  // public keys, in the order receiver-then-sender. Swapping them produces a
  // key that is perfectly self-consistent and that no browser can derive.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    asPublic,
  ])
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32))

  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 is RFC 8188's LAST-record delimiter. 0x01 says "another record
  // follows", and a receiver that believes it waits for a record that never
  // comes — a message that silently never fires, which is the failure this
  // whole feature is trying not to have.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])])
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(KEY_ID_LENGTH, 20)

  return Buffer.concat([header, asPublic, ciphertext])
}

export interface PushTarget {
  endpoint: string
  keys: PushKeys
}

export interface PushResult {
  /** The push service's HTTP status, or null when the request never completed. */
  status: number | null
  error: string | null
}

/**
 * A dead subscription, as the push service reports one.
 *
 * 404 and 410 are the two the spec assigns to "this endpoint is gone"
 * (RFC 8030 §7.3). Everything else — a 429, a 502, a timeout — is transient
 * and must NOT prune, or one bad afternoon at Apple silently unsubscribes
 * every device the user owns.
 */
export function isGoneStatus(status: number | null): boolean {
  return status === 404 || status === 410
}

/** Injectable transport, so tests never touch the network. */
export type PushTransport = (
  url: string,
  headers: Record<string, string>,
  body: Buffer,
) => Promise<{ status: number }>

const REQUEST_TIMEOUT_MS = 10_000

const defaultTransport: PushTransport = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const send = parsed.protocol === 'http:' ? httpRequest : httpsRequest
    const req = send(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: { ...headers, 'content-length': String(body.length) },
        // The default already refuses an unknown CA; naming it is what keeps a
        // later "just make it work" edit from being a one-word change.
        secureOptions: constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        // The body is never useful and can be large; draining without reading
        // is what frees the socket.
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      },
    )
    req.on('timeout', () => req.destroy(new Error('Push request timed out')))
    req.on('error', reject)
    req.end(body)
  })

export interface SendPushOptions {
  vapid: VapidOptions
  /** Seconds the push service may hold an undelivered message. */
  ttlSeconds?: number
  transport?: PushTransport
}

/**
 * Encrypt and POST one message. Never throws for a rejection — the caller
 * needs the status to decide between pruning and retrying, and an exception
 * would collapse those two into one.
 */
export async function sendPush(
  target: PushTarget,
  payload: string,
  options: SendPushOptions,
): Promise<PushResult> {
  let body: Buffer
  try {
    body = encryptPayload(Buffer.from(payload, 'utf8'), { keys: target.keys })
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) }
  }
  const headers: Record<string, string> = {
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(options.ttlSeconds ?? 60),
    // "high" is what makes a phone wake for it. The whole feature is a buzz on
    // a treadmill; a low-urgency push is one the OS may batch until morning.
    urgency: 'high',
    authorization: vapidAuthorization(target.endpoint, options.vapid),
  }
  try {
    const { status } = await (options.transport ?? defaultTransport)(target.endpoint, headers, body)
    return { status, error: status >= 200 && status < 300 ? null : `Push service returned ${status}` }
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) }
  }
}
