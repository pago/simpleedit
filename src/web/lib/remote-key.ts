/**
 * The access key, as this device holds it.
 *
 * The key is minted per server start and is not part of the page's path, so
 * the app has to keep it itself — and keep it in ITS OWN storage. On
 * iOS a Home Screen app's storage is isolated from Safari's even on the same
 * origin, which is why a rescan has to happen inside the app (`PairScreen`)
 * rather than through the Camera, which opens Safari.
 *
 * Two sources, and which one wins:
 *
 *  - **The page URL's `?k=`.** A freshly scanned link opened in Safari, or an
 *    installed app's start URL — which iOS fixed at install and repeats on
 *    every launch, long after that key went stale.
 *  - **A rescan inside the app**, which must beat that repeating start URL.
 *
 * A URL key is considered only when it differs from the last URL key seen. A
 * start URL replaying itself is the same key every time, so it is considered
 * once and then ignored. And it replaces a key the device already holds only
 * once the Mac confirms it is current (`settleUrlKey`): an old bookmark, or a
 * link someone sent to knock this device off, must not overwrite a working
 * key. With nothing stored there is nothing to lose, so it is taken at once.
 */
import { APP_PATH } from '../../shared/remote-pairing'

const KEY_SHAPE = /^[0-9a-f]{64}$/

const STORED = 'simpleedit.remote.key'
const LAST_URL_KEY = 'simpleedit.remote.url-key'

export function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_SHAPE.test(value)
}

/** Storage can throw (private mode, a full quota). The app must still start. */
function read(storage: Storage, name: string): string | null {
  try {
    return storage.getItem(name)
  } catch {
    return null
  }
}

function write(storage: Storage, name: string, value: string): void {
  try {
    storage.setItem(name, value)
  } catch {
    /* held in memory for this page's life by the caller */
  }
}

export interface KeyChoice {
  /** What to connect with now. */
  key: string | null
  /** A new URL key that may replace `key`, once the Mac says it is current. */
  candidate: string | null
}

/** The key to connect with, after reconciling the page URL against storage. */
export function resolveKey(search: string, storage: Storage = localStorage): KeyChoice {
  const fromUrl = new URLSearchParams(search).get('k')
  const stored = read(storage, STORED)
  const held = isKey(stored) ? stored : null
  const fresh = isKey(fromUrl) && fromUrl !== read(storage, LAST_URL_KEY) && fromUrl !== held ? fromUrl : null
  if (fresh && !held) {
    adoptUrlKey(fresh, storage)
    return { key: fresh, candidate: null }
  }
  if (held) return { key: held, candidate: fresh }
  // Storage refused us: the URL is all there is.
  return { key: isKey(fromUrl) ? fromUrl : null, candidate: null }
}

function adoptUrlKey(key: string, storage: Storage): void {
  write(storage, LAST_URL_KEY, key)
  write(storage, STORED, key)
}

/**
 * Decide a URL key that would replace a stored one. Current: it is adopted
 * and `onAdopt` reconnects with it. Refused: it is remembered as seen, so the
 * same link is not asked about again. No answer: left for the next launch.
 */
export async function settleUrlKey(
  candidate: string,
  check: (key: string) => Promise<'current' | 'stale' | 'unknown'>,
  onAdopt: (key: string) => void,
  storage: Storage = localStorage,
): Promise<void> {
  const verdict = await check(candidate).catch(() => 'unknown' as const)
  if (verdict === 'current') {
    adoptUrlKey(candidate, storage)
    onAdopt(candidate)
  } else if (verdict === 'stale') {
    write(storage, LAST_URL_KEY, candidate)
  }
}

/** A key from an in-app scan or paste. Outranks the start URL from here on. */
export function storeKey(key: string, storage: Storage = localStorage): void {
  write(storage, STORED, key)
}

export type PairingLink =
  | { ok: true; key: string }
  | { ok: false; reason: 'not-a-link' | 'no-key' | 'other-address'; origin?: string }

/**
 * Read a scanned or pasted pairing link, accepting only one for THIS origin.
 *
 * Another origin is refused rather than followed. Navigating there leaves the
 * installed app's scope (iOS opens an in-app browser), and that origin has its
 * own storage and its own push subscription — nothing learned there would
 * reach this app. The user is told which address the code was for instead.
 */
export function parsePairingLink(text: string, origin: string): PairingLink {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return { ok: false, reason: 'not-a-link' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'not-a-link' }
  if (url.origin !== origin) return { ok: false, reason: 'other-address', origin: url.origin }
  const key = url.searchParams.get('k')
  if (!url.pathname.startsWith(APP_PATH) || !isKey(key)) return { ok: false, reason: 'no-key' }
  return { ok: true, key }
}

export function pairingProblem(link: Exclude<PairingLink, { ok: true }>): string {
  switch (link.reason) {
    case 'other-address':
      return `That code is for ${link.origin}, not this address. Open SimpleEdit there instead, or switch the Mac back to this one.`
    case 'no-key':
      return 'That link has no access key in it. Scan the code under Settings → Remote access on the Mac.'
    default:
      return 'That is not a SimpleEdit link.'
  }
}
