/**
 * Which URL, if any, is worth putting on a phone's camera.
 *
 * A QR encodes a live bearer token, so the wrong one is not merely useless —
 * it is misleading in a way that costs the user a walk to their desk. Two
 * properties are ENFORCED here rather than promised in the pane's copy:
 *
 *  - **Never loopback.** `http://127.0.0.1:<port>/app/?k=<key>` scans perfectly
 *    and resolves, on the phone, to the phone. The check is on the URL's own
 *    host, not on a flag the caller passed, because the flag is the thing most
 *    likely to be wrong.
 *  - **Nothing when remote access is off.** No server, no token, no code.
 *
 * The preference order is the provider's HTTPS tunnel first: `getUserMedia` needs a
 * secure context, so dictation only exists on that URL.
 */
import type { RemoteExposure } from './ipc-types'

/** How the pane and the pairing notes name each exposure. */
export const EXPOSURE_LABELS: Record<RemoteExposure, string> = {
  off: 'Off',
  'tailscale-serve': 'Tailscale Serve',
  opentunnel: 'OpenTunnel',
}

/** Where the shell lives. Fixed, so an installed app's scope survives a restart. */
export const APP_PATH = '/app/'

/** The link a phone scans, and the start URL an install keeps. */
export function appLink(origin: string, key: string): string {
  return `${origin}${APP_PATH}?k=${key}`
}

/**
 * The same link with the key taken out — where a notification tap lands.
 *
 * The installed app already holds its key, and a push is shown, stored and
 * listed by the OS; the bearer credential has no business riding along in it.
 */
export function withoutKey(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.delete('k')
  return parsed.toString()
}

export interface PairingInput {
  /** The chosen reachability provider, so a note can name it. */
  exposure: RemoteExposure
  /** Is the server listening right now? */
  running: boolean
  /** The URL the server is bound to, key included. Null when stopped. */
  directUrl: string | null
  /** True when the bound address belongs to the Tailscale interface. */
  boundToTailscale: boolean
  /** The URL the active reachability provider publishes, key included, when active. */
  tunnelUrl: string | null
}

export interface PairingTarget {
  /** What to encode, or null when nothing here is scannable. */
  url: string | null
  /** An HTTPS origin — the only kind where the microphone will open. */
  secure: boolean
  /** Why there is no code, or the caveat on the one there is. */
  note: string | null
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/**
 * Is this URL one a *different* device could reach?
 *
 * Parsed, not pattern-matched: `http://127.0.0.1:5173/x/` and
 * `http://127.0.0.1.evil.test/` differ only in a place a substring test misses.
 * An unparseable URL is treated as unreachable — refusing to show a code is
 * always the safe answer.
 */
export function isPhoneReachable(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return !LOOPBACK_HOSTS.has(parsed.hostname)
}

export function pairingTarget(input: PairingInput): PairingTarget {
  if (!input.running) {
    return { url: null, secure: false, note: null }
  }
  if (input.tunnelUrl && isPhoneReachable(input.tunnelUrl)) {
    return { url: input.tunnelUrl, secure: input.tunnelUrl.startsWith('https://'), note: null }
  }
  if (input.directUrl && input.boundToTailscale && isPhoneReachable(input.directUrl)) {
    return {
      url: input.directUrl,
      secure: false,
      note:
        'This is plain HTTP over the tailnet. It works, but a browser will not call it a secure context, so dictation stays unavailable. For an HTTPS address, switch the bind to “This Mac only” and turn on Tailscale Serve: Serve proxies from this Mac, so loopback is the bind it needs.',
    }
  }
  if (input.exposure !== 'off' && !input.boundToTailscale) {
    return {
      url: null,
      secure: false,
      note: `${EXPOSURE_LABELS[input.exposure]} has not published an address yet. Its status is shown above.`,
    }
  }
  return {
    url: null,
    secure: false,
    note: input.boundToTailscale
      ? 'There is no address a phone can reach yet.'
      : 'Remote access is bound to this Mac only, so there is nothing for a phone to scan yet. Choose Tailscale Serve or OpenTunnel above to publish it at an HTTPS address — both proxy from this Mac, so this is the bind they want. To reach a phone without either, pick the Tailscale address above instead; that link is plain HTTP, so dictation will not work over it.',
  }
}
